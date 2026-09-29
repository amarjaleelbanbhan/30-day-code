"use client";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

// A drawing block that lives inside the note, between paragraphs: handwriting, highlighter, shapes, arrows, text.
// Strokes are vector data stored in the note JSON (so they're versioned, synced and restorable with the note).

export type Tool = "select" | "pen" | "hl" | "eraser" | "line" | "arrow" | "rect" | "ellipse" | "text";
export type Shape = { id: string; t: Exclude<Tool, "select" | "eraser">; c: string; w: number; p: number[]; s?: string };

const W = 800; // logical width; the SVG scales to the page width
const COLORS = ["currentColor", "#d1453b", "#2f6fdb", "#2e9d5b", "#e0a800"];
const WIDTHS = [2, 4, 8];
const uid = () => Math.random().toString(36).slice(2, 10);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sketch: { insertSketch: () => ReturnType };
  }
}

export const Sketch = Node.create({
  name: "sketch",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      shapes: { default: [] as Shape[] },
      height: { default: 360 },
      caption: { default: "" },
    };
  },
  parseHTML: () => [{ tag: "div[data-sketch]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes({ "data-sketch": "" }, { "data-caption": HTMLAttributes.caption })],
  addNodeView: () => ReactNodeViewRenderer(SketchView),
  addCommands() {
    return {
      insertSketch: () => ({ chain }) => chain().insertContent([{ type: this.name, attrs: { shapes: [], height: 360 } }, { type: "paragraph" }]).run(),
    };
  },
});

function pathFor(p: number[]): string {
  if (p.length < 4) return p.length === 2 ? `M${p[0]} ${p[1]}l0.01 0` : "";
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i]! + p[i + 2]!) / 2, my = (p[i + 1]! + p[i + 3]!) / 2;
    d += `Q${p[i]} ${p[i + 1]} ${mx} ${my}`;
  }
  return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
}

const ShapeEl = memo(function ShapeEl({ s, selected }: { s: Shape; selected?: boolean }) {
  const common = { stroke: s.c, strokeWidth: s.w, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = s.p;
  const sel = selected ? { filter: "drop-shadow(0 0 2px var(--accent))" } : undefined;
  switch (s.t) {
    case "pen": return <path d={pathFor(s.p)} {...common} style={sel} />;
    case "hl": return <path d={pathFor(s.p)} {...common} strokeWidth={s.w * 4} strokeOpacity={0.35} strokeLinecap="butt" style={sel} />;
    case "line": return <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} style={sel} />;
    case "arrow": {
      const a = Math.atan2(y2 - y1, x2 - x1), L = 10 + s.w * 2;
      const h = (d: number) => `${x2 - L * Math.cos(a + d)} ${y2 - L * Math.sin(a + d)}`;
      return <g style={sel}><line x1={x1} y1={y1} x2={x2} y2={y2} {...common} /><path d={`M${h(0.45)}L${x2} ${y2}L${h(-0.45)}`} {...common} /></g>;
    }
    case "rect": return <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} rx={4} {...common} style={sel} />;
    case "ellipse": return <ellipse cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} rx={Math.abs(x2 - x1) / 2} ry={Math.abs(y2 - y1) / 2} {...common} style={sel} />;
    case "text": return <text x={x1} y={y1} fill={s.c} fontSize={12 + s.w * 3} dominantBaseline="hanging" style={{ ...sel, fontFamily: "inherit" }}>{s.s}</text>;
  }
});

function bbox(s: Shape): [number, number, number, number] {
  if (s.t === "text") { const size = 12 + s.w * 3; return [s.p[0]!, s.p[1]!, s.p[0]! + (s.s?.length ?? 1) * size * 0.55, s.p[1]! + size]; }
  const xs = s.p.filter((_, i) => i % 2 === 0), ys = s.p.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTest(s: Shape, x: number, y: number, tol: number): boolean {
  const [a, b, c, d] = bbox(s);
  if (x < a - tol - s.w || x > c + tol + s.w || y < b - tol - s.w || y > d + tol + s.w) return false;
  const pad = tol + (s.t === "hl" ? s.w * 2 : s.w / 2);
  if (s.t === "pen" || s.t === "hl") {
    for (let i = 0; i < s.p.length - 2; i += 2) if (distToSeg(x, y, s.p[i]!, s.p[i + 1]!, s.p[i + 2]!, s.p[i + 3]!) <= pad) return true;
    return s.p.length === 2 && Math.hypot(x - s.p[0]!, y - s.p[1]!) <= pad;
  }
  if (s.t === "line" || s.t === "arrow") return distToSeg(x, y, s.p[0]!, s.p[1]!, s.p[2]!, s.p[3]!) <= pad;
  if (s.t === "text") return true;
  if (s.t === "rect") { const edges = [[a, b, c, b], [c, b, c, d], [c, d, a, d], [a, d, a, b]] as const; return edges.some((e) => distToSeg(x, y, ...e) <= pad); }
  const cx = (a + c) / 2, cy = (b + d) / 2, rx = (c - a) / 2 || 1, ry = (d - b) / 2 || 1;
  return Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <= pad;
}

function SketchView({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const saved = node.attrs.shapes as Shape[];
  const height = node.attrs.height as number;
  const [active, setActive] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(WIDTHS[0]!);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<number[] | null>(null);
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const undo = useRef<Shape[][]>([]);
  const redo = useRef<Shape[][]>([]);
  const gesture = useRef<{ kind: "draw" | "move" | "marquee" | "erase"; start: [number, number]; base?: Shape[]; erased?: boolean } | null>(null);
  const penSeen = useRef(false);

  const commit = useCallback((next: Shape[]) => {
    undo.current.push(saved);
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    updateAttributes({ shapes: next });
  }, [saved, updateAttributes]);

  const pt = (e: React.PointerEvent | PointerEvent): [number, number] => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const k = W / r.width;
    return [Math.round((e.clientX - r.left) * k * 10) / 10, Math.round((e.clientY - r.top) * k * 10) / 10];
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!active || !editor.isEditable) return;
    if (e.pointerType === "pen") penSeen.current = true;
    if (e.pointerType === "touch" && penSeen.current) return; // palm rejection once a stylus is in use
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = pt(e);
    if (tool === "text") { setTextAt({ x, y }); return; }
    if (tool === "eraser") { gesture.current = { kind: "erase", start: [x, y], base: saved }; eraseAt(x, y); return; }
    if (tool === "select") {
      const hit = [...saved].reverse().find((s) => hitTest(s, x, y, 6));
      if (hit) {
        const nextSel = sel.has(hit.id) ? sel : new Set([hit.id]);
        setSel(nextSel);
        gesture.current = { kind: "move", start: [x, y], base: saved };
      } else {
        setSel(new Set());
        gesture.current = { kind: "marquee", start: [x, y] };
        setMarquee([x, y, x, y]);
      }
      return;
    }
    gesture.current = { kind: "draw", start: [x, y] };
    setDraft({ id: uid(), t: tool, c: color, w: width, p: tool === "pen" || tool === "hl" ? [x, y] : [x, y, x, y] });
  };

  const eraseAt = (x: number, y: number) => {
    const g = gesture.current;
    if (!g) return;
    const cur = (node.attrs.shapes as Shape[]);
    const keep = cur.filter((s) => !hitTest(s, x, y, 8));
    if (keep.length !== cur.length) {
      if (!g.erased) { undo.current.push(g.base!); redo.current = []; g.erased = true; }
      updateAttributes({ shapes: keep });
    }
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const [x, y] = pt(e);
    if (g.kind === "erase") return eraseAt(x, y);
    if (g.kind === "marquee") return setMarquee([g.start[0], g.start[1], x, y]);
    if (g.kind === "move") {
      const dx = x - g.start[0], dy = y - g.start[1];
      updateAttributes({ shapes: g.base!.map((s) => (sel.has(s.id) ? { ...s, p: s.p.map((v, i) => v + (i % 2 ? dy : dx)) } : s)) });
      return;
    }
    // Coalesced events give smoother handwriting on fast strokes.
    const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []).length ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    setDraft((d) => {
      if (!d) return d;
      if (d.t === "pen" || d.t === "hl") {
        const p = [...d.p];
        for (const ev of evs) {
          const [px, py] = pt(ev);
          const lx = p[p.length - 2]!, ly = p[p.length - 1]!;
          if (Math.hypot(px - lx, py - ly) >= 1.2) p.push(px, py);
        }
        return { ...d, p };
      }
      return { ...d, p: [d.p[0]!, d.p[1]!, x, y] };
    });
  };

  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "draw" && draft) {
      const tiny = draft.t !== "pen" && draft.t !== "hl" && Math.hypot(draft.p[2]! - draft.p[0]!, draft.p[3]! - draft.p[1]!) < 3;
      if (!tiny) commit([...saved, draft]);
      setDraft(null);
    } else if (g.kind === "move" && g.base) {
      if (g.base !== node.attrs.shapes) { undo.current.push(g.base); redo.current = []; }
    } else if (g.kind === "marquee" && marquee) {
      const [a, b, c, d] = [Math.min(marquee[0]!, marquee[2]!), Math.min(marquee[1]!, marquee[3]!), Math.max(marquee[0]!, marquee[2]!), Math.max(marquee[1]!, marquee[3]!)];
      setSel(new Set(saved.filter((s) => { const [x1, y1, x2, y2] = bbox(s); return x1 < c && x2 > a && y1 < d && y2 > b; }).map((s) => s.id)));
      setMarquee(null);
    }
  };

  const doUndo = useCallback(() => {
    const prev = undo.current.pop();
    if (!prev) return;
    redo.current.push(node.attrs.shapes as Shape[]);
    updateAttributes({ shapes: prev });
  }, [node.attrs.shapes, updateAttributes]);
  const doRedo = useCallback(() => {
    const next = redo.current.pop();
    if (!next) return;
    undo.current.push(node.attrs.shapes as Shape[]);
    updateAttributes({ shapes: next });
  }, [node.attrs.shapes, updateAttributes]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT") return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) doRedo(); else doUndo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); e.stopPropagation(); doRedo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && sel.size) { e.preventDefault(); e.stopPropagation(); commit(saved.filter((s) => !sel.has(s.id))); setSel(new Set()); }
      else if (e.key === "Escape") { e.stopPropagation(); setActive(false); setSel(new Set()); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, doUndo, doRedo, sel, saved, commit]);

  const resize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = height;
    const k = W / (svgRef.current?.getBoundingClientRect().width || W);
    const move = (ev: PointerEvent) => updateAttributes({ height: Math.max(120, Math.min(4000, Math.round(startH + (ev.clientY - startY) * k))) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const rendered = useMemo(() => saved.map((s) => <ShapeEl key={s.id} s={s} selected={sel.has(s.id)} />), [saved, sel]);
  const tools: [Tool, string][] = [["select", "Select"], ["pen", "Pen"], ["hl", "Highlighter"], ["eraser", "Eraser"], ["line", "Line"], ["arrow", "Arrow"], ["rect", "Box"], ["ellipse", "Circle"], ["text", "Text"]];

  return (
    <NodeViewWrapper className={`my-4 rounded-lg border ${active ? "border-accent" : selected ? "border-border" : "border-transparent hover:border-border"}`} data-drag-handle>
      {active && (
        <div className="sticky top-12 z-10 flex flex-wrap items-center gap-1 rounded-t-lg border-b border-border bg-surface/95 px-2 py-1 text-xs backdrop-blur" contentEditable={false}>
          {tools.map(([t, label]) => (
            <button key={t} type="button" aria-pressed={tool === t} className={`rounded px-2 py-1.5 ${tool === t ? "bg-fg text-bg" : "hover:bg-muted"}`}
              onClick={() => { setTool(t); if (t !== "select") setSel(new Set()); }}>{label}</button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {COLORS.map((c) => (
            <button key={c} type="button" aria-label={`Colour ${c === "currentColor" ? "default" : c}`} aria-pressed={color === c}
              className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-accent" : "border-transparent"}`} onClick={() => setColor(c)}>
              <span className="block h-full w-full rounded-full" style={{ background: c === "currentColor" ? "var(--text)" : c }} />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {WIDTHS.map((w) => (
            <button key={w} type="button" aria-label={`Width ${w}`} aria-pressed={width === w} className={`flex h-7 w-7 items-center justify-center rounded ${width === w ? "bg-muted" : ""}`} onClick={() => setWidth(w)}>
              <span className="rounded-full bg-fg" style={{ width: w + 2, height: w + 2 }} />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          <button type="button" className="rounded px-2 py-1.5 hover:bg-muted" onClick={doUndo}>Undo</button>
          <button type="button" className="rounded px-2 py-1.5 hover:bg-muted" onClick={doRedo}>Redo</button>
          <span className="flex-1" />
          <button type="button" className="rounded px-2 py-1.5 text-fg-2 hover:bg-muted hover:text-danger" onClick={() => { if (!saved.length || confirm("Remove this drawing?")) deleteNode(); }}>Remove</button>
          <button type="button" className="rounded bg-muted px-3 py-1.5 font-medium" onClick={() => { setActive(false); setSel(new Set()); }}>Done</button>
        </div>
      )}
      <div className="relative" contentEditable={false}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${height}`} className="block w-full select-none" role="img"
          aria-label={node.attrs.caption ? `Drawing: ${node.attrs.caption}` : "Drawing"}
          style={{ touchAction: active ? "none" : "auto", cursor: active ? (tool === "select" ? "default" : "crosshair") : "pointer", color: "var(--text)" }}
          onClick={() => { if (!active && editor.isEditable) setActive(true); }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {!saved.length && !draft && !active && <text x={W / 2} y={height / 2} textAnchor="middle" fill="var(--text-2)" fontSize={14}>Tap to draw</text>}
          {rendered}
          {draft && <ShapeEl s={draft} />}
          {marquee && <rect x={Math.min(marquee[0]!, marquee[2]!)} y={Math.min(marquee[1]!, marquee[3]!)} width={Math.abs(marquee[2]! - marquee[0]!)} height={Math.abs(marquee[3]! - marquee[1]!)} fill="var(--accent-soft)" fillOpacity={0.4} stroke="var(--accent)" strokeDasharray="4 3" />}
        </svg>
        {textAt && (
          <input autoFocus className="input absolute h-8 w-56 text-sm" aria-label="Drawing text"
            style={{ left: `${(textAt.x / W) * 100}%`, top: `${(textAt.y / height) * 100}%` }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = e.currentTarget.value.trim();
                if (v) commit([...saved, { id: uid(), t: "text", c: color, w: width, p: [textAt.x, textAt.y], s: v }]);
                setTextAt(null);
              } else if (e.key === "Escape") setTextAt(null);
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v) commit([...saved, { id: uid(), t: "text", c: color, w: width, p: [textAt.x, textAt.y], s: v }]);
              setTextAt(null);
            }} />
        )}
        {active && (
          <>
            <input className="w-full border-t border-border bg-transparent px-3 py-1.5 text-xs text-fg-2 outline-none" placeholder="Caption (helps search & recall find this drawing)"
              defaultValue={node.attrs.caption as string} maxLength={300} onBlur={(e) => updateAttributes({ caption: e.target.value })} />
            <div role="separator" aria-label="Resize drawing" className="h-3 cursor-ns-resize rounded-b-lg bg-muted/60 hover:bg-muted" onPointerDown={resize} />
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
}
