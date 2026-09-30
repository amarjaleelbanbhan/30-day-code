"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { pad2, timeAgo } from "@/lib/client";
import type { overview as Overview } from "@/lib/study/engine";
import { QTYPE_LABEL, type QType } from "@/lib/study/types";
import { useRegisterCommands, type Command } from "../commands";
import { ThemeToggle } from "../ThemeToggle";
import { startStudy, type StartOpts } from "./start";

type O = NonNullable<Awaited<ReturnType<typeof Overview>>>;
type Lecture = { id: string; number: number | null; title: string };

const KIND_LABEL: Record<string, string> = { practice: "Study", master: "Master", weak: "Weak areas", review: "Review", quick: "Quick revision", exam: "Exam practice" };
const STATE_COLOR: Record<string, string> = {
  mastered: "var(--accent)", strong: "color-mix(in srgb, var(--accent) 60%, transparent)", learning: "color-mix(in srgb, var(--text-2) 45%, transparent)",
  needs_review: "#d9822b", not_started: "var(--border)",
};

export function StudyHub({ course, overview: o, lectures }: { course: { id: string; name: string }; overview: O; lectures: Lecture[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<false | "practice" | "exam">(false);

  async function go(key: string, opts: StartOpts) {
    setBusy(key);
    setError(null);
    try { router.push(await startStudy(course.id, opts)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start"); setBusy(null); }
  }
  const active = o.sessions.filter((s) => s.status === "active");
  const done = o.sessions.filter((s) => s.status === "completed");
  const { tested, concepts: total } = o.totals;

  const commands = useMemo<Command[]>(() => [
    { id: "study-course", label: "Study course", run: () => go("course", { kind: "practice", scope: { type: "course", label: course.name } }) },
    { id: "study-weak", label: "Study weak areas", run: () => go("weak", { kind: "weak", scope: { type: "weak", label: "Weak areas" } }) },
    { id: "exam", label: "Exam practice", run: () => setCustom("exam") },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [course.id]);
  useRegisterCommands("study-hub", commands);

  return (
    <main className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
      <nav className="mb-6 flex items-center justify-between text-sm text-fg-2">
        <Link href={`/c/${course.id}`} className="hover:text-fg">← {course.name}</Link>
        <ThemeToggle />
      </nav>
      <h1 className="text-2xl font-semibold tracking-tight">Study</h1>
      <p className="mt-1 text-sm text-fg-2">
        {total ? `${tested} of ${total} key concepts practised.` : "No concepts yet — upload or write lecture material first."}
        {!o.capability.llm && " Questions and grading come straight from your material (no AI model configured)."}
      </p>

      {active.length > 0 && (
        <section className="mt-6 rounded-xl border border-accent bg-accent-soft/40 p-4">
          {active.slice(0, 2).map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3">
              <span className="text-sm"><b>{KIND_LABEL[s.kind]}</b> · {s.scope.label ?? s.scope.type} · {s.answered} answered · started {timeAgo(s.started_at)}</span>
              <Link className="btn btn-primary h-8" href={`/c/${course.id}/study/${s.id}`}>Resume</Link>
            </div>
          ))}
        </section>
      )}

      <section className="mt-6 grid gap-2 sm:grid-cols-2">
        <StartButton label="Study the course" sub="Mixed questions, adaptive" busy={busy === "course"} onClick={() => go("course", { kind: "practice", scope: { type: "course", label: course.name } })} />
        <StartButton label={`Study weak areas${o.weak.length ? ` (${o.weak.filter((w) => w.state !== "not_started").length})` : ""}`} sub="Misconceptions and misses first" busy={busy === "weak"}
          disabled={!o.weak.some((w) => w.state !== "not_started")} onClick={() => go("weak", { kind: "weak", scope: { type: "weak", label: "Weak areas" } })} />
        <StartButton label={`Review due${o.due.length ? ` (${o.due.length})` : ""}`} sub="Spaced review of concepts due today" busy={busy === "due"} disabled={!o.due.length}
          onClick={() => go("due", { kind: "review", scope: { type: "due", label: "Due for review" } })} />
        <StartButton label="Quick revision" sub="5 questions across the course" busy={busy === "quick"} onClick={() => go("quick", { kind: "quick", scope: { type: "course", label: "Whole course" } })} />
        <StartButton label="Exam practice" sub="No feedback until you submit" busy={busy === "exam"} onClick={() => setCustom("exam")} />
        <StartButton label="Choose lectures, types…" sub="Custom session" onClick={() => setCustom((c) => (c === "practice" ? false : "practice"))} />
      </section>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {custom && <CustomSetup key={custom} initialKind={custom} lectures={lectures} busy={!!busy} onStart={(opts) => go("custom", opts)} />}

      {o.weak.filter((w) => w.state !== "not_started").length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Needs work</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {o.weak.filter((w) => w.state !== "not_started").slice(0, 6).map((w) => (
              <li key={w.conceptId} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/c/${course.id}/concepts/${w.conceptId}`} className="text-[15px] font-medium hover:underline">{w.name}</Link>
                  <ul className="mt-0.5 text-xs text-fg-2">{w.reasons.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
                <button className="btn h-8 shrink-0 text-xs" onClick={() => go(`c-${w.conceptId}`, { kind: "practice", scope: { type: "concept", conceptIds: [w.conceptId], label: w.name }, config: { count: 5 } })}>Practise</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Coverage by lecture</h2>
        <ul className="space-y-2">
          {o.coverage.map((c) => (
            <li key={c.lectureId} className="rounded-lg border border-border bg-surface px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm"><span className="tabular-nums text-fg-2">{pad2(c.number)}</span> {c.title || "Untitled"}</span>
                <span className="flex shrink-0 gap-1">
                  <button className="btn btn-ghost h-7 px-2 text-xs" disabled={!c.concepts} onClick={() => go(`l-${c.lectureId}`, { kind: "practice", scope: { type: "lecture", lectureIds: [c.lectureId], label: `Lecture ${pad2(c.number)}` } })}>Study</button>
                  <button className="btn btn-ghost h-7 px-2 text-xs" disabled={!c.concepts} onClick={() => go(`m-${c.lectureId}`, { kind: "master", scope: { type: "lecture", lectureIds: [c.lectureId], label: `Lecture ${pad2(c.number)}` } })}>Master</button>
                </span>
              </div>
              {c.concepts > 0 ? (
                <>
                  <MasteryBar states={c.states} />
                  <p className="mt-1 text-xs text-fg-2">
                    {c.concepts} concepts · {c.states.mastered + c.states.strong} strong · {c.states.needs_review} need review · {c.states.not_started} not tested{c.due ? ` · ${c.due} due` : ""}
                    {c.untested.length > 0 && <> · e.g. {c.untested.slice(0, 3).map((u) => u.name).join(", ")}</>}
                  </p>
                </>
              ) : <p className="mt-1 text-xs text-fg-2">No concepts found yet.</p>}
            </li>
          ))}
        </ul>
        <Legend />
      </section>

      {(o.byType.length > 0 || o.upcoming.length > 0) && (
        <section className="mt-10 grid gap-6 sm:grid-cols-2">
          {o.byType.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">By question type</h2>
              <ul className="space-y-1 text-sm">
                {o.byType.map((t) => (
                  <li key={t.qtype} className="flex items-center gap-2">
                    <span className="w-36 shrink-0 truncate text-fg-2">{QTYPE_LABEL[t.qtype as QType] ?? t.qtype}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted"><span className="block h-full bg-accent" style={{ width: `${Math.round((t.ok / t.n) * 100)}%` }} /></span>
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg-2">{t.ok}/{t.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {o.upcoming.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Coming up for review</h2>
              <ul className="space-y-1 text-sm">{o.upcoming.map((u) => <li key={u.day} className="flex justify-between"><span>{new Date(u.day + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><span className="text-fg-2">{u.n} concept{u.n > 1 ? "s" : ""}</span></li>)}</ul>
            </div>
          )}
        </section>
      )}

      {done.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Recent sessions</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
            {done.map((s) => (
              <li key={s.id}>
                <Link href={`/c/${course.id}/study/${s.id}`} className="flex justify-between gap-3 px-4 py-2.5 hover:bg-muted">
                  <span>{KIND_LABEL[s.kind]} · {s.scope.label ?? s.scope.type}</span>
                  <span className="text-xs text-fg-2">{s.summary ? `${s.summary.breakdown.correct + s.summary.breakdown.mostly}/${s.summary.total} right` : ""} · {timeAgo(s.finished_at ?? s.started_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function StartButton({ label, sub, onClick, busy, disabled }: { label: string; sub: string; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <button className="rounded-xl border border-border bg-surface px-4 py-3 text-left hover:bg-muted disabled:opacity-50" onClick={onClick} disabled={busy || disabled}>
      <span className="block text-[15px] font-medium">{busy ? "Preparing…" : label}</span>
      <span className="block text-xs text-fg-2">{sub}</span>
    </button>
  );
}

export function MasteryBar({ states }: { states: Record<string, number> }) {
  const order = ["mastered", "strong", "learning", "needs_review", "not_started"];
  const total = order.reduce((s, k) => s + (states[k] ?? 0), 0) || 1;
  return (
    <div className="mt-1.5 flex h-1.5 overflow-hidden rounded bg-muted" role="img" aria-label={order.map((k) => `${states[k] ?? 0} ${k.replace("_", " ")}`).join(", ")}>
      {order.map((k) => (states[k] ? <span key={k} style={{ width: `${((states[k] ?? 0) / total) * 100}%`, background: STATE_COLOR[k] }} /> : null))}
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [["mastered", "Mastered"], ["strong", "Strong"], ["learning", "Learning"], ["needs_review", "Needs review"], ["not_started", "Not tested"]];
  return (
    <p className="mt-2 flex flex-wrap gap-3 text-xs text-fg-2">
      {items.map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: STATE_COLOR[k] }} />{l}</span>)}
    </p>
  );
}

const TYPE_CHOICES: QType[] = ["mcq", "tf", "fill", "definition", "list", "indirect", "comparison", "scenario", "why", "diagram"];

function CustomSetup({ initialKind, lectures, busy, onStart }: { initialKind: "practice" | "exam"; lectures: Lecture[]; busy: boolean; onStart: (o: StartOpts) => void }) {
  const [kind, setKind] = useState<"practice" | "master" | "exam">(initialKind);
  const [sel, setSel] = useState<string[]>([]);
  const [types, setTypes] = useState<QType[]>([]);
  const [difficulty, setDifficulty] = useState<"adaptive" | 1 | 2 | 3>("adaptive");
  const [count, setCount] = useState(10);
  const [minutes, setMinutes] = useState(0);
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <section className="mt-4 space-y-4 rounded-xl border border-border bg-surface p-5 text-sm">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Mode">
        {(["practice", "master", "exam"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} className={`btn h-8 ${kind === k ? "btn-primary" : ""}`} onClick={() => setKind(k)}>
            {k === "practice" ? "Study" : k === "master" ? "Master this" : "Exam practice"}
          </button>
        ))}
      </div>
      <div>
        <p className="label">Lectures (none selected = whole course)</p>
        <div className="flex flex-wrap gap-1.5">
          {lectures.map((l) => (
            <button key={l.id} aria-pressed={sel.includes(l.id)} className={`rounded-md border px-2 py-1 text-xs ${sel.includes(l.id) ? "border-accent bg-accent-soft" : "border-border"}`} onClick={() => setSel(toggle(sel, l.id))}>
              {pad2(l.number)} {l.title}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="label">Question types (none selected = mixed)</p>
        <div className="flex flex-wrap gap-1.5">
          {TYPE_CHOICES.filter((t) => kind !== "exam" || t !== "diagram").map((t) => (
            <button key={t} aria-pressed={types.includes(t)} className={`rounded-md border px-2 py-1 text-xs ${types.includes(t) ? "border-accent bg-accent-soft" : "border-border"}`} onClick={() => setTypes(toggle(types, t))}>{QTYPE_LABEL[t]}</button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label>
          <span className="label">Difficulty</span>
          <select className="input h-9 w-auto" value={String(difficulty)} onChange={(e) => setDifficulty(e.target.value === "adaptive" ? "adaptive" : (Number(e.target.value) as 1 | 2 | 3))}>
            <option value="adaptive">Adaptive</option><option value="1">Easy</option><option value="2">Medium</option><option value="3">Hard</option>
          </select>
        </label>
        {kind !== "master" && (
          <label><span className="label">Questions</span><input className="input h-9 w-20" type="number" min={1} max={60} value={count} onChange={(e) => setCount(Number(e.target.value) || 10)} /></label>
        )}
        {kind === "exam" && (
          <label><span className="label">Time limit (min, 0 = none)</span><input className="input h-9 w-24" type="number" min={0} max={300} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 0)} /></label>
        )}
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={() => onStart({
        kind,
        scope: sel.length ? { type: sel.length === 1 ? "lecture" : "lectures", lectureIds: sel, label: sel.length === 1 ? `Lecture ${pad2(lectures.find((l) => l.id === sel[0])?.number)}` : `${sel.length} lectures` } : { type: "course", label: "Whole course" },
        config: { types: types.length ? types : "mixed", difficulty, ...(kind !== "master" ? { count } : {}), ...(kind === "exam" && minutes ? { timeLimitMin: minutes } : {}) },
      })}>{busy ? "Preparing…" : "Start"}</button>
    </section>
  );
}
