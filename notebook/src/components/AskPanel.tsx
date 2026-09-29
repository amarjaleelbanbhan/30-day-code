"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AskResult, Source } from "@/lib/rag";
import { Markdown } from "./Markdown";

export type PanelTab = "ask" | "search";

type Hit = { chunk_id: string; label: string; content: string; section: string | null; lecture_id: string | null; material_id: string | null; page_no: number | null; anchor: string | null; source_type: string };

/** URL that opens the exact source: the slide/page in the lecture's material panel, or the note block (highlighted). */
export function sourceHref(courseId: string, s: { lectureId: string | null; materialId: string | null; pageNo: number | null; anchor?: string | null; section?: string | null }): string {
  const qs = new URLSearchParams();
  if (s.materialId) {
    qs.set("m", s.materialId);
    if (s.pageNo != null) qs.set("p", String(s.pageNo));
  } else if (s.anchor) qs.set("hl", s.anchor);
  else if (s.section) qs.set("section", s.section);
  if (s.lectureId) return `/c/${courseId}/l/${s.lectureId}?${qs}`;
  if (s.materialId) return `/c/${courseId}/m/${s.materialId}?${qs}`;
  return `/c/${courseId}`;
}

type Props = {
  courseId: string;
  courseName: string;
  lectureId?: string;
  lectureNumber?: number | null;
  tab: PanelTab;
  initialQuestion?: string | null;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onInsert?: (markdown: string) => void;
  onExplainSelection?: () => void;
  onQuiz?: () => void;
};

export function AskPanel(props: Props) {
  const { tab, onTab, onClose } = props;
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
      {tab === "ask" ? <AskTab {...props} /> : <SearchTab courseId={props.courseId} courseName={props.courseName} />}
    </aside>
  );
}

const MODE_KEY = "nb-answer-mode";

function AskTab({ courseId, courseName, lectureId, lectureNumber, initialQuestion, onInsert, onExplainSelection, onQuiz }: Props) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [courseOnly, setCourseOnly] = useState(true);
  const [result, setResult] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Source | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastAsked = useRef<string | null>(null);

  useEffect(() => {
    try { setCourseOnly(localStorage.getItem(MODE_KEY) !== "explain"); } catch {}
  }, []);

  async function run(q: string, only = courseOnly) {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setResult(await api<AskResult>(`/api/courses/${courseId}/ask`, { method: "POST", json: { question: q, lectureId, mode: only ? "course" : "explain" } }));
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

  const chips: [string, () => void][] = [
    ...(lectureNumber != null ? [[`Recall this lecture`, () => { setQuestion(`Recall lecture ${lectureNumber}`); void run(`Recall lecture ${lectureNumber}`); }] as [string, () => void]] : []),
    ["Recall entire course", () => { setQuestion("Recall the whole course"); void run("Recall the whole course"); }],
    ["Find a concept", () => router.push(`/c/${courseId}/concepts`)],
    ...(onExplainSelection ? [["Explain selected text", onExplainSelection] as [string, () => void]] : []),
    ...(onQuiz ? [["Quiz me on this lecture", onQuiz] as [string, () => void]] : []),
  ];

  const bySource = useMemo(() => new Map(result?.sources.map((s) => [s.n, s]) ?? []), [result]);
  const cite = (n: number) => setPreview(bySource.get(n) ?? null);
  const openLecture = (n: number) => {
    const id = result?.outline?.find((o) => o.label.startsWith(`Lecture ${String(n).padStart(2, "0")}`))?.lectureId;
    if (id) router.push(`/c/${courseId}/l/${id}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form className="border-b border-border p-4" onSubmit={(e) => { e.preventDefault(); void run(question); }}>
        <textarea ref={ref} className="input resize-none" rows={2} value={question} placeholder={`Ask ${courseName}…`}
          aria-label={`Ask ${courseName}`} onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(question); } }} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-2" title="When on, answers use only your uploaded course material and notes.">
            <input type="checkbox" checked={courseOnly} onChange={(e) => {
              setCourseOnly(e.target.checked);
              try { localStorage.setItem(MODE_KEY, e.target.checked ? "course" : "explain"); } catch {}
            }} />
            Course sources only
          </label>
          <button className="btn h-7 px-3 text-xs" disabled={busy || !question.trim()}>Ask</button>
        </div>
        {!result && !busy && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {chips.map(([label, fn]) => (
              <button type="button" key={label} className="rounded-md border border-border px-2 py-1 text-fg-2 hover:bg-muted" onClick={fn}>{label}</button>
            ))}
          </div>
        )}
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
        {busy && <p className="text-sm text-fg-2">Searching your course…</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!busy && result && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold">{result.title}</h2>
            {result.aiError && <p className="text-xs text-fg-2">{result.aiError}</p>}

            {result.notFound ? (
              <div className="rounded-lg border border-border px-3 py-2.5 text-sm">
                <p>{result.answer}</p>
                {!!result.missingTerms?.length && <p className="mt-1 text-xs text-fg-2">No passage in your course mentions: {result.missingTerms.join(", ")}</p>}
                {courseOnly && <button className="mt-2 text-xs underline underline-offset-2" onClick={() => { setCourseOnly(false); void run(question, false); }}>Explain it from general knowledge instead</button>}
              </div>
            ) : result.answer && (
              <section aria-label="From your course">
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-2">
                  {result.mode === "answer" ? "From your course" : "Evidence from your course"}
                </h3>
                <Markdown text={result.answer} onCite={cite} onLecture={openLecture} />
                {result.mode === "retrieval" && !result.aiError && result.intent !== "source_lookup" && (
                  <p className="mt-2 text-xs text-fg-2">No AI model is configured, so this is assembled directly from your material.</p>
                )}
                {result.uncited && <p className="mt-2 text-xs text-danger">This answer has no citations — check it against the sources below.</p>}
              </section>
            )}

            {result.extra && (
              <section aria-label="Additional explanation" className="rounded-lg border border-dashed border-border bg-muted/50 px-3 py-2.5">
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-2">Additional explanation · general knowledge, not from your course</h3>
                <Markdown text={result.extra} />
              </section>
            )}

            {preview && <SourcePreview courseId={courseId} source={preview} onClose={() => setPreview(null)} />}

            {result.answer && onInsert && result.mode === "answer" && !result.notFound && (
              <button className="btn h-8 text-xs" onClick={() => onInsert(result.answer!.replace(/\[(\d{1,3})\]/g, (m, n: string) => { const s = bySource.get(Number(n)); return s ? ` (${s.label})` : ""; }))}>Insert into notes</button>
            )}
            {result.groups && result.groups.length > 0 && <Groups groups={result.groups} onPick={cite} active={preview?.n ?? null} />}
            {result.outline && <OutlineView courseId={courseId} outline={result.outline} />}
            {result.concepts && result.concepts.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Recurring concepts</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.concepts.map((c) => (
                    <Link key={c.id} href={`/c/${courseId}/concepts/${c.id}`} className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted">{c.name} <span className="text-fg-2">{c.lectures}</span></Link>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Groups({ groups, onPick, active }: { groups: NonNullable<AskResult["groups"]>; onPick: (n: number) => void; active: number | null }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Where it appears</h3>
      <ol className="space-y-3">
        {groups.map((g) => (
          <li key={g.key}>
            <p className="text-sm font-medium">{g.label}</p>
            <ul className="mt-1 space-y-1">
              {g.items.map((it) => (
                <li key={it.n}>
                  <button onClick={() => onPick(it.n)} className={`w-full rounded-md border px-2.5 py-1.5 text-left hover:bg-muted ${active === it.n ? "border-accent" : "border-border"}`}>
                    <span className="block text-xs"><span className="text-accent">[{it.n}]</span> {it.label.replace(/^Lecture \d+ · /, "")} <span className="text-fg-2">· {it.kind}</span></span>
                    <span className="line-clamp-2 block text-xs text-fg-2">{it.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Page = { page_no: number; title: string | null; body: string; speaker_notes: string | null };

/** Inline verification: shows the cited slide/page (with neighbours) or note excerpt, matching text highlighted. */
function SourcePreview({ courseId, source, onClose }: { courseId: string; source: Source; onClose: () => void }) {
  const router = useRouter();
  const [pages, setPages] = useState<Page[] | null>(null);
  const [page, setPage] = useState(source.pageNo ?? 1);
  useEffect(() => {
    setPage(source.pageNo ?? 1);
    setPages(null);
    if (!source.materialId) return;
    api<{ pages: Page[] }>(`/api/materials/${source.materialId}`).then((r) => setPages(r.pages)).catch(() => setPages([]));
  }, [source]);
  const cur = pages?.find((p) => p.page_no === page);
  const unit = source.contentType === "slide" || source.contentType === "speaker_notes" ? "Slide" : "Page";
  const onCited = page === source.pageNo;
  return (
    <section aria-label="Source preview" className="rounded-lg border border-accent bg-bg p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium"><span className="text-accent">[{source.n}]</span> {source.materialId ? source.label.replace(/Slide \d+|Page \d+/, `${unit} ${page}`) : source.label}</p>
        <button className="text-xs text-fg-2 hover:text-fg" onClick={onClose} aria-label="Close preview">✕</button>
      </div>
      {source.materialId ? (
        !pages ? <p className="text-xs text-fg-2">Loading…</p> : !cur ? <p className="text-xs text-fg-2">This page is no longer available.</p> : (
          <div className="max-h-72 overflow-y-auto text-sm leading-relaxed">
            {cur.title && <p className="mb-1 font-medium">{cur.title}</p>}
            <p className="whitespace-pre-wrap">{onCited && source.contentType !== "speaker_notes" ? <Highlight text={cur.body} excerpt={source.excerpt} /> : cur.body}</p>
            {cur.speaker_notes && (
              <p className="mt-2 whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                <span className="font-medium">Speaker notes: </span>
                {onCited && source.contentType === "speaker_notes" ? <mark className="rounded bg-[var(--highlight)] text-inherit">{cur.speaker_notes}</mark> : cur.speaker_notes}
              </p>
            )}
          </div>
        )
      ) : (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm"><mark className="rounded bg-[var(--highlight)] text-inherit">{source.excerpt}</mark></p>
      )}
      <div className="mt-2 flex items-center gap-1 text-xs">
        {source.materialId && (
          <>
            <button className="btn btn-ghost h-7 px-2" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={`Previous ${unit.toLowerCase()}`}>‹ Prev</button>
            <button className="btn btn-ghost h-7 px-2" disabled={!pages || page >= pages.length} onClick={() => setPage((p) => p + 1)} aria-label={`Next ${unit.toLowerCase()}`}>Next ›</button>
          </>
        )}
        <span className="flex-1" />
        <button className="btn h-7 px-2" onClick={() => router.push(sourceHref(courseId, { ...source, pageNo: page }))}>Open</button>
      </div>
      {source.alsoIn.length > 0 && <p className="mt-1 text-xs text-fg-2">Same text also in: {source.alsoIn.join("; ")}</p>}
    </section>
  );
}

/** Highlights the lines of `text` that belong to the cited excerpt. */
function Highlight({ text, excerpt }: { text: string; excerpt: string }) {
  const lines = new Set(excerpt.split("\n").map((l) => l.trim()).filter((l) => l.length > 3));
  return <>{text.split("\n").map((l, i) => (
    <span key={i}>{i > 0 && "\n"}{lines.has(l.trim()) ? <mark className="rounded bg-[var(--highlight)] text-inherit">{l}</mark> : l}</span>
  ))}</>;
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

function SearchTab({ courseId, courseName }: { courseId: string; courseName: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ hits: Hit[]; corrections: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setRes(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<{ hits: Hit[]; corrections: Record<string, string> }>(`/api/courses/${courseId}/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => { setRes(r); setError(null); })
        .catch((e) => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Search failed"); });
    }, 200);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, courseId]);

  const fixes = Object.entries(res?.corrections ?? {});
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-4">
        <input autoFocus className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${courseName}…`} aria-label="Search course" />
        {fixes.length > 0 && <p className="mt-1.5 text-xs text-fg-2">Also searched: {fixes.map(([a, b]) => `${b} (for “${a}”)`).join(", ")}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {res && res.hits.length === 0 && <p className="text-sm text-fg-2">Nothing found in this course.</p>}
        <ul className="space-y-2">
          {res?.hits.map((h) => (
            <li key={h.chunk_id}>
              <button className="w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-muted"
                onClick={() => router.push(sourceHref(courseId, { lectureId: h.lecture_id, materialId: h.material_id, pageNo: h.page_no, anchor: h.anchor, section: h.section }))}>
                <span className="block text-xs font-medium">{h.label}</span>
                {h.section && <span className="block text-sm">{h.section}</span>}
                <span className="mt-0.5 line-clamp-3 block text-xs text-fg-2">{h.content}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
