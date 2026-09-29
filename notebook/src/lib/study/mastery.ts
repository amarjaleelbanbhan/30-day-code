// Mastery model + spaced review (pure; unit-tested).
//
// Per concept we keep an exponentially-weighted score per cognitive level. Mastery needs *breadth* (several levels),
// *depth* (at least one application/analysis/transfer success) and *retention* (a correct answer after a gap).
// Recognition formats (MCQ/true-false/fill) count for less than free recall.
import { LEVELS, type Level, type QType, type Verdict } from "./types";

export type MasteryState = "not_started" | "learning" | "needs_review" | "strong" | "mastered";
export const STATE_LABEL: Record<MasteryState, string> = {
  not_started: "Not started", learning: "Learning", needs_review: "Needs review", strong: "Strong", mastered: "Mastered",
};

export type LevelStat = { n: number; s: number };
export type Mastery = {
  attempts: number; correct: number; partial: number; incorrect: number;
  levels: Partial<Record<Level, LevelStat>>;
  score: number; state: MasteryState; misconceptions: number; retained: number;
  reps: number; ease: number; intervalDays: number; lastReviewed: Date | null; nextReview: Date | null;
  lastVerdict?: Verdict | null;
};

export const emptyMastery = (): Mastery => ({
  attempts: 0, correct: 0, partial: 0, incorrect: 0, levels: {}, score: 0, state: "not_started", misconceptions: 0, retained: 0,
  reps: 0, ease: 2.5, intervalDays: 0, lastReviewed: null, nextReview: null, lastVerdict: null,
});

const RECOGNITION = new Set<QType>(["mcq", "tf", "fill"]);
const LEVEL_WEIGHT: Record<Level, number> = { remember: 0.15, understand: 0.25, apply: 0.25, analyze: 0.2, transfer: 0.15 };
const HIGHER: Level[] = ["apply", "analyze", "transfer"];
const ALPHA = 0.5;
const DAY = 864e5;

export const VERDICT_CREDIT: Record<Verdict, number> = { correct: 1, mostly: 0.75, partial: 0.4, incorrect: 0, dont_know: 0 };

/** SM-2 style quality 0..5 from the verdict, reduced for hints. */
export function quality(verdict: Verdict, hints: number): number {
  const q = { correct: 5, mostly: 4, partial: 3, incorrect: 1, dont_know: 0 }[verdict];
  return Math.max(0, q - Math.min(2, hints));
}

export function overallScore(levels: Mastery["levels"]): number {
  const tested = LEVELS.filter((l) => levels[l]?.n);
  if (!tested.length) return 0;
  const w = tested.reduce((s, l) => s + LEVEL_WEIGHT[l], 0);
  const avg = tested.reduce((s, l) => s + LEVEL_WEIGHT[l] * levels[l]!.s, 0) / w;
  return Math.round(avg * Math.min(1, tested.length / 3) * 1000) / 1000; // breadth matters: one level can't carry a concept
}

export function stateOf(m: Mastery, now: Date): MasteryState {
  if (!m.attempts) return "not_started";
  const strongLevels = LEVELS.filter((l) => (m.levels[l]?.s ?? 0) >= 0.7);
  const higher = HIGHER.some((l) => (m.levels[l]?.s ?? 0) >= 0.7);
  const recentFail = m.lastVerdict === "incorrect" || m.lastVerdict === "dont_know";
  const overdue = !!m.nextReview && m.nextReview.getTime() < now.getTime() - DAY && m.intervalDays >= 1;
  if (recentFail || (m.attempts >= 2 && m.score < 0.35)) return "needs_review";
  if (m.score >= 0.8 && strongLevels.length >= 3 && higher && m.retained >= 1) return overdue ? "needs_review" : "mastered";
  if (m.score >= 0.6 && strongLevels.length >= 2) return overdue ? "needs_review" : "strong";
  return "learning";
}

export type AttemptSignal = { verdict: Verdict; score: number; level: Level; qtype: QType; hints: number; misconceptions: number; now: Date };

/** Applies one graded attempt: level scores, counts, review schedule and state. */
export function applyAttempt(prev: Mastery, a: AttemptSignal): Mastery {
  const m: Mastery = { ...prev, levels: { ...prev.levels } };
  m.attempts++;
  if (a.verdict === "correct") m.correct++;
  else if (a.verdict === "mostly" || a.verdict === "partial") m.partial++;
  else m.incorrect++;
  m.misconceptions += a.misconceptions;

  const credit = VERDICT_CREDIT[a.verdict] * (1 - 0.15 * Math.min(3, a.hints)) * (RECOGNITION.has(a.qtype) ? 0.8 : 1);
  const lv = m.levels[a.level] ?? { n: 0, s: 0 };
  m.levels[a.level] = { n: lv.n + 1, s: Math.round((lv.n ? lv.s * (1 - ALPHA) + credit * ALPHA : credit) * 1000) / 1000 };
  // A failure at a higher level also weakens confidence in the levels below it a little (knowledge wasn't usable).
  if (credit < 0.4) for (const l of LEVELS.slice(0, LEVELS.indexOf(a.level)))
    if (m.levels[l]?.n) m.levels[l] = { ...m.levels[l]!, s: Math.round(m.levels[l]!.s * 0.9 * 1000) / 1000 };

  // Spaced review (SM-2 inspired).
  const q = quality(a.verdict, a.hints);
  if (q >= 4 && m.lastReviewed && a.now.getTime() - m.lastReviewed.getTime() >= 20 * 3600e3) m.retained++;
  if (q >= 4) {
    m.reps++;
    m.intervalDays = m.reps === 1 ? 1 : m.reps === 2 ? 3 : Math.round(m.intervalDays * m.ease * 10) / 10;
    m.ease = Math.max(1.3, m.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  } else if (q === 3) {
    m.intervalDays = Math.max(0.5, Math.round(m.intervalDays * 0.5 * 10) / 10);
  } else {
    m.reps = 0;
    m.intervalDays = 10 / (24 * 60); // back in ~10 minutes (later in the same session, or next session)
    m.ease = Math.max(1.3, m.ease - 0.2);
  }
  m.lastReviewed = a.now;
  m.nextReview = new Date(a.now.getTime() + m.intervalDays * DAY);
  m.lastVerdict = a.verdict;
  m.score = overallScore(m.levels);
  m.state = stateOf(m, a.now);
  return m;
}

/** Which cognitive level to test next for this concept (adaptive ladder). */
export function nextLevel(m: Mastery, available: Level[], difficulty: 1 | 2 | 3): Level {
  const avail = LEVELS.filter((l) => available.includes(l));
  if (!avail.length) return "remember";
  // First level (from the difficulty-appropriate starting point) that isn't solid yet.
  const start = difficulty === 1 ? 0 : difficulty === 2 ? 1 : 2;
  const ordered = [...avail.filter((l) => LEVELS.indexOf(l) >= start), ...avail.filter((l) => LEVELS.indexOf(l) < start)];
  return ordered.find((l) => (m.levels[l]?.s ?? 0) < 0.75) ?? ordered[ordered.length - 1]!;
}

export type WeakInput = {
  conceptId: string; name: string; mastery: Mastery | null; recentVerdicts: Verdict[]; misconceptions: string[];
  lectureCount: number; now: Date;
};
export type Weakness = { conceptId: string; name: string; priority: number; reasons: string[]; state: MasteryState };

/** Concept-aware weakness analysis: misconceptions, repeated misses, level gaps, staleness, importance. */
export function weakness(w: WeakInput): Weakness | null {
  const m = w.mastery;
  const reasons: string[] = [];
  let p = 0;
  if (!m || !m.attempts) {
    return { conceptId: w.conceptId, name: w.name, priority: 0.5 + Math.min(1, w.lectureCount / 3), reasons: [`Never tested${w.lectureCount > 1 ? ` · appears in ${w.lectureCount} lectures` : ""}`], state: "not_started" };
  }
  const mc = [...new Set(w.misconceptions)];
  if (mc.length) { p += 3 * Math.min(3, w.misconceptions.length); reasons.push(...mc.slice(0, 2).map((c) => `Misconception: ${c}`)); }
  const misses = w.recentVerdicts.filter((v) => v === "incorrect" || v === "dont_know").length;
  const partials = w.recentVerdicts.filter((v) => v === "partial" || v === "mostly").length;
  if (misses) { p += 2 * misses; reasons.push(`${misses} recent incorrect answer${misses > 1 ? "s" : ""}`); }
  if (partials) { p += partials; reasons.push(`${partials} incomplete answer${partials > 1 ? "s" : ""}`); }
  const low = (l: Level) => (m.levels[l]?.n ?? 0) > 0 && m.levels[l]!.s < 0.5;
  const good = (l: Level) => (m.levels[l]?.s ?? 0) >= 0.75;
  if ((good("remember") || good("understand")) && HIGHER.some(low)) { p += 1.5; reasons.push("Good recall, weak application"); }
  if (m.nextReview && m.nextReview < w.now && m.intervalDays >= 0.5) {
    const days = (w.now.getTime() - m.nextReview.getTime()) / DAY;
    p += Math.min(2, 0.5 + days / 3);
    reasons.push("Due for review");
  }
  if (m.state === "mastered" || (m.state === "strong" && !reasons.length)) return null;
  if (!reasons.length) return null;
  p += Math.min(1, w.lectureCount / 3) * 0.5;
  return { conceptId: w.conceptId, name: w.name, priority: Math.round(p * 100) / 100, reasons, state: m.state };
}
