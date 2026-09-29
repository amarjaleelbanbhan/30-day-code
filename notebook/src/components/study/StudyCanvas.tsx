"use client";
import { useRef, useState } from "react";
import { hitTest, ShapeEl, type Shape } from "../editor/Sketch";

const W = 800;

/** Minimal drawing surface for diagram answers (pen, eraser, undo, clear). Stored as vector strokes. */
export function StudyCanvas({ value, onChange, disabled }: { value: Shape[]; onChange: (s: Shape[]) => void; disabled?: boolean }) {
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [draft, setDraft] = useState<Shape | null>(null);
  const history = useRef<Shape[][]>([]);
  const svg = useRef<SVGSVGElement>(null);
  const H = 380;
  const pt = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const k = W / r.width;
    return [Math.round((e.clientX - r.left) * k), Math.round((e.clientY - r.top) * k)];
  };
  const erase = (x: number, y: number) => {
    const keep = value.filter((s) => !hitTest(s, x, y, 8));
    if (keep.length !== value.length) onChange(keep);
  };
  return (
    <div className="rounded-lg border border-border">
      <div className="flex gap-1 border-b border-border px-2 py-1 text-xs">
        {(["pen", "eraser"] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tool === t} className={`rounded px-2 py-1 ${tool === t ? "bg-fg text-bg" : "hover:bg-muted"}`} onClick={() => setTool(t)} disabled={disabled}>{t === "pen" ? "Pen" : "Eraser"}</button>
        ))}
        <button type="button" className="rounded px-2 py-1 hover:bg-muted" disabled={disabled || !history.current.length} onClick={() => onChange(history.current.pop() ?? [])}>Undo</button>
        <button type="button" className="rounded px-2 py-1 hover:bg-muted" disabled={disabled || !value.length} onClick={() => { history.current.push(value); onChange([]); }}>Clear</button>
      </div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="block w-full select-none" style={{ touchAction: "none", cursor: disabled ? "default" : "crosshair", color: "var(--text)" }}
        role="img" aria-label="Your drawing"
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const [x, y] = pt(e);
          history.current.push(value);
          if (tool === "eraser") { erase(x, y); return; }
          setDraft({ id: Math.random().toString(36).slice(2), t: "pen", c: "currentColor", w: 3, p: [x, y] });
        }}
        onPointerMove={(e) => {
          if (disabled || e.buttons !== 1) return;
          const [x, y] = pt(e);
          if (tool === "eraser") return erase(x, y);
          setDraft((d) => (d ? { ...d, p: [...d.p, x, y] } : d));
        }}
        onPointerUp={() => { if (draft) onChange([...value, draft]); setDraft(null); }}>
        {value.map((s) => <ShapeEl key={s.id} s={s} />)}
        {draft && <ShapeEl s={draft} />}
        {!value.length && !draft && <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--text-2)" fontSize={14}>Draw your answer here</text>}
      </svg>
    </div>
  );
}
