"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { docToPlainText } from "@/lib/chunk";
import { api, isTyping, pad2 } from "@/lib/client";
import { escapeHtml, mdToHtml } from "@/lib/md-html";
import { AskPanel } from "./AskPanel";
import { useRegisterCommands, type Command } from "./commands";
import { NoteEditor, type EditorApi } from "./editor/NoteEditor";
import type { SyncStatus } from "./editor/useNoteSync";
import { HistoryPanel } from "./HistoryPanel";
import { Markdown } from "./Markdown";
import { MaterialPanel, type MaterialItem } from "./MaterialPanel";
import { startStudy } from "./study/start";
import { ThemeToggle } from "./ThemeToggle";

type Right = "material" | "ask" | "search" | "history" | "ai" | null;
type AiAction = "structure" | "revision" | "explain" | "summarize_slide" | "missing_points" | "examples" | "flashcards" | "quiz";
const AI_ACTIONS: [AiAction, string][] = [
  ["structure", "Structure my notes"], ["revision", "Turn into revision notes"], ["missing_points", "Add missing points from lecture"],
  ["explain", "Explain selection"], ["examples", "Create examples"], ["flashcards", "Create flashcards"], ["quiz", "Create quiz"],
];

type Props = {
  course: { id: string; name: string };
  lecture: { id: string; number: number | null; title: string; date: string | null };
  lectures: { id: string; number: number | null; title: string }[];
  materials: MaterialItem[];
  note: { content: { type: "doc" }; updatedAt: string };
};

const pref = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };

export function Workspace({ course, lecture, lectures, materials: initialMats, note }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [mats, setMats] = useState(initialMats);
  const [leftOpen, setLeftOpen] = useState(true);
  const [right, setRight] = useState<Right>(null);
  const [focus, setFocus] = useState(false);
  const [navOverlay, setNavOverlay] = useState(false);
  const [askQ, setAskQ] = useState<string | null>(null);
  const [title, setTitle] = useState(lecture.title);
  const [status, setStatus] = useState<SyncStatus>("saved");
  const [ai, setAi] = useState<{ label: string; busy: boolean; markdown?: string; error?: string } | null>(null);
  const [aiMenu, setAiMenu] = useState(false);
  const [studyMenu, setStudyMenu] = useState(false);
  const study = useCallback(async (kind: "practice" | "master" | "exam") => {
    setStudyMenu(false);
    try {
      router.push(await startStudy(course.id, { kind, scope: { type: "lecture", lectureIds: [lecture.id], label: `Lecture ${pad2(lecture.number)}` }, config: kind === "exam" ? { count: 8 } : {} }));
    } catch (e) { alert(e instanceof Error ? e.message : "Could not start studying"); }
  }, [course.id, lecture.id, lecture.number, router]);
  const apiRef = useRef<EditorApi | null>(null);

  const matParam = params.get("m");
  const pageParam = Number(params.get("p") ?? 1) || 1;
  const [sel, setSel] = useState<{ id: string | null; page: number }>({ id: matParam ?? mats[0]?.id ?? null, page: pageParam });

  // Restore layout preferences; open the material panel when arriving from a citation or when slides exist.
  useEffect(() => {
    setLeftOpen(pref("nb-left", "1") === "1");
    if (matParam) setRight("material");
    else if (window.innerWidth >= 1280 && mats.some((m) => m.lectureId) && pref("nb-right", "material") === "material") setRight("material");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (matParam) { setSel({ id: matParam, page: pageParam }); setRight("material"); }
  }, [matParam, pageParam]);

  // Arriving from a note citation: scroll to and briefly highlight the exact note block (or section heading).
  useEffect(() => {
    const anchor = params.get("hl");
    const section = params.get("section");
    if (!anchor && !section) return;
    let tries = 0;
    const find = () => {
      const el = anchor ? findNoteBlock(anchor) : [...document.querySelectorAll(".nb-editor h1, .nb-editor h2, .nb-editor h3")].find((e) => e.textContent?.trim() === section!.trim());
      if (!el) { if (tries++ < 20) t = setTimeout(find, 150); return; }
      el.scrollIntoView({ block: "center" });
      flashOver(el);
    };
    let t = setTimeout(find, 150);
    return () => clearTimeout(t);
  }, [params]);

  const onApi = useCallback((a: EditorApi) => { apiRef.current = a; setStatus(a.status); }, []);
  const toggleRight = useCallback((r: Exclude<Right, null>) => setRight((cur) => { const next = cur === r ? null : r; if (r === "material") setPref("nb-right", next ? "material" : ""); return next; }), []);
  const openAsk = useCallback((q?: string) => { setAskQ(q ?? null); setRight("ask"); }, []);

  const insertHtml = useCallback((html: string) => {
    const ed = apiRef.current?.editor;
    if (!ed) return;
    ed.chain().focus().insertContent(html).run();
  }, []);

  const insertExcerpt = useCallback((text: string, cite: string) => {
    insertHtml(`<blockquote><p>${escapeHtml(text).replace(/\n/g, "<br>")}</p><p><em>— ${escapeHtml(cite)}</em></p></blockquote><p></p>`);
  }, [insertHtml]);

  const insertAi = useCallback(async (markdown: string, label: string) => {
    await apiRef.current?.flush("ai"); // snapshot current notes into history before inserting AI text
    insertHtml(`<div data-callout><p><strong>AI · ${escapeHtml(label)}</strong></p>${mdToHtml(markdown)}</div><p></p>`);
  }, [insertHtml]);

  const runAi = useCallback(async (action: AiAction, label: string, extra: { materialId?: string; pageNo?: number } = {}) => {
    setAiMenu(false);
    const ed = apiRef.current?.editor;
    const text = action === "explain" && ed ? ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, "\n") : undefined;
    if (action === "explain" && !text?.trim()) { setAi({ label, busy: false, error: "Select some text in your notes first." }); setRight("ai"); return; }
    setAi({ label, busy: true });
    setRight("ai");
    await apiRef.current?.flush();
    try {
      const r = await api<{ ok: boolean; markdown?: string; error?: string }>("/api/ai/action", { method: "POST", json: { action, lectureId: lecture.id, text, ...extra } });
      setAi({ label, busy: false, markdown: r.markdown, error: r.ok ? undefined : r.error });
    } catch (e) {
      setAi({ label, busy: false, error: e instanceof Error ? e.message : "Failed" });
    }
  }, [lecture.id]);

  const insertDrawing = useCallback(() => {
    const ed = apiRef.current?.editor;
    if (!ed) return;
    if (!ed.isFocused) ed.commands.focus("end");
    ed.commands.insertSketch();
  }, []);

  async function saveTitle() {
    const t = title.trim();
    if (t === lecture.title) return;
    await api(`/api/lectures/${lecture.id}`, { method: "PATCH", json: { title: t, number: lecture.number, lectureDate: lecture.date } }).catch(() => setTitle(lecture.title));
    router.refresh();
  }

  async function deleteLecture() {
    if (!confirm("Delete this lecture, its notes and its uploaded files?")) return;
    await api(`/api/lectures/${lecture.id}`, { method: "DELETE" });
    router.replace(`/c/${course.id}`);
  }

  // Keyboard shortcuts. Single-letter keys only fire outside text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "s") { e.preventDefault(); void apiRef.current?.flush(); return; }
      if (mod && e.shiftKey && k === "f") { e.preventDefault(); setRight("search"); return; }
      if (mod && !e.shiftKey && k === "f" && !(document.activeElement as HTMLElement | null)?.closest("[data-search-panel]")) { e.preventDefault(); setRight("search"); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); openAsk(); return; }
      if (e.key === "Escape") {
        if (focus) { setFocus(false); return; }
        if (aiMenu || studyMenu) { setAiMenu(false); setStudyMenu(false); return; }
        if (right && !isTyping(e)) { setRight(null); return; }
      }
      if (mod || e.altKey || isTyping(e)) return;
      if (k === "f") { e.preventDefault(); setFocus((f) => !f); }
      else if (k === "d") { e.preventDefault(); insertDrawing(); }
      else if (k === "[") setLeftOpen((o) => { setPref("nb-left", o ? "0" : "1"); return !o; });
      else if (k === "]") toggleRight("material");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, right, aiMenu, studyMenu, openAsk, insertDrawing, toggleRight]);

  const idx = lectures.findIndex((l) => l.id === lecture.id);
  const commands = useMemo<Command[]>(() => [
    { id: "focus", label: "Focus mode", shortcut: "F", run: () => setFocus(true) },
    { id: "draw", label: "Draw", shortcut: "D", run: insertDrawing },
    { id: "formula", label: "Insert formula", run: () => { const latex = window.prompt("Formula (LaTeX)"); if (latex?.trim()) apiRef.current?.editor.chain().focus().insertInlineMath({ latex }).run(); } },
    { id: "material", label: "Show lecture material", shortcut: "]", run: () => setRight("material") },
    { id: "upload", label: "Upload material", run: () => setRight("material") },
    { id: "ask", label: "Ask AI", shortcut: "Ctrl ↵", run: () => openAsk() },
    { id: "recall", label: `Recall lecture ${pad2(lecture.number)}`, run: () => openAsk(`Recall lecture ${lecture.number}`) },
    { id: "recall-course", label: "Recall course", run: () => openAsk("Recall the whole course") },
    { id: "concepts", label: "Concepts", run: () => router.push(`/c/${course.id}/concepts`) },
    { id: "study-lecture", label: "Study this lecture", group: "Study", run: () => void study("practice") },
    { id: "master-lecture", label: "Master this lecture", group: "Study", run: () => void study("master") },
    { id: "exam-lecture", label: "Exam practice on this lecture", group: "Study", run: () => void study("exam") },
    { id: "study-hub", label: "Study overview", group: "Study", run: () => router.push(`/c/${course.id}/study`) },
    { id: "quiz", label: "Create quiz", run: () => runAi("quiz", "Quiz") },
    { id: "search", label: "Search course", shortcut: "Ctrl ⇧ F", run: () => setRight("search") },
    { id: "history", label: "Version history", run: () => setRight("history") },
    { id: "sync", label: "Save now", shortcut: "Ctrl S", run: () => void apiRef.current?.flush() },
    ...AI_ACTIONS.map(([a, label]) => ({ id: `ai-${a}`, label, group: "AI", run: () => runAi(a, label) })),
    { id: "new-lecture", label: "New lecture", run: () => router.push(`/c/${course.id}`) },
    ...lectures.map((l) => ({ id: `open-${l.id}`, label: `Lecture ${pad2(l.number)}${l.title ? ` — ${l.title}` : ""}`, group: "Open lecture", run: () => router.push(`/c/${course.id}/l/${l.id}`) })),
  ], [lectures, lecture.number, course.id, router, openAsk, runAi, insertDrawing, study]);
  useRegisterCommands("workspace", commands);

  const statusText = { saved: "Saved", saving: "Saving…", unsaved: "Saving…", offline: "Offline — saved on this device" }[status];

  const rightPanel = right && (
    <div className="fixed inset-0 z-30 border-l border-border bg-surface md:static md:z-auto md:w-[clamp(320px,42vw,640px)] md:shrink-0" data-search-panel={right === "search" ? "" : undefined}>
      {right === "material" && (
        <div className="flex h-full flex-col">
          <PanelClose label="Material" onClose={() => toggleRight("material")} />
          <div className="min-h-0 flex-1">
            <MaterialPanel courseId={course.id} lectureId={lecture.id} materials={mats} onMaterials={setMats}
              selected={sel} onSelect={(id, page) => setSel({ id, page })} onInsert={insertExcerpt}
              onAi={(materialId, pageNo) => runAi("summarize_slide", `Summary of slide ${pageNo}`, { materialId, pageNo })} />
          </div>
        </div>
      )}
      {(right === "ask" || right === "search") && (
        <AskPanel courseId={course.id} courseName={course.name} lectureId={lecture.id} lectureNumber={lecture.number} tab={right} initialQuestion={askQ}
          onExplainSelection={() => runAi("explain", "Explain selection")} onQuiz={() => runAi("quiz", "Quiz")}
          onTab={(t) => setRight(t)} onClose={() => setRight(null)}
          onInsert={(md) => void insertAi(md, "Answer")} />
      )}
      {right === "history" && (
        <div className="flex h-full flex-col">
          <PanelClose label="" onClose={() => setRight(null)} />
          <div className="min-h-0 flex-1">
            <HistoryPanel lectureId={lecture.id} currentText={() => docToPlainText((apiRef.current?.editor.getJSON() ?? note.content) as { type: "doc" })}
              onRestored={() => {
                try { localStorage.removeItem(`nb:note:${lecture.id}`); } catch {}
                setRight(null);
                window.location.reload();
              }} />
          </div>
        </div>
      )}
      {right === "ai" && ai && (
        <div className="flex h-full flex-col">
          <PanelClose label={`AI · ${ai.label}`} onClose={() => setRight(null)} />
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {ai.busy && <p className="text-sm text-fg-2">Working from your lecture material…</p>}
            {ai.error && <p role="alert" className="text-sm text-danger">{ai.error}</p>}
            {ai.markdown && <Markdown text={ai.markdown} />}
          </div>
          {ai.markdown && (
            <div className="flex gap-2 border-t border-border p-3">
              <button className="btn btn-primary h-8 text-xs" onClick={() => void insertAi(ai.markdown!, ai.label)}>Insert into notes</button>
              <button className="btn h-8 text-xs" onClick={() => void navigator.clipboard.writeText(ai.markdown!)}>Copy</button>
              <span className="self-center text-xs text-fg-2">Your notes are never replaced.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const lectureNav = (
    <>
            <ol className="min-h-0 flex-1 overflow-y-auto py-2">
              {lectures.map((l) => (
                <li key={l.id}>
                  <Link href={`/c/${course.id}/l/${l.id}`} aria-current={l.id === lecture.id ? "page" : undefined}
                    className={`flex gap-2 px-4 py-1.5 text-sm ${l.id === lecture.id ? "bg-muted font-medium" : "text-fg-2 hover:bg-muted hover:text-fg"}`}>
                    <span className="tabular-nums">{pad2(l.number)}</span><span className="truncate">{l.id === lecture.id ? title || "Untitled" : l.title || "Untitled"}</span>
                  </Link>
                </li>
              ))}
            </ol>
            <div className="space-y-1 border-t border-border p-3 text-xs">
              <Link href={`/c/${course.id}`} className="block text-fg-2 hover:text-fg">+ New lecture</Link>
              <button className="block text-fg-2 hover:text-danger" onClick={deleteLecture}>Delete this lecture</button>
            </div>
    </>
  );

  return (
    <div className="flex h-dvh flex-col">
      {!focus && (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
          <button className="btn btn-ghost h-8 px-2 text-fg-2"
            onClick={() => (window.innerWidth < 1024 ? setNavOverlay((o) => !o) : setLeftOpen((o) => { setPref("nb-left", o ? "0" : "1"); return !o; }))}
            aria-label={leftOpen ? "Hide lectures" : "Show lectures"} aria-expanded={leftOpen} title="Lectures ([)">☰</button>
          <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-fg-2" aria-label="Breadcrumb">
            <Link href={`/c/${course.id}`} className="hidden truncate hover:text-fg sm:inline">{course.name}</Link>
            <span className="hidden sm:inline">/</span>
            <span className="shrink-0 tabular-nums">Lecture {pad2(lecture.number)}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} placeholder="Untitled"
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} aria-label="Lecture title"
              className="min-w-0 flex-1 truncate bg-transparent font-medium text-fg outline-none" maxLength={300} />
          </nav>
          <span className={`hidden text-xs sm:inline ${status === "offline" ? "text-danger" : "text-fg-2"}`} role="status" aria-live="polite">{statusText}</span>
          <div className="flex items-center gap-0.5">
            <button className={`btn h-8 px-2.5 text-xs ${right === "material" ? "" : "btn-ghost"}`} onClick={() => toggleRight("material")} title="Lecture material (])">Material</button>
            <button className={`btn h-8 px-2.5 text-xs ${right === "ask" || right === "search" ? "" : "btn-ghost"}`} onClick={() => (right === "ask" ? setRight(null) : openAsk())} title="Ask course (Ctrl+Enter)">Ask</button>
            <div className="relative">
              <button className="btn btn-ghost h-8 px-2.5 text-xs" aria-haspopup="menu" aria-expanded={studyMenu} onClick={() => setStudyMenu((o) => !o)}>Study</button>
              {studyMenu && (
                <ul role="menu" className="absolute right-0 top-9 z-40 w-56 rounded-lg border border-border bg-surface py-1 shadow-lg">
                  {([["practice", "Study this lecture"], ["master", "Master this lecture"], ["exam", "Exam practice"]] as const).map(([k, l]) => (
                    <li key={k} role="none"><button role="menuitem" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => void study(k)}>{l}</button></li>
                  ))}
                  <li role="none"><Link role="menuitem" className="block px-3 py-2 text-sm hover:bg-muted" href={`/c/${course.id}/study`}>Study overview</Link></li>
                </ul>
              )}
            </div>
            <div className="relative">
              <button className="btn btn-ghost h-8 px-2.5 text-xs" aria-haspopup="menu" aria-expanded={aiMenu} onClick={() => setAiMenu((o) => !o)}>AI</button>
              {aiMenu && (
                <ul role="menu" className="absolute right-0 top-9 z-40 w-60 rounded-lg border border-border bg-surface py-1 shadow-lg">
                  <li role="none"><button role="menuitem" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => { setAiMenu(false); openAsk(`Recall lecture ${lecture.number}`); }}>Recall this lecture</button></li>
                  {AI_ACTIONS.map(([a, label]) => (
                    <li key={a} role="none"><button role="menuitem" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => runAi(a, label)}>{label}</button></li>
                  ))}
                </ul>
              )}
            </div>
            <button className={`btn h-8 px-2.5 text-xs ${right === "history" ? "" : "btn-ghost"} hidden sm:inline-flex`} onClick={() => toggleRight("history")}>History</button>
            <button className="btn btn-ghost hidden h-8 px-2.5 text-xs sm:inline-flex" onClick={() => setFocus(true)} title="Focus mode (F)">Focus</button>
            <span className="hidden sm:inline"><ThemeToggle /></span>
          </div>
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        {!focus && leftOpen && (
          <aside aria-label="Lectures" className="hidden w-56 shrink-0 flex-col border-r border-border lg:flex">{lectureNav}</aside>
        )}
        {!focus && navOverlay && (
          <div className="fixed inset-0 z-40 bg-black/20 lg:hidden" onClick={() => setNavOverlay(false)}>
            <aside aria-label="Lectures" className="flex h-full w-64 flex-col border-r border-border bg-surface" onClick={(e) => e.stopPropagation()}>{lectureNav}</aside>
          </div>
        )}

        <main className="relative min-w-0 flex-1 overflow-y-auto" id="notes-scroll">
          <div className={`mx-auto max-w-[760px] px-5 sm:px-8 ${focus ? "pt-16" : "pt-6"}`}>
            <NoteEditor lectureId={lecture.id} initial={note.content} serverUpdatedAt={note.updatedAt} compactToolbar={focus} onApi={onApi} />
          </div>
          {!focus && (
            <nav className="mx-auto flex max-w-[760px] justify-between px-5 pb-10 text-sm text-fg-2 sm:px-8">
              {idx > 0 ? <Link className="hover:text-fg" href={`/c/${course.id}/l/${lectures[idx - 1]!.id}`}>← Lecture {pad2(lectures[idx - 1]!.number)}</Link> : <span />}
              {idx >= 0 && idx < lectures.length - 1 ? <Link className="hover:text-fg" href={`/c/${course.id}/l/${lectures[idx + 1]!.id}`}>Lecture {pad2(lectures[idx + 1]!.number)} →</Link> : <span />}
            </nav>
          )}
        </main>

        {!focus && rightPanel}
      </div>

      {focus && (
        <div className="fixed right-3 top-3 z-30 flex items-center gap-2 rounded-full border border-border bg-surface/90 px-3 py-1 text-xs text-fg-2 backdrop-blur">
          <span role="status">{statusText}</span>
          <button className="hover:text-fg" onClick={() => setFocus(false)} aria-label="Exit focus mode">Esc</button>
        </div>
      )}
    </div>
  );
}

/** Highlights a block with an overlay (ProseMirror owns the editor DOM and would strip classes added to it). */
function flashOver(el: Element) {
  const host = document.getElementById("notes-scroll");
  if (!host) return;
  const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
  const o = document.createElement("div");
  o.className = "nb-flash";
  o.dataset.flashText = (el.textContent ?? el.getAttribute("aria-label") ?? "").slice(0, 200);
  Object.assign(o.style, { position: "absolute", pointerEvents: "none", left: `${r.left - h.left + host.scrollLeft - 6}px`, top: `${r.top - h.top + host.scrollTop - 4}px`, width: `${r.width + 12}px`, height: `${r.height + 8}px` });
  host.appendChild(o);
  setTimeout(() => o.remove(), 2600);
}

/** Finds the smallest note block whose text contains the anchor (whitespace-insensitive); drawings match by caption. */
function findNoteBlock(anchor: string): HTMLElement | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(anchor);
  const root = document.querySelector(".nb-editor");
  if (!root || !a) return null;
  const drawing = [...root.querySelectorAll<SVGElement>("svg[aria-label]")].find((s) => norm(s.getAttribute("aria-label") ?? "") === `drawing: ${a}`);
  if (drawing) return drawing.closest<HTMLElement>("[data-node-view-wrapper]") ?? (drawing.parentElement as HTMLElement);
  const blocks = [...root.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, blockquote, pre, td, div[data-callout]")];
  const hits = blocks.filter((b) => norm(b.textContent ?? "").includes(a));
  if (hits.length) return hits.sort((x, y) => (x.textContent?.length ?? 0) - (y.textContent?.length ?? 0))[0]!;
  const short = a.split(" ").slice(0, 4).join(" ");
  return blocks.find((b) => norm(b.textContent ?? "").includes(short)) ?? null;
}

function PanelClose({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5 md:hidden">
      <span className="text-sm font-medium">{label}</span>
      <button className="btn btn-ghost h-8 px-2 text-xs" onClick={onClose}>Close</button>
    </div>
  );
}
