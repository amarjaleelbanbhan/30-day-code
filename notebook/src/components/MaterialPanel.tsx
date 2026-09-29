"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { ACCEPT } from "@/lib/extract/accept";
import { MaterialStatus } from "./CourseView";
import { uploadFile } from "./upload";

export type MaterialItem = { id: string; filename: string; kind: string; status: string; error: string | null; mime: string; lectureId: string | null; pageCount: number | null };
type Page = { page_no: number; title: string | null; body: string; speaker_notes: string | null };

type Props = {
  courseId: string;
  lectureId: string | null;
  materials: MaterialItem[];
  onMaterials: (m: MaterialItem[]) => void;
  selected: { id: string | null; page: number };
  onSelect: (id: string | null, page: number) => void;
  /** Insert an excerpt (with its citation) into the notes. Absent when no editor is open. */
  onInsert?: (text: string, cite: string) => void;
  onAi?: (materialId: string, page: number) => void;
};

export function MaterialPanel({ courseId, lectureId, materials, onMaterials, selected, onSelect, onInsert, onAi }: Props) {
  const current = materials.find((m) => m.id === selected.id) ?? null;
  const [pages, setPages] = useState<Page[] | null>(null);
  const [view, setView] = useState<"text" | "original">("text");
  const [zoom, setZoom] = useState(1);
  const [find, setFind] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const isPdf = current?.mime === "application/pdf";
  const isImage = current?.mime.startsWith("image/");

  // Load extracted pages; keep polling while the file is still being read.
  useEffect(() => {
    setPages(null);
    if (!current) return;
    let stop = false;
    const load = async () => {
      const r = await api<{ material: { status: string; error: string | null; page_count: number | null }; pages: Page[] }>(`/api/materials/${current.id}`).catch(() => null);
      if (stop || !r) return;
      setPages(r.pages);
      if (r.material.status !== current.status)
        onMaterials(materials.map((m) => (m.id === current.id ? { ...m, status: r.material.status, error: r.material.error, pageCount: r.material.page_count } : m)));
      if (r.material.status === "pending" || r.material.status === "processing") setTimeout(load, 1500);
    };
    void load();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status]);

  useEffect(() => { if (isImage) setView("original"); }, [isImage]);

  const total = pages?.length ?? current?.pageCount ?? 0;
  const pageNo = Math.min(Math.max(1, selected.page), Math.max(1, total));
  const page = pages?.find((p) => p.page_no === pageNo) ?? null;
  const unit = current?.mime.includes("presentation") ? "Slide" : isPdf ? "Page" : "Section";
  const go = useCallback((n: number) => { if (current) onSelect(current.id, Math.min(Math.max(1, n), Math.max(1, total))); }, [current, total, onSelect]);

  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [pageNo, current?.id]);

  const matches = useMemo(() => {
    const t = find.trim().toLowerCase();
    if (!t || !pages) return [];
    return pages.filter((p) => `${p.title ?? ""}\n${p.body}\n${p.speaker_notes ?? ""}`.toLowerCase().includes(t)).map((p) => p.page_no);
  }, [find, pages]);

  const cite = current ? `${current.filename} · ${unit} ${pageNo}` : "";
  const insertSelection = () => {
    if (!onInsert || !page) return;
    const sel = window.getSelection();
    const text = sel && bodyRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : "";
    onInsert(text || [page.title, page.body].filter(Boolean).join("\n"), cite);
  };

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploadError(null);
    const added: MaterialItem[] = [];
    for (const f of Array.from(files)) {
      try {
        const m = await uploadFile(courseId, f, { lectureId: lectureId ?? undefined, kind: lectureId ? "slides" : "other" });
        added.push({ id: m.id, filename: m.filename, kind: m.kind, status: m.status, error: null, mime: f.type || "", lectureId, pageCount: null });
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "Upload failed");
      }
    }
    if (added.length) {
      // Refresh to get server-detected mime types.
      const r = await api<{ materials: { id: string; mime: string }[] }>(`/api/courses/${courseId}/materials`).catch(() => null);
      const mime = new Map(r?.materials.map((m) => [m.id, m.mime]) ?? []);
      onMaterials([...materials, ...added.map((a) => ({ ...a, mime: mime.get(a.id) ?? a.mime }))]);
      onSelect(added[0]!.id, 1);
    }
  }

  return (
    <section aria-label="Lecture material" className="flex h-full min-h-0 flex-col bg-surface"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
        if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(pageNo + 1); }
        if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(pageNo - 1); }
      }}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <select className="input h-8 min-w-0 flex-1 text-sm" aria-label="Material" value={current?.id ?? ""}
          onChange={(e) => onSelect(e.target.value || null, 1)}>
          {!materials.length && <option value="">No material yet</option>}
          {materials.map((m) => (
            <option key={m.id} value={m.id}>{m.lectureId ? "" : "Course · "}{m.filename}</option>
          ))}
        </select>
        <label className="btn h-8 cursor-pointer px-2 text-xs" title="Upload material">
          Upload<input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </div>
      {uploadError && <p role="alert" className="px-3 pt-2 text-xs text-danger">{uploadError}</p>}

      {current && (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
            <button className="btn btn-ghost h-7 px-2" onClick={() => go(pageNo - 1)} disabled={pageNo <= 1} aria-label={`Previous ${unit.toLowerCase()}`}>‹</button>
            <span className="tabular-nums text-fg-2">{unit} {total ? pageNo : "–"} / {total || "–"}</span>
            <button className="btn btn-ghost h-7 px-2" onClick={() => go(pageNo + 1)} disabled={pageNo >= total} aria-label={`Next ${unit.toLowerCase()}`}>›</button>
            <span className="mx-1 h-4 w-px bg-border" />
            <button className="btn btn-ghost h-7 px-2" onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.1).toFixed(1)))} aria-label="Zoom out">−</button>
            <span className="w-9 text-center tabular-nums text-fg-2">{Math.round(zoom * 100)}%</span>
            <button className="btn btn-ghost h-7 px-2" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(1)))} aria-label="Zoom in">+</button>
            {(isPdf || isImage) && (
              <>
                <span className="mx-1 h-4 w-px bg-border" />
                <button className={`btn h-7 px-2 ${view === "text" ? "" : "btn-ghost"}`} onClick={() => setView("text")} disabled={!!isImage}>Text</button>
                <button className={`btn h-7 px-2 ${view === "original" ? "" : "btn-ghost"}`} onClick={() => setView("original")}>Original</button>
              </>
            )}
            <span className="flex-1" />
            <span className="text-fg-2"><MaterialStatus status={current.status} error={current.error} /></span>
          </div>
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <input className="input h-7 text-xs" placeholder={`Search ${unit.toLowerCase()}s…`} value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search this material" />
            {find && <span className="shrink-0 text-xs text-fg-2">{matches.length} found</span>}
          </div>
          {find && matches.length > 0 && (
            <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1.5">
              {matches.slice(0, 60).map((n) => (
                <button key={n} className={`rounded border px-1.5 text-xs tabular-nums ${n === pageNo ? "border-accent text-accent" : "border-border"}`} onClick={() => go(n)}>{n}</button>
              ))}
            </div>
          )}

          <div ref={bodyRef} tabIndex={0} className="min-h-0 flex-1 overflow-auto outline-none">
            {view === "original" && (isPdf || isImage) ? (
              isPdf ? (
                <iframe key={`${current.id}-${pageNo}-${zoom}`} title={cite} className="h-full w-full border-0 bg-white"
                  src={`/api/materials/${current.id}/file#page=${pageNo}&zoom=${Math.round(zoom * 100)}`} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/materials/${current.id}/file`} alt={current.filename} style={{ width: `${zoom * 100}%` }} className="max-w-none" />
              )
            ) : current.status === "failed" ? (
              <p className="p-4 text-sm text-danger">This file could not be read{current.error ? `: ${current.error}` : "."}</p>
            ) : !pages ? (
              <p className="p-4 text-sm text-fg-2">Loading…</p>
            ) : !page ? (
              <p className="p-4 text-sm text-fg-2">{current.status === "ready" ? "No text found in this file." : "Reading the file…"}</p>
            ) : (
              <article className="p-5" style={{ fontSize: `${zoom * 0.95}rem` }}>
                {page.title && <h3 className="mb-3 text-[1.15em] font-semibold"><Mark text={page.title} term={find} /></h3>}
                <div className="whitespace-pre-wrap leading-relaxed"><Mark text={page.title && page.body.startsWith(page.title) ? page.body.slice(page.title.length).trimStart() : page.body} term={find} /></div>
                {page.speaker_notes && (
                  <details className="mt-6 rounded-lg bg-muted p-3 text-[0.9em]">
                    <summary className="cursor-pointer text-fg-2">Speaker notes</summary>
                    <p className="mt-2 whitespace-pre-wrap"><Mark text={page.speaker_notes} term={find} /></p>
                  </details>
                )}
              </article>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
            {onInsert && <button className="btn h-8 text-xs" onClick={insertSelection} disabled={!page} title="Insert the selected text (or the whole page) into your notes with its source">Insert into notes</button>}
            <button className="btn h-8 text-xs" disabled={!page} onClick={() => {
              const sel = window.getSelection()?.toString();
              void navigator.clipboard.writeText(sel?.trim() || [page?.title, page?.body].filter(Boolean).join("\n"));
            }}>Copy</button>
            {onAi && <button className="btn h-8 text-xs" disabled={!page} onClick={() => onAi(current.id, pageNo)}>Summarize {unit.toLowerCase()}</button>}
          </div>
        </>
      )}
    </section>
  );
}

function Mark({ text, term }: { text: string; term: string }) {
  const t = term.trim();
  if (!t) return <>{text}</>;
  const parts = text.split(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-[var(--highlight)] text-inherit">{p}</mark> : p))}</>;
}
