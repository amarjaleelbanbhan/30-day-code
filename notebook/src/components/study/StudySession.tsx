"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isTyping } from "@/lib/client";
import type { Source } from "@/lib/context";
import type { sessionView } from "@/lib/study/engine";
import { QTYPE_LABEL, VERDICT_LABEL, type EvidenceRef, type Verdict } from "@/lib/study/types";
import { SourcePreview, sourceHref } from "../AskPanel";
import type { Shape } from "../editor/Sketch";
import { Markdown } from "../Markdown";
import { startStudy } from "./start";
import { StudyCanvas } from "./StudyCanvas";

type View = NonNullable<Awaited<ReturnType<typeof sessionView>>>;
type Item = View["items"][number];
type Result = NonNullable<Item["result"]>;

const KIND_LABEL: Record<string, string> = { practice: "Study", master: "Master", weak: "Weak areas", review: "Review", quick: "Quick revision", exam: "Exam practice" };
const VERDICT_STYLE: Record<Verdict, string> = {
  correct: "border-green-600/40 bg-green-600/10 text-green-800 dark:text-green-300",
  mostly: "border-green-600/30 bg-green-600/5 text-green-800 dark:text-green-300",
  partial: "border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  incorrect: "border-red-600/40 bg-red-600/10 text-red-800 dark:text-red-300",
  dont_know: "border-border bg-muted text-fg-2",
};

const toSource = (e: EvidenceRef): Source => ({
  n: e.n, label: e.label, kind: e.kind, contentType: e.contentType, lectureId: e.lectureId, lectureNumber: e.lectureNumber, lectureTitle: null,
  materialId: e.materialId, noteId: e.noteId, filename: null, pageNo: e.pageNo, slideNo: e.pageNo, section: null, anchor: e.anchor,
  excerpt: e.excerpt, chunkIds: [e.chunkId], methods: [], score: 0, role: "evidence", alsoIn: [],
});

export function StudySession({ course, sessionId }: { course: { id: string; name: string }; sessionId: string }) {
  const router = useRouter();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [examIdx, setExamIdx] = useState(0);

  const load = useCallback(async () => {
    try { setV(await api<View>(`/api/study/${sessionId}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load session"); }
  }, [sessionId]);
  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); return null; }
    finally { setBusy(null); }
  }, []);

  const next = useCallback(async () => {
    const r = await act("next", () => api<{ itemId?: string; done?: boolean }>(`/api/study/${sessionId}/next`, { method: "POST" }));
    if (r?.done) await act("finish", () => api(`/api/study/${sessionId}/finish`, { method: "POST" }));
    await load();
  }, [act, load, sessionId]);

  const finish = useCallback(async () => {
    if (v?.kind === "exam" && !confirm("Submit the exam? You can't change answers afterwards.")) return;
    await act("finish", () => api(`/api/study/${sessionId}/finish`, { method: "POST" }));
    await load();
  }, [act, load, sessionId, v?.kind]);

  if (error && !v) return <p className="p-8 text-sm text-danger">{error}</p>;
  if (!v) return <p className="p-8 text-sm text-fg-2">Loading…</p>;

  const answered = v.items.filter((i) => i.result).length;
  const label = v.scope.label && v.scope.label !== KIND_LABEL[v.kind] ? `${KIND_LABEL[v.kind]} · ${v.scope.label}` : KIND_LABEL[v.kind];
  const done = v.status !== "active";

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-bg/95 px-4 text-sm backdrop-blur">
        <Link href={`/c/${course.id}/study`} className="text-fg-2 hover:text-fg">← Study</Link>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {!done && v.kind === "exam" && v.deadlineAt && <Countdown deadline={v.deadlineAt} onExpire={load} />}
        {!done && <span className="text-xs text-fg-2 tabular-nums">{v.kind === "exam" ? `${v.items.length} / ${v.target}` : v.kind === "master" ? `${answered} answered` : `${Math.min(answered + 1, v.target)} / ${v.target}`}</span>}
        {!done && <button className="btn btn-ghost h-8 text-xs" onClick={finish} disabled={!!busy}>{v.kind === "exam" ? "Submit exam" : "End session"}</button>}
      </header>
      <main className="mx-auto max-w-2xl px-5 py-8">
        {!v.capability.llm && !done && (
          <p className="mb-4 text-xs text-fg-2">Questions and grading are built directly from your material (no AI model configured): open questions are checked against the key points your slides state.</p>
        )}
        {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
        {done ? (
          <SessionSummary v={v} course={course} onRestart={async (conceptId, name) => { const url = await startStudy(course.id, { kind: "practice", scope: { type: "concept", conceptIds: [conceptId], label: name }, config: { count: 5 } }); router.push(url); }} />
        ) : v.kind === "exam" ? (
          <ExamView v={v} idx={Math.min(examIdx, v.items.length - 1)} setIdx={setExamIdx} sessionId={sessionId} busy={busy} act={act} reload={load} next={next} finish={finish} />
        ) : (
          <PracticeView v={v} sessionId={sessionId} courseId={course.id} busy={busy} act={act} reload={load} next={next} />
        )}
      </main>
    </div>
  );
}

type Act = <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;

function PracticeView({ v, sessionId, courseId, busy, act, reload, next }: { v: View; sessionId: string; courseId: string; busy: string | null; act: Act; reload: () => Promise<void>; next: () => Promise<void> }) {
  const open = v.items.find((i) => !i.result);
  const last = [...v.items].reverse().find((i) => i.result);
  const [showFeedbackOf, setShowFeedbackOf] = useState<string | null>(null);
  // After answering, show that item's feedback until the student moves on.
  const item = showFeedbackOf ? v.items.find((i) => i.itemId === showFeedbackOf)! : open ?? last!;
  const goNext = useCallback(async () => { setShowFeedbackOf(null); if (!open) await next(); }, [next, open]);
  if (!item) return <p className="text-sm text-fg-2">No question yet.</p>;
  return (
    <QuestionCard key={item.itemId} item={item} sessionId={sessionId} courseId={courseId} exam={false} busy={busy} act={act}
      onAnswered={async () => { setShowFeedbackOf(item.itemId); await reload(); }} onNext={goNext} />
  );
}

function ExamView({ v, idx, setIdx, sessionId, busy, act, reload, next, finish }: { v: View; idx: number; setIdx: (n: number) => void; sessionId: string; busy: string | null; act: Act; reload: () => Promise<void>; next: () => Promise<void>; finish: () => Promise<void> }) {
  const item = v.items[idx]!;
  const isLast = idx === v.items.length - 1;
  const more = v.items.length < v.target;
  return (
    <div>
      <nav aria-label="Questions" className="mb-5 flex flex-wrap gap-1.5">
        {v.items.map((it, i) => (
          <button key={it.itemId} onClick={() => setIdx(i)} aria-current={i === idx}
            className={`h-8 w-8 rounded-md border text-xs tabular-nums ${i === idx ? "border-accent" : "border-border"} ${it.draft ? "bg-muted" : ""}`}>{i + 1}</button>
        ))}
      </nav>
      <QuestionCard key={item.itemId} item={item} sessionId={sessionId} courseId={v.courseId} exam busy={busy} act={act}
        onAnswered={async () => {
          await reload();
          if (isLast && more) { await next(); setIdx(idx + 1); }
          else if (!isLast) setIdx(idx + 1);
        }} onNext={async () => {}} />
      <div className="mt-6 flex items-center justify-between border-t border-border pt-4 text-xs text-fg-2">
        <span>Answers stay editable until you submit. No feedback is shown during the exam.</span>
        {isLast && !more && <button className="btn btn-primary h-8" onClick={finish} disabled={!!busy}>Submit exam</button>}
      </div>
    </div>
  );
}

function QuestionCard({ item, sessionId, courseId, exam, busy, act, onAnswered, onNext }: {
  item: Item; sessionId: string; courseId: string; exam: boolean; busy: string | null; act: Act; onAnswered: () => Promise<void>; onNext: () => Promise<void>;
}) {
  const draft = item.draft as { answer?: string; drawing?: { shapes?: Shape[] }; revealed?: boolean } | null;
  const [text, setText] = useState(exam ? draft?.answer ?? "" : "");
  const [choice, setChoice] = useState<string | null>(exam ? draft?.answer ?? null : null);
  const [shapes, setShapes] = useState<Shape[]>(draft?.drawing?.shapes ?? []);
  const [hints, setHints] = useState<string[]>(item.hints);
  const [checklist, setChecklist] = useState<{ id: string; text: string }[] | null>(item.checklist);
  const [ticked, setTicked] = useState<string[]>([]);
  const started = useRef(Date.now());
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const r = item.result;
  const isChoice = !!item.options?.length;

  const submit = useCallback(async (opts: { dontKnow?: boolean } = {}) => {
    if (r) return;
    const body = item.qtype === "diagram" && !opts.dontKnow
      ? checklist ? { selfCheck: ticked } : { drawing: { shapes }, answer: text }
      : { answer: isChoice ? choice ?? "" : text, dontKnow: opts.dontKnow, durationMs: Date.now() - started.current };
    if (!opts.dontKnow && !exam && item.qtype !== "diagram" && !(isChoice ? choice : text.trim())) return;
    const res = await act("answer", () => api<{ checklist?: { id: string; text: string }[] }>(`/api/study/${sessionId}/items/${item.itemId}/answer`, { method: "POST", json: body }));
    if (res?.checklist) { setChecklist(res.checklist); return; }
    if (res) await onAnswered();
  }, [act, checklist, choice, exam, isChoice, item.itemId, item.qtype, onAnswered, r, sessionId, shapes, text, ticked]);

  const hint = useCallback(async () => {
    const res = await act("hint", () => api<{ hints: string[] }>(`/api/study/${sessionId}/items/${item.itemId}/hint`, { method: "POST" }));
    if (res) setHints(res.hints);
  }, [act, item.itemId, sessionId]);

  // Keyboard: 1–4 / T,F choose; Enter submits a choice; H hint; I "I don't know"; N next (after feedback). Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (r) { if (k === "n" || k === "enter") { e.preventDefault(); void onNext(); } return; }
      if (isChoice) {
        const opt = item.options!.find((o, i) => o.key.toLowerCase() === k || String(i + 1) === k);
        if (opt) { e.preventDefault(); setChoice(opt.key); return; }
        if (k === "enter" && choice) { e.preventDefault(); void submit(); return; }
      }
      if (!exam && k === "h" && hints.length < item.hintsAvailable) { e.preventDefault(); void hint(); }
      if (k === "i" && !exam) { e.preventDefault(); void submit({ dontKnow: true }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choice, exam, hint, hints.length, isChoice, item.hintsAvailable, item.options, onNext, r, submit]);

  useEffect(() => { if (!r && !isChoice && item.qtype !== "diagram") inputRef.current?.focus(); }, [r, isChoice, item.qtype]);

  return (
    <article>
      <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-2">
        <span>{item.conceptName}</span><span>·</span><span>{QTYPE_LABEL[item.qtype]}</span>
        {item.purpose !== "new" && <span className="rounded bg-muted px-1.5 py-0.5">{item.purpose === "retest" ? "Retest — asked differently" : "Quick check"}</span>}
      </p>
      <h2 className="whitespace-pre-wrap text-lg font-medium leading-relaxed">{item.prompt}</h2>

      {!r && (
        <div className="mt-5 space-y-3">
          {isChoice ? (
            <div role="radiogroup" aria-label="Options" className="space-y-2">
              {item.options!.map((o, i) => (
                <button key={o.key} role="radio" aria-checked={choice === o.key} onClick={() => setChoice(o.key)}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-[15px] ${choice === o.key ? "border-accent bg-accent-soft" : "border-border hover:bg-muted"}`}>
                  <span className="kbd mt-0.5 shrink-0">{item.qtype === "tf" ? o.key : i + 1}</span><span>{o.text}</span>
                </button>
              ))}
            </div>
          ) : item.qtype === "diagram" ? (
            <>
              <StudyCanvas value={shapes} onChange={setShapes} disabled={!!checklist} />
              {checklist && (
                <fieldset className="rounded-lg border border-border p-3">
                  <legend className="px-1 text-xs text-fg-2">Check your drawing against the course — tick what it contains (an AI can't see drawings here)</legend>
                  {checklist.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm">
                      <input type="checkbox" checked={ticked.includes(c.id)} onChange={() => setTicked((t) => (t.includes(c.id) ? t.filter((x) => x !== c.id) : [...t, c.id]))} />{c.text}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          ) : item.qtype === "fill" ? (
            <input ref={inputRef} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" aria-label="Your answer"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
          ) : (
            <textarea ref={inputRef} className="input min-h-32 leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer in your own words…" aria-label="Your answer"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} />
          )}
          {hints.length > 0 && (
            <ol className="space-y-1 rounded-lg bg-muted px-3 py-2 text-sm">
              {hints.map((h, i) => <li key={i}><span className="text-xs text-fg-2">Hint {i + 1}: </span>{h}</li>)}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={!!busy} onClick={() => submit()}>
              {busy === "answer" ? "Checking…" : exam ? "Save answer" : item.qtype === "diagram" ? (checklist ? "Save self-check" : "Submit drawing") : "Submit"}
            </button>
            {!exam && <button className="btn" disabled={!!busy || hints.length >= item.hintsAvailable} onClick={hint} title="H">Hint{item.hintsAvailable ? ` (${hints.length}/${item.hintsAvailable})` : ""}</button>}
            {!exam && <button className="btn btn-ghost" disabled={!!busy} onClick={() => submit({ dontKnow: true })} title="I">I don't know</button>}
            <span className="ml-auto text-xs text-fg-2">{isChoice ? "1–4 to choose, Enter to submit" : item.qtype === "fill" ? "Enter to submit" : item.qtype === "diagram" ? "" : "Ctrl+Enter to submit"}</span>
          </div>
        </div>
      )}

      {r && <Feedback item={item} r={r} sessionId={sessionId} courseId={courseId} act={act} busy={busy} onNext={onNext} />}
    </article>
  );
}

function Feedback({ item, r, sessionId, courseId, act, busy, onNext }: { item: Item; r: Result; sessionId: string; courseId: string; act: Act; busy: string | null; onNext?: () => Promise<void> }) {
  const [preview, setPreview] = useState<Source | null>(null);
  const [extra, setExtra] = useState<{ mode: "teach" | "why"; markdown: string } | null>(null);
  const got = r.points.filter((p) => p.status === "met");
  const missed = r.points.filter((p) => p.status !== "met");
  const isChoice = !!r.options?.length;
  const chosen = isChoice ? r.options!.find((o) => o.key === r.answer.trim().toUpperCase().charAt(0)) : null;
  const explain = async (mode: "teach" | "why") => {
    const res = await act(mode, () => api<{ markdown: string }>(`/api/study/${sessionId}/items/${item.itemId}/explain`, { method: "POST", json: { mode } }));
    if (res) setExtra({ mode, markdown: res.markdown });
  };
  const sources = useMemo(() => r.evidence.map(toSource), [r.evidence]);
  return (
    <section aria-label="Feedback" className="mt-5 space-y-4">
      <div className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm font-medium ${VERDICT_STYLE[r.verdict]}`}>
        {VERDICT_LABEL[r.verdict]}{r.hintsUsed > 0 && <span className="font-normal opacity-80">· with {r.hintsUsed} hint{r.hintsUsed > 1 ? "s" : ""}</span>}
      </div>
      {r.verdict !== "dont_know" && (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-2">Your answer</h3>
          {r.drawing ? <p className="text-sm text-fg-2">(drawing — self-checked)</p> : <p className="whitespace-pre-wrap text-[15px]">{chosen ? `${chosen.key}. ${chosen.text}` : r.answer}</p>}
        </div>
      )}
      {!isChoice && r.points.length > 1 && got.length > 0 && (
        <div><h3 className="text-xs font-medium uppercase tracking-wide text-fg-2">What you got right</h3><ul className="list-disc pl-5 text-sm">{got.map((p) => <li key={p.id}>{p.text}</li>)}</ul></div>
      )}
      {!isChoice && missed.length > 0 && r.verdict !== "dont_know" && (
        <div><h3 className="text-xs font-medium uppercase tracking-wide text-fg-2">What you missed</h3><ul className="list-disc pl-5 text-sm">{missed.map((p) => <li key={p.id}>{p.text}{p.status === "partial" ? " (only partly)" : ""}</li>)}</ul></div>
      )}
      {r.misconceptions.length > 0 && (
        <div className="rounded-lg border border-red-600/30 bg-red-600/5 px-3 py-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-red-800 dark:text-red-300">Misconception</h3>
          <ul className="text-sm">{r.misconceptions.map((m, i) => <li key={i}>{m.correction}</li>)}</ul>
        </div>
      )}
      <div><h3 className="text-xs font-medium uppercase tracking-wide text-fg-2">Correct answer</h3><p className="text-[15px]">{r.modelAnswer}</p></div>
      {r.explanation && <div><h3 className="text-xs font-medium uppercase tracking-wide text-fg-2">Why</h3><p className="text-sm text-fg-2">{r.explanation}</p></div>}
      <div>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-2">Sources</h3>
        <ul className="space-y-1">
          {sources.map((s) => (
            <li key={s.n} className="flex items-center gap-2 text-sm">
              <button className="text-left text-accent hover:underline" onClick={() => setPreview(preview?.n === s.n ? null : s)}>{s.label}</button>
              <Link className="text-xs text-fg-2 hover:text-fg" href={sourceHref(courseId, s)}>open</Link>
            </li>
          ))}
        </ul>
        {preview && <div className="mt-2"><SourcePreview courseId={courseId} source={preview} onClose={() => setPreview(null)} /></div>}
      </div>
      {extra && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-2">{extra.mode === "why" ? "Why your answer was marked this way" : "Explanation"}</h3>
          <Markdown text={extra.markdown} onCite={(n) => setPreview(sources.find((s) => s.n === n) ?? null)} />
          {extra.mode === "teach" && <p className="mt-2 text-xs text-fg-2">A quick check on this will come next, and the concept returns later in a different form.</p>}
        </div>
      )}
      {onNext && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button className="btn btn-primary" onClick={() => onNext()} disabled={!!busy} title="N">{busy === "next" ? "Preparing…" : "Next question"}</button>
          {r.verdict !== "correct" && !extra && <button className="btn" onClick={() => explain("teach")} disabled={!!busy}>Explain this</button>}
          {r.verdict !== "correct" && r.verdict !== "dont_know" && extra?.mode !== "why" && <button className="btn btn-ghost" onClick={() => explain("why")} disabled={!!busy}>Why was my answer wrong?</button>}
        </div>
      )}
    </section>
  );
}

function Countdown({ deadline, onExpire }: { deadline: string | Date; onExpire: () => void }) {
  const end = new Date(deadline).getTime();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, end - now);
  useEffect(() => { if (left === 0) onExpire(); }, [left, onExpire]);
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  return <span className={`text-xs tabular-nums ${left < 60000 ? "text-danger" : "text-fg-2"}`} role="timer">{m}:{String(s).padStart(2, "0")}</span>;
}

function SessionSummary({ v, course, onRestart }: { v: View; course: { id: string; name: string }; onRestart: (conceptId: string, name: string) => Promise<void> }) {
  const s = v.summary as { total: number; breakdown: Record<Verdict, number>; strong: { conceptId: string; name: string }[]; needsWork: { conceptId: string; name: string; why: string }[];
    recognizedOnly: { conceptId: string; name: string }[]; misconceptions: { concept: string; correction: string }[]; byType: { qtype: keyof typeof QTYPE_LABEL; n: number; ok: number }[]; recommended: string[] } | null;
  const [open, setOpen] = useState<string | null>(null);
  if (!s) return <p className="text-sm text-fg-2">Session ended.</p>;
  const right = s.breakdown.correct + s.breakdown.mostly;
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{v.kind === "exam" ? "Exam results" : "Session complete"}</h1>
        <p className="mt-1 text-sm text-fg-2">{right} of {s.total} answered well · {s.breakdown.partial} partly · {s.breakdown.incorrect + s.breakdown.dont_know} missed</p>
        <div className="mt-3 flex h-2 overflow-hidden rounded bg-muted" role="img" aria-label="Result breakdown">
          {(["correct", "mostly", "partial", "incorrect", "dont_know"] as Verdict[]).map((k) => s.breakdown[k] ? <span key={k} style={{ width: `${(s.breakdown[k] / s.total) * 100}%` }} className={k === "correct" ? "bg-green-600" : k === "mostly" ? "bg-green-500/60" : k === "partial" ? "bg-amber-500" : k === "incorrect" ? "bg-red-600" : "bg-fg-2/30"} /> : null)}
        </div>
      </header>
      <div className="grid gap-6 sm:grid-cols-2">
        {s.strong.length > 0 && <SummaryList title="Strong" items={s.strong.map((x) => ({ key: x.conceptId, text: x.name }))} />}
        {s.needsWork.length > 0 && <SummaryList title="Needs work" items={s.needsWork.map((x) => ({ key: x.conceptId, text: `${x.name} — ${x.why}`, action: () => onRestart(x.conceptId, x.name) }))} />}
        {s.recognizedOnly.length > 0 && <SummaryList title="Recognised but not recalled" items={s.recognizedOnly.map((x) => ({ key: x.conceptId, text: `${x.name} — right with options, missed in your own words` }))} />}
        {s.misconceptions.length > 0 && <SummaryList title="Misconceptions" items={s.misconceptions.map((m, i) => ({ key: String(i), text: `${m.concept}: ${m.correction}` }))} />}
      </div>
      {s.byType.length > 1 && (
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">By question type</h2>
          <ul className="flex flex-wrap gap-2 text-xs">{s.byType.map((t) => <li key={t.qtype} className="rounded-md border border-border px-2 py-1">{QTYPE_LABEL[t.qtype]} {t.ok}/{t.n}</li>)}</ul>
        </section>
      )}
      {s.recommended.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Recommended next</h2>
          <ul className="list-disc pl-5 text-sm">{s.recommended.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <Link href={`/c/${course.id}/study`} className="btn mt-3">Back to Study</Link>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Review</h2>
        <ol className="space-y-2">
          {v.items.filter((i) => i.result).map((it, i) => (
            <li key={it.itemId} className="rounded-lg border border-border">
              <button className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm" onClick={() => setOpen(open === it.itemId ? null : it.itemId)} aria-expanded={open === it.itemId}>
                <span className="min-w-0"><span className="text-fg-2">{i + 1}.</span> {it.prompt.split("\n")[0]}</span>
                <span className={`shrink-0 rounded border px-1.5 text-xs ${VERDICT_STYLE[it.result!.verdict]}`}>{VERDICT_LABEL[it.result!.verdict]}</span>
              </button>
              {open === it.itemId && <div className="border-t border-border px-3 pb-3">{it.prompt.includes("\n") && <p className="whitespace-pre-wrap pt-3 text-sm">{it.prompt.split("\n").slice(1).join("\n")}</p>}<Feedback item={it} r={it.result!} sessionId={v.id} courseId={course.id} act={async (_k, fn) => fn().catch(() => null)} busy={null} /></div>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function SummaryList({ title, items }: { title: string; items: { key: string; text: string; action?: () => void }[] }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">{title}</h2>
      <ul className="space-y-1 text-sm">
        {items.map((x) => (
          <li key={x.key} className="flex items-start justify-between gap-2">
            <span>{x.text}</span>
            {x.action && <button className="shrink-0 text-xs text-accent hover:underline" onClick={x.action}>Study again</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
