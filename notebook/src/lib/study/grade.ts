// Rubric-based grading. Verdicts are always computed here from per-point results — never taken from a model's
// free-form opinion — so rule grading and LLM point-judgements produce comparable, auditable scores.
import { bestMatch, headMatch, indexAnswer, stemMatch, type AnswerIndex } from "./text";
import type { Grade, MisconceptionRule, PointResult, RubricPoint, Verdict } from "./types";

export type GradeInput = {
  qtype: string;
  rubric: RubricPoint[];
  misconceptions: MisconceptionRule[];
  options: { key: string; text: string; correct: boolean; why: string }[] | null;
  answer: string;
  /** optional semantic similarity (0..1) between the answer and each rubric point's text, keyed by point id */
  semantic?: Record<string, number>;
};

export const SEMANTIC_MET = 0.78;

function pointStatus(p: RubricPoint, idx: AnswerIndex, sem?: number): PointResult["status"] {
  let best = 0;
  for (const alt of p.alternatives) {
    if (!alt.length) continue;
    const [h, ...rest] = alt;
    const hm = headMatch(h!, rest, idx);
    const others = rest.length ? rest.reduce((s, k) => s + bestMatch(k, idx), 0) / rest.length : 1;
    // Head word carries the meaning; supporting words complete it.
    const v = hm === 1 ? (rest.length <= 1 || others >= 0.5 ? 1 : 0.6) : hm === 0.5 ? 0.5 : others >= 0.67 && rest.length >= 2 ? 0.5 : 0;
    best = Math.max(best, v);
  }
  if (sem !== undefined && sem >= SEMANTIC_MET) best = Math.max(best, 1);
  else if (sem !== undefined && sem >= SEMANTIC_MET - 0.1) best = Math.max(best, 0.5);
  return best >= 0.9 ? "met" : best >= 0.5 ? "partial" : "missing";
}

/** Misconception cues match exact stems (never weak synonyms): a wrong belief must be stated, not inferred.
 *  `loose` also accepts same-meaning synonyms for cue words; used only when the answer misses the expected content,
 *  so an otherwise-correct answer that happens to paraphrase a sibling's wording isn't flagged. */
export function detectMisconceptions(rules: MisconceptionRule[], idx: AnswerIndex, loose = false): { claim: string; correction: string; pointId?: string }[] {
  const hits: { claim: string; correction: string; pointId?: string }[] = [];
  const literal = (k: string, s: string) => s === k || s.startsWith(k) || k.startsWith(s);
  const has = (k: string) => idx.stems.some((s, i) => !idx.negated.has(i) && stemMatch(k, s) === 1 && (loose || literal(k, s)));
  for (const r of rules) {
    const fired = r.cues.some((cue) => cue.length > 0 && cue.every(has));
    if (fired && !hits.some((h) => h.correction === r.correction)) hits.push({ claim: r.claim, correction: r.correction, pointId: r.pointId });
  }
  return hits;
}

export function verdictFor(score: number, hasMisconception: boolean, essentialMissing: boolean): Verdict {
  if (hasMisconception) return essentialMissing || score < 0.3 ? "incorrect" : "partial";
  if (score >= 0.85) return "correct";
  if (score >= 0.6) return "mostly";
  if (score >= 0.3) return "partial";
  return "incorrect";
}

/** Combines per-point results + misconceptions into a score and verdict. */
export function scorePoints(rubric: RubricPoint[], points: PointResult[], misconceptions: { claim: string; correction: string }[]): { score: number; verdict: Verdict } {
  const total = rubric.reduce((s, p) => s + p.weight, 0) || 1;
  const got = rubric.reduce((s, p) => {
    const st = points.find((x) => x.id === p.id)?.status;
    return s + p.weight * (st === "met" ? 1 : st === "partial" ? 0.5 : 0);
  }, 0);
  let score = got / total;
  const essentialMissing = rubric.some((p) => p.essential && points.find((x) => x.id === p.id)?.status === "missing");
  if (essentialMissing) score = Math.min(score, 0.45);
  if (misconceptions.length) score = Math.min(score, 0.4);
  score = Math.round(score * 100) / 100;
  return { score, verdict: verdictFor(score, misconceptions.length > 0, essentialMissing) };
}

export function gradeChoice(input: GradeInput): Grade {
  const raw = input.answer.trim();
  const letter = raw.match(/^\(?([A-Ea-e]|[TtFf])(?:[).:\s]|$)/)?.[1]?.toUpperCase();
  const chosen = input.options?.find((o) => o.key.toUpperCase() === letter) ?? input.options?.find((o) => o.text.toLowerCase() === raw.toLowerCase());
  const correct = !!chosen?.correct;
  const right = input.options?.find((o) => o.correct);
  return {
    verdict: correct ? "correct" : "incorrect",
    score: correct ? 1 : 0,
    points: [{ id: "choice", text: right?.text ?? "", status: correct ? "met" : "missing" }],
    misconceptions: !correct && chosen && input.qtype !== "tf" ? [{ claim: `Chose “${chosen.text}”`, correction: chosen.why }]
      : !correct && chosen && input.qtype === "tf" ? [{ claim: chosen.why && !chosen.correct ? chosen.why : `Answered ${chosen.text}`, correction: right?.why ?? "" }] : [],
    grader: "choice",
  };
}

/** Deterministic grader: meaning-level matching via stems + general synonyms (+ optional embedding similarity). */
export function gradeRule(input: GradeInput): Grade {
  if (input.options?.length) return gradeChoice(input);
  const idx = indexAnswer(input.answer);
  if (!idx.stems.length) return { verdict: "incorrect", score: 0, points: input.rubric.map((p) => ({ id: p.id, text: p.text, status: "missing" })), misconceptions: [], grader: "rule" };
  const status = (p: RubricPoint) => pointStatus(p, idx, input.semantic?.[p.id]);
  const rules = input.misconceptions.filter((r) => { const p = r.unless && input.rubric.find((x) => x.id === r.unless); return !p || status(p) !== "met"; });
  let misconceptions = detectMisconceptions(rules, idx);
  if (!misconceptions.length && input.rubric.some((p) => p.essential && status(p) === "missing")) misconceptions = detectMisconceptions(rules, idx, true);
  const voided = new Set(misconceptions.map((m) => m.pointId).filter(Boolean));
  const points = input.rubric.map((p) => ({ id: p.id, text: p.text, status: voided.has(p.id) ? "missing" as const : pointStatus(p, idx, input.semantic?.[p.id]) }));
  const { score, verdict } = scorePoints(input.rubric, points, misconceptions);
  return { verdict, score, points, misconceptions: misconceptions.map(({ claim, correction }) => ({ claim, correction })), grader: input.semantic ? "rule+embeddings" : "rule" };
}
