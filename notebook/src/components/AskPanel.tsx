"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AskResult, Source } from "@/lib/rag";
import { Markdown } from "./Markdown";

export type PanelTab = "ask" | "search";

type Hit = { id: string; label: string; text: string; section: string | null; lecture_id: string | null; material_id: string | null; page_no: number | null; source_type: string };

export function sourceHref(courseId: string, s: { lectureId: string | null; materialId: string | null; pageNo: number | null; section?: string | null }): string {
  const qs = new URLSearchParams();
  if (s.materialId) qs.set("m", s.materialId);
  if (s.pageNo != null) qs.set("p", String(s.pageNo));
  if (!s.materialId && s.section) qs.set("section", s.section);
  if (s.lectureId) return `/c/${courseId}/l/${s.lectureId}?${qs}`;
  if (s.materialId) return `/c/${courseId}/m/${s.materialId}?${qs}`;
  return `/c/${courseId}`;
}

type Props = {
  courseId: string;
  courseName: string;
  lectureId?: string;
  tab: PanelTab;
  initialQuestion?: string | null;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onInsert?: (markdown: string) => void;
};

export function AskPanel({ courseId, courseName, lectureId, tab, initialQuestion, onTab, onClose, onInsert }: Props) {
  return (
    <aside aria-label="Course assistant" className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div role="tablist" className="flex gap-1">
          {(["ask", "search"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t}
              className={`btn h-8 px-3 ${tab === t ? "" : "btn-ghost text-fg-2"}`} onClick={() => onTab(t)}>
              {t === "ask" ? "Ask" : "Search"}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost h-8 px-2 text-fg-2" onClick={onClose} aria-label="Close panel">Close</button>
      </div>
      {tab === "ask" ? (
        <AskTab courseId={courseId} courseName={courseName} lectureId={lectureId} initialQuestion={initialQuestion} onInsert={onInsert} />
      ) : (
        <SearchTab courseId={courseId} courseName={courseName} />
      )}
    </aside>
  );
}

function AskTab({ courseId, courseName, lectureId, initialQuestion, onInsert }: { courseId: string; courseName: string; lectureId?: string; initialQuestion?: string | null; onInsert?: (md: string) => void }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastAsked = useRef<string | null>(null);

  async function run(q: string, allowGeneral = false) {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setFocused(null);
    try {
      setResult(await api<AskResult>(`/api/courses/${courseId}/ask`, { method: "POST", json: { question: q, lectureId, allowGeneral } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialQuestion && initialQuestion !== lastAsked.current) {
      lastAsked.current = initialQuestion;
      setQuestion(initialQuestion);
      void run(initialQuestion);
    } else ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form className="border-b border-border p-4" onSubmit={(e) => { e.preventDefault(); void run(question); }}>
        <textarea ref={ref} className="input resize-none" rows={2} value={question} placeholder={`Ask ${courseName}…`}
          aria-label={`Ask ${courseName}`} onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(question); } }} />
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {["Recall course", "Recall lecture 1", "Where did we study "].map((s) => (
            <button type="button" key={s} className="rounded-md border border-border px-2 py-1 text-fg-2 hover:bg-muted"
              onClick={() => { setQuestion(s); if (!s.endsWith(" ")) void run(s); else ref.current?.focus(); }}>{s.trim()}…</button>
          ))}
        </div>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
        {busy && <p className="text-sm text-fg-2">Reading your course material…</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!busy && result && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold">{result.title}</h2>
            {result.aiError && <p className="text-xs text-fg-2">{result.aiError}</p>}
            {result.mode === "retrieval" && !result.aiError && result.sources.length > 0 && (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-fg-2">
                AI answers are not configured on this server, so here is the relevant material and notes from your course, with sources.
              </p>
            )}
            {result.answer && <Markdown text={result.answer} onCite={(n) => setFocused(n)} />}
            {result.notFound && !result.sources.length && (
              <button className="btn h-8 text-xs" onClick={() => run(question, true)}>Give a general explanation</button>
            )}
            {result.answer && onInsert && result.mode === "answer" && (
              <button className="btn h-8 text-xs" onClick={() => onInsert(`**AI — ${result.title}**\n\n${result.answer}`)}>Insert into notes</button>
            )}
            {result.outline && <OutlineView courseId={courseId} outline={result.outline} />}
            {result.sources.length > 0 && <Sources courseId={courseId} sources={result.sources} focused={focused} />}
          </div>
        )}
      </div>
    </div>
  );
}

function OutlineView({ courseId, outline }: { courseId: string; outline: NonNullable<AskResult["outline"]> }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Outline</h3>
      <ol className="space-y-3">
        {outline.map((o) => (
          <li key={o.lectureId}>
            <Link href={`/c/${courseId}/l/${o.lectureId}`} className="text-sm font-medium hover:underline">{o.label}</Link>
            {o.topics.length > 0 ? (
              <ul className="mt-1 space-y-0.5 pl-3">
                {o.topics.map((t, i) => (
                  <li key={i}>
                    <Link className="text-sm text-fg-2 hover:text-fg hover:underline"
                      href={sourceHref(courseId, { lectureId: o.lectureId, materialId: t.materialId, pageNo: t.pageNo, section: t.title })}>
                      {t.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="pl-3 text-xs text-fg-2">No content yet</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Sources({ courseId, sources, focused }: { courseId: string; sources: Source[]; focused: number | null }) {
  const router = useRouter();
  useEffect(() => {
    if (focused != null) document.getElementById(`src-${focused}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Sources</h3>
      <ol className="space-y-2">
        {sources.map((s) => (
          <li key={s.n} id={`src-${s.n}`}>
            <button onClick={() => router.push(sourceHref(courseId, s))}
              className={`w-full rounded-lg border px-3 py-2 text-left hover:bg-muted ${focused === s.n ? "border-accent" : "border-border"}`}>
              <span className="block text-xs font-medium">
                <span className="text-accent">[{s.n}]</span> {s.label}
                <span className="ml-1 font-normal text-fg-2">{s.kind === "note" ? "· your notes" : "· course material"}</span>
              </span>
              <span className="mt-1 line-clamp-3 block text-xs text-fg-2">{s.excerpt}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SearchTab({ courseId, courseName }: { courseId: string; courseName: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<{ hits: Hit[] }>(`/api/courses/${courseId}/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => { setHits(r.hits); setError(null); })
        .catch((e) => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Search failed"); });
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, courseId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-4">
        <input autoFocus className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${courseName}…`} aria-label="Search course" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {hits && hits.length === 0 && <p className="text-sm text-fg-2">Nothing found in this course.</p>}
        <ul className="space-y-2">
          {hits?.map((h) => (
            <li key={h.id}>
              <button className="w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-muted"
                onClick={() => router.push(sourceHref(courseId, { lectureId: h.lecture_id, materialId: h.material_id, pageNo: h.page_no, section: h.section }))}>
                <span className="block text-xs font-medium">{h.label}</span>
                {h.section && <span className="block text-sm">{h.section}</span>}
                <span className="mt-0.5 line-clamp-3 block text-xs text-fg-2">{h.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
