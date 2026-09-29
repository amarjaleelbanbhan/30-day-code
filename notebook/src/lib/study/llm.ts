import "server-only";
// Small, schema-constrained LLM tasks for study mode (local-model friendly): generate ONE question from a few
// evidence passages, judge ONE answer against its rubric, or explain ONE concept. Every reply is validated; a malformed
// reply gets one corrective retry, then the caller falls back to deterministic behaviour.
import { z } from "zod";
import type { LLM } from "../ai/provider";
import { contentStems, words } from "./text";
import type { EvidenceRef, Level, MisconceptionRule, Option, PointResult, QType, QuestionDraft, RubricPoint } from "./types";

// ---------------- JSON handling ----------------

/** Extracts the first balanced JSON object from a model reply (tolerates code fences and chatter). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object");
}

async function structured<T>(llm: LLM, system: string, user: string, schema: z.ZodType<T>, check: (v: T) => string | null, maxTokens: number, log?: Log): Promise<T | null> {
  let messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: user }];
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = "";
    try {
      raw = await llm.complete({ system, messages, maxTokens, temperature: attempt ? 0 : 0.3 });
      const parsed = schema.safeParse(extractJson(raw));
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const problem = check(parsed.data);
      if (problem) throw new Error(problem);
      log?.({ ok: true, attempt, raw });
      return parsed.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log?.({ ok: false, attempt, raw, error: msg });
      if (!raw) return null; // provider unreachable: don't retry
      messages = [...messages, { role: "assistant", content: raw.slice(0, 4000) }, { role: "user", content: `That reply was invalid (${msg}). Reply again with ONLY the corrected JSON object.` }];
    }
  }
  return null;
}
export type Log = (e: { ok: boolean; attempt: number; raw: string; error?: string }) => void;

const evidenceBlock = (ev: EvidenceRef[]) => ev.map((e) => `[${e.n}] ${e.label}\n${e.excerpt.slice(0, 900)}`).join("\n\n");

// ---------------- question generation ----------------

const genSchema = z.object({
  question: z.string().min(8).max(1200),
  options: z.array(z.object({ text: z.string().min(1).max(300), correct: z.boolean(), why: z.string().max(400).default("") })).max(5).optional(),
  answer: z.string().min(1).max(1500),
  rubric: z.array(z.object({ text: z.string().min(1).max(300), keywords: z.array(z.string().min(1).max(60)).min(1).max(6), essential: z.boolean().default(false) })).min(1).max(6),
  misconceptions: z.array(z.object({ claim: z.string().min(3).max(300), cue_words: z.array(z.string().min(1).max(40)).min(1).max(4), correction: z.string().min(3).max(400) })).max(4).default([]),
  hints: z.array(z.string().min(3).max(300)).min(1).max(3),
  explanation: z.string().max(800).default(""),
  evidence: z.array(z.number().int().min(1)).min(1).max(6),
});
type Gen = z.infer<typeof genSchema>;

const TYPE_RULES: Partial<Record<QType, string>> = {
  mcq: "Multiple choice with 4 options, exactly one correct; distractors must be other real terms/ideas from the evidence. Include 'why' for each option.",
  tf: "A true/false statement. The answer field must be exactly \"True\" or \"False\". A false statement should test a real misconception (e.g. attributing one concept's property to another), not a wording trick.",
  fill: "One sentence with the key term replaced by _____. The answer is the missing term.",
  definition: "Ask the student to explain the concept in their own words.",
  short: "A short-answer recall question.",
  conceptual: "Ask WHY the concept is the way it is or what would go wrong without it.",
  why: "Ask why or how something works, requiring an explanation, not a definition.",
  comparison: "Ask the student to compare the concept with a related concept from the evidence.",
  scenario: "Describe a concrete situation (do NOT reuse the evidence's wording) and ask which concept applies and why.",
  indirect: "Describe the concept in different words than the evidence (no phrase of 5+ words copied) and ask what it is called.",
  code: "Only if the evidence contains code: ask for the output, a trace, or the bug. Put the code in the question.",
  formula: "Only if the evidence contains a formula or worked example: ask a new numerical problem solved the same way; the answer shows the working.",
  diagram: "Ask the student to draw the diagram; the rubric lists the components/labels it must contain.",
};

export type GenRequest = {
  concept: string; qtype: QType; level: Level; difficulty: 1 | 2 | 3; evidence: EvidenceRef[]; avoid: string[]; related?: string[];
};

const GEN_SYSTEM = `You write ONE exam question for a university student, using ONLY facts stated in the numbered evidence from their course.
Reply with a single JSON object and nothing else:
{"question": "...", "options": [{"text": "...", "correct": true, "why": "..."}], "answer": "model answer", "rubric": [{"text": "one required idea", "keywords": ["words", "that show it"], "essential": true}], "misconceptions": [{"claim": "a likely wrong belief", "cue_words": ["words", "revealing it"], "correction": "the correct statement"}], "hints": ["small nudge", "stronger clue", "the relevant principle, without the answer"], "explanation": "why the answer is right", "evidence": [1]}
Rules: options only for multiple choice. Rubric: 1-5 separate ideas needed for full marks; keywords are short words/phrases a correct answer would contain. Hints must not reveal the answer. "evidence" lists the source numbers you used. Never add facts that are not in the evidence.`;

export async function generateQuestionLLM(llm: LLM, req: GenRequest, log?: Log): Promise<QuestionDraft | null> {
  const evText = req.evidence.map((e) => e.excerpt).join("\n");
  const evStems = new Set(contentStems(evText));
  const user = `Concept: ${req.concept}${req.related?.length ? ` (related: ${req.related.join(", ")})` : ""}
Question type: ${req.qtype} — ${TYPE_RULES[req.qtype] ?? ""}
Cognitive level: ${req.level}; difficulty ${req.difficulty}/3.
${req.avoid.length ? `Do not repeat or lightly reword these earlier questions:\n${req.avoid.slice(0, 8).map((a) => `- ${a}`).join("\n")}\n` : ""}
Evidence:
${evidenceBlock(req.evidence)}`;
  const g = await structured(llm, GEN_SYSTEM, user, genSchema, (v) => validateGenerated(v, req, evStems, evText), 900, log);
  if (!g) return null;
  return toDraft(g, req, llm);
}

/** Structural + grounding checks on a generated question. Returns a problem description or null. */
export function validateGenerated(v: Gen, req: Pick<GenRequest, "qtype" | "evidence">, evStems: Set<string>, evText: string): string | null {
  if (v.evidence.some((n) => !req.evidence.some((e) => e.n === n))) return "evidence refers to a source number that was not provided";
  if (req.qtype === "mcq") {
    if (!v.options || v.options.length < 3) return "multiple choice needs 3-5 options";
    if (v.options.filter((o) => o.correct).length !== 1) return "multiple choice needs exactly one correct option";
  }
  if (req.qtype === "tf" && !/^(true|false)$/i.test(v.answer.trim())) return 'answer must be "True" or "False"';
  // Grounding: every rubric idea must be supported by words in the evidence.
  for (const r of v.rubric) {
    const ks = r.keywords.flatMap((k) => contentStems(k));
    if (ks.length && !ks.some((k) => evStems.has(k) || [...evStems].some((e) => e.length >= 5 && (e.startsWith(k) || k.startsWith(e)))))
      return `rubric idea "${r.text}" is not supported by the evidence`;
  }
  // Answer must not leak into the question (except MCQ/TF where options/statement are part of the task).
  if (!["mcq", "tf", "code", "formula"].includes(req.qtype)) {
    const a = words(v.answer).join(" ");
    if (a.length > 12 && words(v.question).join(" ").includes(a)) return "the question contains its own answer";
  }
  if (req.qtype === "indirect" || req.qtype === "scenario") {
    const q = words(v.question), ev = words(evText).join(" ");
    for (let i = 0; i + 6 <= q.length; i++) if (ev.includes(q.slice(i, i + 6).join(" "))) return "the question copies the evidence wording; rephrase it";
  }
  return null;
}

function toDraft(g: Gen, req: GenRequest, llm: LLM): QuestionDraft {
  const rubric: RubricPoint[] = g.rubric.map((r, i) => ({
    id: `p${i + 1}`, text: r.text, weight: 1, essential: r.essential,
    alternatives: r.keywords.map((k) => { const s = contentStems(k); return s.length ? [s[s.length - 1]!, ...s.slice(0, -1)] : []; }).filter((a) => a.length),
  }));
  if (!rubric.some((p) => p.essential)) rubric[0]!.essential = true;
  const misconceptions: MisconceptionRule[] = g.misconceptions.map((m, i) => ({ id: `m${i + 1}`, claim: m.claim, correction: m.correction, cues: [m.cue_words.flatMap((w) => contentStems(w))].filter((c) => c.length) }));
  let options: Option[] | null = null;
  let answer = g.answer;
  if (req.qtype === "mcq" && g.options) {
    options = g.options.slice(0, 5).map((o, i) => ({ key: "ABCDE"[i]!, text: o.text, correct: o.correct, why: o.why }));
    answer = `${options.find((o) => o.correct)!.key}. ${options.find((o) => o.correct)!.text}`;
  } else if (req.qtype === "tf") {
    const truth = /^true$/i.test(g.answer.trim());
    options = [{ key: "T", text: "True", correct: truth, why: g.explanation }, { key: "F", text: "False", correct: !truth, why: g.explanation }];
    answer = truth ? "True" : "False";
  }
  return {
    conceptName: req.concept, qtype: req.qtype, level: req.level, difficulty: req.difficulty, prompt: g.question.trim(), options, answer, rubric,
    misconceptions, hints: g.hints.slice(0, 3), explanation: g.explanation,
    evidenceChunkIds: g.evidence.map((n) => req.evidence.find((e) => e.n === n)!.chunkId),
    generator: `llm:${llm.provider}:${llm.model}`,
  };
}

// ---------------- grading ----------------

const gradeSchema = z.object({
  points: z.array(z.object({ id: z.string(), status: z.enum(["met", "partial", "missing"]) })).min(1),
  misconceptions: z.array(z.object({ claim: z.string().min(3).max(300), correction: z.string().min(3).max(400) })).max(4).default([]),
});

const GRADE_SYSTEM = `You grade ONE student answer against a rubric from their course. Judge meaning, not wording: accept paraphrases and synonyms. A rubric point is "met" if the answer clearly states it, "partial" if it is vague or incomplete, "missing" otherwise.
List a misconception only when the answer states something the evidence contradicts (not merely something missing).
Reply with ONLY JSON: {"points": [{"id": "p1", "status": "met"}], "misconceptions": [{"claim": "what the student wrongly said", "correction": "what the course says"}]}`;

export async function gradeLLM(llm: LLM, q: { prompt: string; rubric: RubricPoint[]; answer: string; evidence: EvidenceRef[] }, studentAnswer: string, log?: Log)
  : Promise<{ points: PointResult[]; misconceptions: { claim: string; correction: string }[] } | null> {
  const user = `Question: ${q.prompt}
Model answer: ${q.answer}
Rubric:
${q.rubric.map((p) => `- ${p.id}${p.essential ? " (essential)" : ""}: ${p.text}`).join("\n")}
Course evidence:
${evidenceBlock(q.evidence.slice(0, 3))}

Student answer: """${studentAnswer.slice(0, 3000)}"""`;
  const ids = new Set(q.rubric.map((p) => p.id));
  const g = await structured(llm, GRADE_SYSTEM, user, gradeSchema, (v) => (v.points.some((p) => !ids.has(p.id)) ? "unknown rubric point id" : null), 500, log);
  if (!g) return null;
  return {
    points: q.rubric.map((p) => ({ id: p.id, text: p.text, status: g.points.find((x) => x.id === p.id)?.status ?? "missing" })),
    misconceptions: g.misconceptions,
  };
}

// ---------------- teaching ----------------

const teachSchema = z.object({
  explanation: z.string().min(10).max(2500),
  check: z.object({ question: z.string().min(5).max(400), answer: z.string().min(1).max(400) }).optional(),
});

export async function teachLLM(llm: LLM, req: { mode: "teach" | "why"; question: string; modelAnswer: string; studentAnswer?: string; missing?: string[]; misconceptions?: string[]; evidence: EvidenceRef[] }, log?: Log) {
  const system = req.mode === "why"
    ? `You explain to a student exactly why their answer was wrong or incomplete, using ONLY the course evidence. Be specific to their words. Cite sources as [n]. No motivational filler. Reply with ONLY JSON: {"explanation": "..."}`
    : `You teach one idea simply to a student who didn't understand, using ONLY the course evidence (cite as [n]). Then give one tiny comprehension check. Reply with ONLY JSON: {"explanation": "...", "check": {"question": "...", "answer": "..."}}`;
  const user = `Question: ${req.question}
Model answer: ${req.modelAnswer}
${req.studentAnswer !== undefined ? `Student answer: """${req.studentAnswer.slice(0, 2000)}"""\n` : ""}${req.missing?.length ? `Missing points: ${req.missing.join("; ")}\n` : ""}${req.misconceptions?.length ? `Misconceptions: ${req.misconceptions.join("; ")}\n` : ""}
Course evidence:
${evidenceBlock(req.evidence.slice(0, 4))}`;
  return structured(llm, system, user, teachSchema, () => null, 700, log);
}

