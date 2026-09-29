import "server-only";
// Study engine: plans one question at a time from the course's concept index + retrieval evidence, grades answers,
// updates mastery and the review schedule, and summarises sessions. Everything is scoped to the owning user.
import type { PoolClient } from "pg";
import { getEmbedder, getLLM } from "../ai/provider";
import { q, q1, tx } from "../db";
import { normConcept } from "../query";
import { citationLabel } from "../search";
import { extractFacts, type Fact } from "./facts";
import { gradeRule, scorePoints, detectMisconceptions } from "./grade";
import { generateQuestionLLM, gradeLLM, teachLLM } from "./llm";
import { applyAttempt, emptyMastery, nextLevel, STATE_LABEL, weakness, type Mastery, type MasteryState, type Weakness } from "./mastery";
import { fingerprint, isNearDuplicate } from "./novelty";
import { candidates } from "./templates";
import { indexAnswer } from "./text";
import { LEVELS, type EvidenceRef, type Grade, type Level, type QType, type QuestionDraft, type Verdict } from "./types";

export type SessionKind = "practice" | "master" | "weak" | "review" | "quick" | "exam";
export type Scope = { type: "lecture" | "lectures" | "course" | "concept" | "weak" | "due"; lectureIds?: string[]; conceptIds?: string[]; label?: string };
export type Config = { types: QType[] | "mixed"; difficulty: 1 | 2 | 3 | "adaptive"; count?: number; timeLimitMin?: number };

type Queued = { conceptId: string; afterPos: number; purpose: "retest" | "check"; level: Level; avoidTypes: QType[] };
type Asked = { n: number; types: QType[]; gens?: string[]; lastPos: number; levelsOk: Level[]; lastVerdict?: Verdict; exhausted?: boolean };
type PlannerState = { concepts: string[]; difficulty: 1 | 2 | 3; streak: number; queue: Queued[]; asked: Record<string, Asked>; skip: string[] };

const LLM_ONLY: QType[] = ["short", "conceptual", "why", "scenario", "code", "formula"];
const TYPES_BY_LEVEL: Record<Level, QType[]> = {
  remember: ["mcq", "fill", "tf"],
  understand: ["definition", "list", "tf", "short", "conceptual"],
  apply: ["indirect", "scenario", "diagram", "code", "formula"],
  analyze: ["comparison", "why"],
  transfer: ["comparison", "scenario", "why"],
};

// ---------------- ownership helpers ----------------

export const getSession = (userId: string, sessionId: string) =>
  q1<{ id: string; user_id: string; course_id: string; kind: SessionKind; scope: Scope; config: Config; status: string; state: PlannerState; summary: unknown; started_at: Date; deadline_at: Date | null; finished_at: Date | null }>(
    "SELECT * FROM study_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);

const ownsCourse = async (userId: string, courseId: string) =>
  !!(await q1("SELECT 1 FROM courses WHERE id = $1 AND user_id = $2", [courseId, userId]));

// ---------------- concepts & evidence ----------------

type ConceptRow = { id: string; name: string; aliases: string[]; lecture_count: number; first_position: number | null };

async function importantConcepts(courseId: string, lectureIds?: string[]): Promise<ConceptRow[]> {
  // Concepts that are titles/definitions somewhere (or recur) — the ones worth testing.
  return q<ConceptRow>(
    `SELECT k.id, k.name, k.aliases, k.lecture_count, k.first_position
     FROM concepts k
     WHERE k.course_id = $1
       AND EXISTS (SELECT 1 FROM concept_mentions cm JOIN chunks ch ON ch.id = cm.chunk_id
                   WHERE cm.concept_id = k.id AND ch.source_kind <> 'ai_note' AND ($2::uuid[] IS NULL OR ch.lecture_id = ANY($2))
                     AND (cm.role IN ('title','definition') OR k.lecture_count >= 2))
     ORDER BY k.first_position NULLS LAST, k.mention_count DESC, k.name`, [courseId, lectureIds?.length ? lectureIds : null]);
}

/** Round-robin across lectures so whole-course study interleaves topics instead of exhausting one lecture. */
function interleave(concepts: ConceptRow[]): string[] {
  const byLec = new Map<number, ConceptRow[]>();
  for (const c of concepts) byLec.set(c.first_position ?? 1e9, [...(byLec.get(c.first_position ?? 1e9) ?? []), c]);
  const groups = [...byLec.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const out: string[] = [];
  for (let i = 0; groups.some((g) => g[i]); i++) for (const g of groups) if (g[i]) out.push(g[i]!.id);
  return out;
}

type ChunkRow = {
  chunk_id: string; text: string; section: string | null; content_type: string; source_kind: string; lecture_id: string | null;
  lecture_number: number | null; lecture_title: string | null; material_id: string | null; note_id: string | null; page_no: number | null;
  anchor: string | null; filename: string | null; role: string;
};

async function conceptChunks(conceptIds: string[], lectureIds?: string[]): Promise<ChunkRow[]> {
  return q<ChunkRow>(
    `SELECT DISTINCT ON (ch.id) ch.id AS chunk_id, ch.text, ch.section, ch.content_type, ch.source_kind, ch.lecture_id, l.number AS lecture_number,
       l.title AS lecture_title, ch.material_id, ch.note_id, ch.page_no, ch.anchor, m.filename, cm.role
     FROM concept_mentions cm JOIN chunks ch ON ch.id = cm.chunk_id
     LEFT JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id
     WHERE cm.concept_id = ANY($1) AND ch.source_kind <> 'ai_note' AND ($2::uuid[] IS NULL OR ch.lecture_id = ANY($2) OR ch.lecture_id IS NULL)
     ORDER BY ch.id`, [conceptIds, lectureIds?.length ? lectureIds : null]);
}

const ROLE_ORDER: Record<string, number> = { definition: 0, title: 1, mention: 2 };
const KIND_ORDER: Record<string, number> = { slides: 0, teacher_notes: 0, student_notes: 1, other: 2, outline: 3, book: 4 };

function toEvidence(rows: ChunkRow[]): EvidenceRef[] {
  return rows.map((r, i) => ({
    n: i + 1, chunkId: r.chunk_id, label: citationLabel({ ...r, lecture_number: r.lecture_number, filename: r.filename, page_no: r.page_no, content_type: r.content_type, section: r.section, source_kind: r.source_kind }),
    excerpt: r.text, lectureId: r.lecture_id, lectureNumber: r.lecture_number, materialId: r.material_id, pageNo: r.page_no, noteId: r.note_id,
    anchor: r.anchor, kind: r.source_kind, contentType: r.content_type,
  }));
}

const matchesConcept = (term: string, c: { name: string; aliases: string[] }) => {
  const t = normConcept(term);
  return t === normConcept(c.name) || c.aliases.some((a) => normConcept(a) === t);
};

// ---------------- question making ----------------

type Ctx = { userId: string; courseId: string; session: { id: string; kind: SessionKind; config: Config; scope: Scope }; pos: number };

async function priorQuestions(userId: string, conceptId: string) {
  return q<{ id: string; prompt: string; fingerprint: string; qtype: string; generator: string; asked_at: Date }>(
    `SELECT DISTINCT ON (sq.id) sq.id, sq.prompt, sq.fingerprint, sq.qtype, sq.generator, si.shown_at AS asked_at
     FROM study_items si JOIN study_sessions s ON s.id = si.session_id JOIN study_questions sq ON sq.id = si.question_id
     WHERE s.user_id = $1 AND sq.concept_id = $2 ORDER BY sq.id, si.shown_at DESC`, [userId, conceptId]);
}

export type MakeRequest = { concept: ConceptRow; level: Level; types: QType[]; avoidTypes: QType[]; sessionQuestionIds: Set<string>; avoidGenerators?: string[] };

/** Builds (or reuses) one question for a concept at a level: LLM when available, otherwise deterministic templates. */
export async function makeQuestion(ctx: Ctx, req0: MakeRequest): Promise<{ id: string; draft: QuestionDraft } | null> {
  let req = req0;
  const { concept } = req;
  const rows = (await conceptChunks([concept.id], ctx.session.scope.type === "lecture" || ctx.session.scope.type === "lectures" ? ctx.session.scope.lectureIds : undefined))
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || (KIND_ORDER[a.source_kind] ?? 5) - (KIND_ORDER[b.source_kind] ?? 5) || (a.page_no ?? 0) - (b.page_no ?? 0))
    .slice(0, 8);
  if (!rows.length) return null;
  const prior = await priorQuestions(ctx.userId, concept.id);
  const allowed = (t: QType) => !req.avoidTypes.includes(t) && (ctx.session.config.types === "mixed" || ctx.session.config.types.includes(t));
  // If the student restricted question types, test at the level those types belong to.
  if (!TYPES_BY_LEVEL[req.level].some(allowed)) {
    const lv = LEVELS.find((l) => TYPES_BY_LEVEL[l].some(allowed));
    if (lv) req = { ...req, level: lv };
  }
  const levelTypes = TYPES_BY_LEVEL[req.level].filter(allowed);
  const novel = (d: QuestionDraft) => {
    const fp = fingerprint(d.prompt, concept.name);
    return !prior.some((p) => isNearDuplicate({ fingerprint: fp, qtype: d.qtype }, p));
  };

  // Deterministic candidates from stated facts (plus cross-lecture comparison with a related concept).
  const facts: Fact[] = rows.flatMap((r) => extractFacts({ chunkId: r.chunk_id, section: r.section, text: r.text, contentType: r.content_type, sourceKind: r.source_kind }));
  const primary = facts.filter((f) => matchesConcept(f.term, concept));
  const where = (f: Fact) => { const r = rows.find((x) => x.chunk_id === f.chunkId)!; return citationLabel({ ...r, source_kind: r.source_kind }).replace(/ · [^·]+\.(pptx|pdf|md|docx|txt)$/, "") + (r.section ? ` (${r.section})` : ""); };
  const diagramHint = rows.some((r) => /\b(diagram|draw|figure|architecture|transitions?)\b/i.test(r.text));
  let ruleDrafts: QuestionDraft[] = primary.flatMap((f) =>
    candidates({ fact: f, facts, conceptName: concept.name, aliases: concept.aliases, where: where(f), diagramHint, seed: `${ctx.session.id}:${ctx.pos}:${f.id}` }));
  const partner = await crossLecturePartner(ctx, concept, primary);
  if (partner) { ruleDrafts.push(partner.draft); rows.push(...partner.rows.filter((r) => !rows.some((x) => x.chunk_id === r.chunk_id))); }
  // Same template twice for one concept in a session is the same demand in different words — skip it.
  ruleDrafts = ruleDrafts.filter((d) => allowed(d.qtype) && !(req.avoidGenerators ?? []).includes(d.generator));

  const llm = getLLM();
  // Requested level first; then lower levels (closest first) — a check or prerequisite must never get harder — then higher.
  const li = LEVELS.indexOf(req.level);
  const wantLevels = [req.level, ...LEVELS.slice(0, li).reverse(), ...LEVELS.slice(li + 1)];
  // Prefer the LLM for the requested level when it can offer a type rules can't, or when rules have nothing novel.
  if (llm) {
    const ruleAtLevel = ruleDrafts.filter((d) => d.level === req.level && novel(d));
    const llmTypes = levelTypes.filter((t) => (LLM_ONLY.includes(t) ? typeSupported(t, rows) : true));
    const pickType = llmTypes.find((t) => !prior.some((p) => p.qtype === t)) ?? llmTypes[0];
    if (pickType && (!ruleAtLevel.length || LLM_ONLY.includes(pickType) || prior.filter((p) => p.generator.startsWith("rule")).length >= 2)) {
      const evidence = toEvidence(rows.slice(0, 5));
      for (let tries = 0; tries < 2; tries++) {
        const d = await generateQuestionLLM(llm, { concept: concept.name, qtype: pickType, level: req.level, difficulty: req.level === "remember" ? 1 : req.level === "understand" ? 2 : 3, evidence, avoid: prior.map((p) => p.prompt) });
        if (d && novel(d)) return saveQuestion(ctx, concept, { ...d, evidenceChunkIds: d.evidenceChunkIds }, evidence);
        if (d) prior.push({ id: "", prompt: d.prompt, fingerprint: fingerprint(d.prompt, concept.name), qtype: d.qtype, generator: d.generator, asked_at: new Date() });
      }
    }
  }
  // Rule-based: requested level first, novel first; never repeat a question already in this session.
  const askedHere = (d: QuestionDraft) => prior.some((x) => x.prompt === d.prompt && req.sessionQuestionIds.has(x.id));
  const pickAt = (lv: Level, reuseAfterMs: number) => {
    const pool = ruleDrafts.filter((d) => d.level === lv && !askedHere(d));
    return pool.find(novel) ?? pool.find((d) => {
      const p = prior.find((x) => x.prompt === d.prompt);
      return p && Date.now() - p.asked_at.getTime() > reuseAfterMs;
    });
  };
  for (const [lv, reuse] of [...wantLevels.map((l) => [l, 20 * 3600e3] as const), ...(req.avoidTypes.length ? [] : wantLevels.map((l) => [l, 0] as const))]) {
    // Last resort (new questions only): reuse a question from an earlier session rather than asking nothing.
    const pick = pickAt(lv, reuse);
    if (pick) {
      const used = rows.filter((r) => pick.evidenceChunkIds.includes(r.chunk_id));
      const evidence = toEvidence([...used, ...rows.filter((r) => !used.includes(r) && r.role !== "mention").slice(0, 2)]);
      return saveQuestion(ctx, concept, pick, evidence);
    }
  }
  return null;
}

function typeSupported(t: QType, rows: ChunkRow[]): boolean {
  const text = rows.map((r) => r.text).join("\n");
  if (t === "code") return /\w+\([^)]*\)\s*[;{]|^\s*(for|while|if|int|void|def|return)\b/m.test(text);
  if (t === "formula") return /\d+\s*[-+*/=]\s*\d+|[=≤≥]\s*\(?\d/.test(text);
  return true;
}

/** Cross-lecture comparison with a related concept (evidence-based relation) that has its own stated definition. */
async function crossLecturePartner(ctx: Ctx, concept: ConceptRow, primary: Fact[]): Promise<{ draft: QuestionDraft; rows: ChunkRow[] } | null> {
  const mine = primary.find((f) => f.kind !== "enumeration");
  if (!mine) return null;
  const rel = await q<ConceptRow & { evidence: number }>(
    `SELECT k.id, k.name, k.aliases, k.lecture_count, k.first_position, r.evidence FROM concept_relations r JOIN concepts k ON k.id = CASE WHEN r.a = $1 THEN r.b ELSE r.a END
     WHERE (r.a = $1 OR r.b = $1) AND r.kind = 'cooccurs'
     ORDER BY (k.first_position IS DISTINCT FROM $2) DESC, r.evidence DESC LIMIT 12`, [concept.id, concept.first_position]);
  for (const other of rel) {
    const rows = await conceptChunks([other.id]);
    const f = rows.flatMap((r) => extractFacts({ chunkId: r.chunk_id, section: r.section, text: r.text, contentType: r.content_type, sourceKind: r.source_kind }))
      .find((x) => matchesConcept(x.term, other) && x.kind !== "enumeration" && x.chunkId !== mine.chunkId);
    if (!f) continue;
    const [d] = candidates({ fact: mine, facts: [mine, { ...f, chunkId: mine.chunkId }], conceptName: concept.name, aliases: concept.aliases, where: "", diagramHint: false, seed: `${ctx.session.id}:x` })
      .filter((c) => c.qtype === "comparison");
    if (d) return { draft: { ...d, level: "transfer", difficulty: 3, evidenceChunkIds: [mine.chunkId, f.chunkId], generator: "rule:cross-lecture-comparison",
      explanation: `The course states: “${mine.sentence}” and, in another lecture, “${f.sentence}”` }, rows: rows.filter((r) => r.chunk_id === f.chunkId) };
  }
  return null;
}

async function saveQuestion(ctx: Ctx, concept: ConceptRow, d: QuestionDraft, evidenceAll: EvidenceRef[]): Promise<{ id: string; draft: QuestionDraft }> {
  const evidence = evidenceAll.filter((e) => d.evidenceChunkIds.includes(e.chunkId)).concat(evidenceAll.filter((e) => !d.evidenceChunkIds.includes(e.chunkId)).slice(0, 2))
    .map((e, i) => ({ ...e, n: i + 1 }));
  const lectureIds = [...new Set(evidence.filter((e) => d.evidenceChunkIds.includes(e.chunkId)).map((e) => e.lectureId).filter((x): x is string => !!x))];
  const existing = await q1<{ id: string }>("SELECT id FROM study_questions WHERE course_id = $1 AND concept_id = $2 AND prompt = $3 AND qtype = $4 LIMIT 1", [ctx.courseId, concept.id, d.prompt, d.qtype]);
  if (existing) return { id: existing.id, draft: d };
  const row = await q1<{ id: string }>(
    `INSERT INTO study_questions (course_id, concept_id, concept_ids, concept_name, lecture_ids, qtype, level, difficulty, prompt, options, answer, rubric,
       misconceptions, hints, explanation, evidence, generator, fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [ctx.courseId, concept.id, [concept.id], concept.name, lectureIds, d.qtype, d.level, d.difficulty, d.prompt, d.options ? JSON.stringify(d.options) : null, d.answer,
     JSON.stringify(d.rubric), JSON.stringify(d.misconceptions), JSON.stringify(d.hints), d.explanation, JSON.stringify(evidence), d.generator, fingerprint(d.prompt, concept.name)]);
  await q(`INSERT INTO question_sources (question_id, chunk_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [row!.id, d.evidenceChunkIds]);
  return { id: row!.id, draft: d };
}

// ---------------- sessions ----------------

export async function createSession(userId: string, courseId: string, kind: SessionKind, scope: Scope, config: Config) {
  if (!(await ownsCourse(userId, courseId))) return null;
  let concepts: ConceptRow[];
  if (scope.type === "concept" && scope.conceptIds?.length) {
    concepts = (await q<ConceptRow>("SELECT id, name, aliases, lecture_count, first_position FROM concepts WHERE course_id = $1 AND id = ANY($2)", [courseId, scope.conceptIds]));
    // Narrower concepts named after it *and taught in the same lecture* (so "process control" — a kind of system call — isn't pulled into "process").
    const narrower = await q<ConceptRow>(
      `SELECT k.id, k.name, k.aliases, k.lecture_count, k.first_position FROM concept_relations r JOIN concepts k ON k.id = r.a JOIN concepts b ON b.id = r.b
       WHERE r.b = ANY($1) AND r.kind = 'part_of' AND k.first_position IS NOT DISTINCT FROM b.first_position ORDER BY k.mention_count DESC LIMIT 4`, [scope.conceptIds]);
    concepts.push(...narrower.filter((n) => !concepts.some((c) => c.id === n.id)));
  } else if (scope.type === "weak" || kind === "weak") {
    const w = await weakAreas(userId, courseId);
    const ids = w.filter((x) => x.state !== "not_started").slice(0, 8).map((x) => x.conceptId);
    const fill = w.filter((x) => x.state === "not_started").slice(0, Math.max(0, 6 - ids.length)).map((x) => x.conceptId);
    concepts = await q<ConceptRow>("SELECT id, name, aliases, lecture_count, first_position FROM concepts WHERE id = ANY($1)", [[...ids, ...fill]]);
    concepts.sort((a, b) => [...ids, ...fill].indexOf(a.id) - [...ids, ...fill].indexOf(b.id));
  } else if (scope.type === "due" || kind === "review") {
    concepts = await q<ConceptRow>(
      `SELECT k.id, k.name, k.aliases, k.lecture_count, k.first_position FROM concept_mastery m JOIN concepts k ON k.id = m.concept_id
       WHERE m.user_id = $1 AND m.course_id = $2 AND m.next_review <= now() ORDER BY m.next_review LIMIT 15`, [userId, courseId]);
  } else {
    concepts = await importantConcepts(courseId, scope.type === "course" ? undefined : scope.lectureIds);
  }
  if (!concepts.length) return { error: "Nothing to study here yet — the concept index is empty for this scope (upload or write material first)." as const };
  const order = scope.type === "weak" || scope.type === "due" || kind === "weak" || kind === "review" ? concepts.map((c) => c.id) : interleave(concepts);
  const difficulty = config.difficulty === "adaptive" ? 2 : config.difficulty;
  const state: PlannerState = { concepts: order, difficulty, streak: 0, queue: [], asked: {}, skip: [] };
  const deadline = kind === "exam" && config.timeLimitMin ? new Date(Date.now() + config.timeLimitMin * 60e3) : null;
  const s = await q1<{ id: string }>(
    `INSERT INTO study_sessions (user_id, course_id, kind, scope, config, state, deadline_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, courseId, kind, JSON.stringify(scope), JSON.stringify(config), JSON.stringify(state), deadline]);
  const first = await nextItem(userId, s!.id);
  if (!first) {
    await q("UPDATE study_sessions SET status = 'abandoned', finished_at = now() WHERE id = $1", [s!.id]);
    return { error: "Couldn't build questions from this material yet. Try a different scope, or configure an AI model for richer question types." as const };
  }
  return { id: s!.id };
}

const targetCount = (kind: SessionKind, config: Config, concepts: number) =>
  kind === "master" ? 40 : kind === "exam" ? config.count ?? 10 : kind === "quick" ? config.count ?? 5 : kind === "review" ? Math.min(15, Math.max(1, concepts)) : kind === "weak" ? config.count ?? Math.min(12, concepts * 2) : config.count ?? 10;

async function masteryOf(userId: string, conceptId: string): Promise<Mastery> {
  const r = await q1<Record<string, unknown>>("SELECT * FROM concept_mastery WHERE user_id = $1 AND concept_id = $2", [userId, conceptId]);
  return r ? rowToMastery(r) : emptyMastery();
}

function rowToMastery(r: Record<string, unknown>): Mastery {
  return {
    attempts: r.attempts as number, correct: r.correct as number, partial: r.partial as number, incorrect: r.incorrect as number,
    levels: r.levels as Mastery["levels"], score: r.score as number, state: r.state as MasteryState, misconceptions: r.misconceptions as number,
    retained: r.retained as number, reps: r.reps as number, ease: r.ease as number, intervalDays: r.interval_days as number,
    lastReviewed: (r.last_reviewed as Date | null) ?? null, nextReview: (r.next_review as Date | null) ?? null,
    lastVerdict: (r.last_verdict as Verdict | undefined) ?? null,
  };
}

/**
 * A concept is demonstrated in a Master session only with correct answers at two different non-recognition levels,
 * one of them application/analysis/transfer, and the latest answer correct — or, when no further question can be
 * built for it, at least one correct answer. Easy recognition wins never finish a concept on their own.
 */
export function masteredInSession(a: Asked | undefined): boolean {
  if (!a || !(a.lastVerdict === "correct" || a.lastVerdict === "mostly")) return false;
  const ok = [...new Set(a.levelsOk)].filter((l) => l !== "remember");
  const higher = ok.some((l) => l === "apply" || l === "analyze" || l === "transfer");
  return (ok.length >= 2 && higher) || (!!a.exhausted && a.levelsOk.length >= 1);
}

/** Plans and creates the next item. Returns null when the session should end. */
export async function nextItem(userId: string, sessionId: string): Promise<{ itemId: string } | null> {
  const s = await getSession(userId, sessionId);
  if (!s || s.status !== "active") return null;
  const items = await q<{ id: string; question_id: string; answered: boolean }>(
    `SELECT si.id, si.question_id, EXISTS (SELECT 1 FROM study_attempts a WHERE a.item_id = si.id) OR (s.kind = 'exam' AND si.draft IS NOT NULL) AS answered
     FROM study_items si JOIN study_sessions s ON s.id = si.session_id WHERE si.session_id = $1 ORDER BY si.position`, [sessionId]);
  const pending = items.find((i) => !i.answered);
  if (pending && s.kind !== "exam") return { itemId: pending.id }; // one open question at a time
  const pos = items.length;
  const st = s.state;
  if (pos >= targetCount(s.kind, s.config, st.concepts.length)) return null;
  const sessionQuestionIds = new Set(items.map((i) => i.question_id));
  const ctx: Ctx = { userId, courseId: s.course_id, session: s, pos };
  const concepts = new Map((await q<ConceptRow>("SELECT id, name, aliases, lecture_count, first_position FROM concepts WHERE id = ANY($1)", [st.concepts])).map((c) => [c.id, c]));

  for (let tries = 0; tries < 8; tries++) {
    // 1) scheduled retests / comprehension checks that are due
    const qi = s.kind === "exam" ? -1 : st.queue.findIndex((x) => x.afterPos <= pos && concepts.has(x.conceptId));
    let conceptId: string | undefined, level: Level | undefined, avoidTypes: QType[] = [], purpose: "new" | "retest" | "check" = "new";
    if (qi >= 0) {
      const x = st.queue.splice(qi, 1)[0]!;
      ({ conceptId, level, avoidTypes, purpose } = { ...x });
    } else {
      // 2) choose a concept: least-asked, not just asked (interleaving), weakest mastery first in master mode
      const live = st.concepts.filter((c) => concepts.has(c) && !st.skip.includes(c) && !(s.kind === "master" && masteredInSession(st.asked[c])));
      if (!live.length) return null;
      const scored = await Promise.all(live.map(async (c, i) => {
        const a = st.asked[c];
        const m = s.kind === "master" ? await masteryOf(userId, c) : null;
        if (s.kind === "master" && masteredInSession(a)) return { c, score: Infinity };
        const recent = a && pos - a.lastPos <= 1 && live.length > 1 ? 50 : 0;
        return { c, score: (a?.n ?? 0) * 10 + recent + i * 0.1 + (m ? m.score * 5 : 0) };
      }));
      const best = scored.sort((x, y) => x.score - y.score)[0]!;
      if (best.score === Infinity) return null; // master: every concept demonstrated
      conceptId = best.c;
    }
    const concept = concepts.get(conceptId!)!;
    const m = await masteryOf(userId, concept.id);
    const d = s.config.difficulty === "adaptive" ? st.difficulty : s.config.difficulty;
    level ??= nextLevel(m, s.kind === "exam" ? LEVELS : LEVELS, d);
    // Avoid re-asking the same format for this concept within a session.
    avoidTypes = [...new Set([...avoidTypes, ...(purpose === "new" ? (st.asked[concept.id]?.types ?? []).slice(-2) : [])])];
    const avoidGenerators = (st.asked[concept.id]?.gens ?? []).filter((g) => g.startsWith("rule:"));
    const made = await makeQuestion(ctx, { concept, level, types: [], avoidTypes: s.kind === "exam" ? [...avoidTypes, "diagram"] : avoidTypes, sessionQuestionIds, avoidGenerators })
      ?? await makeQuestion(ctx, { concept, level, types: [], avoidTypes: s.kind === "exam" ? ["diagram"] : [], sessionQuestionIds, avoidGenerators });
    if (!made || sessionQuestionIds.has(made.id)) {
      if (purpose === "new") st.skip.push(concept.id);
      st.asked[concept.id] = { ...(st.asked[concept.id] ?? { n: 0, types: [], lastPos: -1, levelsOk: [] }), exhausted: true };
      continue;
    }
    const a = st.asked[concept.id] ?? { n: 0, types: [], lastPos: -1, levelsOk: [] };
    st.asked[concept.id] = { ...a, n: a.n + 1, types: [...a.types, made.draft.qtype], gens: [...(a.gens ?? []), made.draft.generator], lastPos: pos };
    const item = await tx(async (c) => {
      const r = await c.query<{ id: string }>("INSERT INTO study_items (session_id, question_id, position, purpose) VALUES ($1,$2,$3,$4) RETURNING id", [sessionId, made.id, pos, purpose]);
      await c.query("UPDATE study_sessions SET state = $2 WHERE id = $1", [sessionId, JSON.stringify(st)]);
      return r.rows[0]!.id;
    });
    return { itemId: item };
  }
  await q("UPDATE study_sessions SET state = $2 WHERE id = $1", [sessionId, JSON.stringify(st)]);
  return null;
}

// ---------------- views (never leak answers before an attempt) ----------------

type QuestionRow = {
  id: string; concept_id: string | null; concept_name: string; qtype: QType; level: Level; difficulty: number; prompt: string;
  options: { key: string; text: string; correct: boolean; why: string }[] | null; answer: string; rubric: QuestionDraft["rubric"];
  misconceptions: QuestionDraft["misconceptions"]; hints: string[]; explanation: string; evidence: EvidenceRef[]; generator: string; lecture_ids: string[];
};

export async function sessionView(userId: string, sessionId: string) {
  let s = await getSession(userId, sessionId);
  if (!s) return null;
  if (s.kind === "exam" && s.status === "active" && s.deadline_at && s.deadline_at.getTime() + 5000 < Date.now()) {
    await submitExam(userId, sessionId); // time is up
    s = (await getSession(userId, sessionId))!;
  }
  const rows = await q<{ item_id: string; position: number; purpose: string; hints_used: number; draft: { answer?: string; drawing?: unknown; revealed?: boolean } | null; attempt: Record<string, unknown> | null } & QuestionRow>(
    `SELECT si.id AS item_id, si.position, si.purpose, si.hints_used, si.draft, to_jsonb(a) AS attempt, sq.*
     FROM study_items si JOIN study_questions sq ON sq.id = si.question_id LEFT JOIN study_attempts a ON a.item_id = si.id
     WHERE si.session_id = $1 ORDER BY si.position`, [sessionId]);
  const reveal = (r: (typeof rows)[number]) => !!r.attempt && (s!.kind !== "exam" || s!.status !== "active");
  const items = rows.map((r) => ({
    itemId: r.item_id, position: r.position, purpose: r.purpose, conceptId: r.concept_id, conceptName: r.concept_name, qtype: r.qtype, level: r.level,
    prompt: r.prompt, options: r.options?.map((o) => ({ key: o.key, text: o.text })) ?? null, hintsUsed: r.hints_used,
    hints: s!.kind === "exam" ? [] : r.hints.slice(0, r.hints_used),
    hintsAvailable: s!.kind === "exam" ? 0 : r.hints.length,
    draft: s!.kind === "exam" || r.qtype === "diagram" ? r.draft : null,
    // Checklist for self-checking a drawing — only after the drawing has been submitted (and locked).
    checklist: r.qtype === "diagram" && r.draft?.revealed ? r.rubric.map((p) => ({ id: p.id, text: p.text })) : null,
    result: reveal(r) ? feedbackOf(r, r.attempt!) : null,
  }));
  return {
    id: s.id, courseId: s.course_id, kind: s.kind, scope: s.scope, config: s.config, status: s.status, startedAt: s.started_at, deadlineAt: s.deadline_at,
    target: targetCount(s.kind, s.config, s.state.concepts.length), summary: s.summary, items,
    capability: { llm: !!getLLM(), embeddings: !!getEmbedder() },
  };
}

function feedbackOf(q: QuestionRow, a: Record<string, unknown>) {
  return {
    attemptId: a.id as string, answer: a.answer as string, drawing: a.drawing ?? null, verdict: a.verdict as Verdict, score: a.score as number,
    points: a.points as Grade["points"], misconceptions: a.misconceptions as Grade["misconceptions"], grader: a.grader as string,
    hintsUsed: a.hints_used as number, masteryBefore: a.mastery_before as number | null, masteryAfter: a.mastery_after as number | null,
    modelAnswer: q.answer, explanation: q.explanation, evidence: q.evidence,
    options: q.options, generator: q.generator,
  };
}

async function loadItem(userId: string, sessionId: string, itemId: string) {
  return q1<{ item_id: string; position: number; hints_used: number; draft: Record<string, unknown> | null; shown_at: Date; attempted: boolean; session_kind: SessionKind; session_status: string; course_id: string } & QuestionRow>(
    `SELECT si.id AS item_id, si.position, si.hints_used, si.draft, si.shown_at, EXISTS (SELECT 1 FROM study_attempts a WHERE a.item_id = si.id) AS attempted,
       s.kind AS session_kind, s.status AS session_status, s.course_id, sq.*
     FROM study_items si JOIN study_sessions s ON s.id = si.session_id JOIN study_questions sq ON sq.id = si.question_id
     WHERE si.id = $1 AND si.session_id = $2 AND s.user_id = $3`, [itemId, sessionId, userId]);
}

// ---------------- hints ----------------

export async function takeHint(userId: string, sessionId: string, itemId: string) {
  const it = await loadItem(userId, sessionId, itemId);
  if (!it || it.attempted || it.session_kind === "exam" || it.session_status !== "active") return null;
  const used = Math.min(it.hints.length, it.hints_used + 1);
  await q("UPDATE study_items SET hints_used = $2 WHERE id = $1", [itemId, used]);
  return { hints: it.hints.slice(0, used), remaining: it.hints.length - used };
}

// ---------------- grading ----------------

async function semanticScores(answer: string, rubric: QuestionDraft["rubric"]): Promise<Record<string, number> | undefined> {
  const emb = getEmbedder();
  if (!emb || !answer.trim() || rubric.length > 8) return undefined;
  try {
    const [a, ...ps] = await emb.embed([answer, ...rubric.map((p) => p.text)], "query");
    const cos = (x: number[], y: number[]) => { let d = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { d += x[i]! * y[i]!; nx += x[i]! ** 2; ny += y[i]! ** 2; } return d / Math.sqrt(nx * ny || 1); };
    return Object.fromEntries(rubric.map((p, i) => [p.id, Math.round(cos(a!, ps[i]!) * 1000) / 1000]));
  } catch { return undefined; }
}

export async function grade(qr: QuestionRow, answer: string, opts: { dontKnow?: boolean; selfCheck?: string[] } = {}): Promise<Grade> {
  if (opts.dontKnow) return { verdict: "dont_know", score: 0, points: qr.rubric.map((p) => ({ id: p.id, text: p.text, status: "missing" })), misconceptions: [], grader: "none" };
  if (opts.selfCheck) {
    const points = qr.rubric.map((p) => ({ id: p.id, text: p.text, status: opts.selfCheck!.includes(p.id) ? "met" as const : "missing" as const }));
    return { ...scorePoints(qr.rubric, points, []), points, misconceptions: [], grader: "self" };
  }
  const input = { qtype: qr.qtype, rubric: qr.rubric, misconceptions: qr.misconceptions, options: qr.options, answer };
  if (qr.options?.length) return gradeRule(input);
  const llm = getLLM();
  if (llm && answer.trim()) {
    const g = await gradeLLM(llm, { prompt: qr.prompt, rubric: qr.rubric, answer: qr.answer, evidence: qr.evidence }, answer);
    if (g) {
      // Union with the stated-fact misconception rules (exact cues from the course material).
      const ruleMis = detectMisconceptions(qr.misconceptions, indexAnswer(answer)).map(({ claim, correction }) => ({ claim, correction }));
      const misconceptions = [...g.misconceptions, ...ruleMis.filter((r) => !g.misconceptions.some((m) => m.correction === r.correction))];
      return { ...scorePoints(qr.rubric, g.points, misconceptions), points: g.points, misconceptions, grader: `llm:${llm.provider}:${llm.model}` };
    }
  }
  return gradeRule({ ...input, semantic: await semanticScores(answer, qr.rubric) });
}

async function recordAttempt(c: PoolClient, userId: string, sessionId: string, it: { item_id: string; position: number; hints_used: number; course_id: string } & QuestionRow,
  answer: string, drawing: unknown, g: Grade, durationMs: number | null) {
  const prev = it.concept_id ? await (async () => {
    const r = (await c.query("SELECT * FROM concept_mastery WHERE user_id = $1 AND concept_id = $2 FOR UPDATE", [userId, it.concept_id])).rows[0];
    return r ? rowToMastery(r) : emptyMastery();
  })() : null;
  const next = prev ? applyAttempt(prev, { verdict: g.verdict, score: g.score, level: it.level, qtype: it.qtype, hints: it.hints_used, misconceptions: g.misconceptions.length, now: new Date() }) : null;
  const a = (await c.query<{ id: string }>(
    `INSERT INTO study_attempts (user_id, session_id, item_id, question_id, concept_id, answer, drawing, verdict, score, points, misconceptions, grader, hints_used, duration_ms, mastery_before, mastery_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [userId, sessionId, it.item_id, it.id, it.concept_id, answer.slice(0, 20000), drawing ? JSON.stringify(drawing) : null, g.verdict, g.score,
     JSON.stringify(g.points), JSON.stringify(g.misconceptions), g.grader, it.hints_used, durationMs, prev?.score ?? null, next?.score ?? null])).rows[0]!;
  if (it.concept_id && next) {
    await c.query(
      `INSERT INTO concept_mastery (user_id, concept_id, course_id, attempts, correct, partial, incorrect, levels, score, state, misconceptions, retained, reps, ease, interval_days, last_reviewed, next_review, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (user_id, concept_id) DO UPDATE SET attempts = excluded.attempts, correct = excluded.correct, partial = excluded.partial, incorrect = excluded.incorrect,
         levels = excluded.levels, score = excluded.score, state = excluded.state, misconceptions = excluded.misconceptions, retained = excluded.retained, reps = excluded.reps,
         ease = excluded.ease, interval_days = excluded.interval_days, last_reviewed = excluded.last_reviewed, next_review = excluded.next_review, updated_at = now()`,
      [userId, it.concept_id, it.course_id, next.attempts, next.correct, next.partial, next.incorrect, JSON.stringify(next.levels), next.score, next.state, next.misconceptions,
       next.retained, next.reps, next.ease, next.intervalDays, next.lastReviewed, next.nextReview]);
    for (const m of g.misconceptions)
      await c.query("INSERT INTO misconception_log (user_id, course_id, concept_id, attempt_id, claim, correction) VALUES ($1,$2,$3,$4,$5,$6)", [userId, it.course_id, it.concept_id, a.id, m.claim, m.correction]);
  }
  return { attemptId: a.id, before: prev, after: next };
}

export type AnswerInput = { answer?: string; dontKnow?: boolean; drawing?: unknown; revealChecklist?: boolean; selfCheck?: string[]; durationMs?: number };

/** Practice-style answer: grade now, update mastery, adapt the plan. Exam: store the draft only. */
export async function answerItem(userId: string, sessionId: string, itemId: string, input: AnswerInput) {
  const it = await loadItem(userId, sessionId, itemId);
  if (!it || it.session_status !== "active") return null;
  if (it.attempted) return { error: "already answered" as const };
  const answer = (input.answer ?? "").slice(0, 20000);

  if (it.session_kind === "exam") {
    await q("UPDATE study_items SET draft = $2 WHERE id = $1", [itemId, JSON.stringify({ answer, dontKnow: !!input.dontKnow })]);
    return { saved: true as const };
  }
  if (it.qtype === "diagram" && !input.dontKnow) {
    // Two steps: submit (locks) the drawing and reveal the checklist, then self-check. Text-only models can't grade drawings.
    if (!it.draft?.revealed) {
      if (!input.drawing) return { error: "draw your answer first" as const };
      await q("UPDATE study_items SET draft = $2 WHERE id = $1", [itemId, JSON.stringify({ drawing: input.drawing, answer, revealed: true })]);
      return { checklist: it.rubric.map((p) => ({ id: p.id, text: p.text })), modelAnswer: it.answer, evidence: it.evidence };
    }
    if (!input.selfCheck) return { error: "tick the parts your drawing contains" as const };
  }
  const drawing = it.qtype === "diagram" ? (it.draft?.drawing ?? null) : null;
  const g = await grade(it, answer, { dontKnow: input.dontKnow, selfCheck: it.qtype === "diagram" && !input.dontKnow ? input.selfCheck : undefined });
  const res = await tx(async (c) => {
    const locked = (await c.query("SELECT state FROM study_sessions WHERE id = $1 FOR UPDATE", [sessionId])).rows[0] as { state: PlannerState };
    const r = await recordAttempt(c, userId, sessionId, it, answer, drawing, g, input.durationMs ?? Date.now() - it.shown_at.getTime());
    const st = locked.state;
    if (it.concept_id) adapt(st, it.concept_id, it, g.verdict);
    await c.query("UPDATE study_sessions SET state = $2 WHERE id = $1", [sessionId, JSON.stringify(st)]);
    return r;
  });
  return { attemptId: res.attemptId, stateAfter: res.after?.state ?? null };
}

/** Adaptive plan update: raise difficulty on streaks; on failure teach, check a prerequisite soon, retest differently later. */
function adapt(st: PlannerState, conceptId: string, it: { position: number; level: Level; qtype: QType }, v: Verdict) {
  const a = st.asked[conceptId] ?? { n: 1, types: [it.qtype], lastPos: it.position, levelsOk: [] };
  a.lastVerdict = v;
  if (v === "correct" || v === "mostly") {
    if (!a.levelsOk.includes(it.level)) a.levelsOk.push(it.level);
    st.streak++;
    if (st.streak >= 2) { st.difficulty = Math.min(3, st.difficulty + 1) as 1 | 2 | 3; st.streak = 0; }
  } else {
    st.streak = 0;
    st.difficulty = Math.max(1, st.difficulty - 1) as 1 | 2 | 3;
    const li = LEVELS.indexOf(it.level);
    const pending = (p: Queued["purpose"]) => st.queue.some((x) => x.conceptId === conceptId && x.purpose === p);
    if (li > 0 && (v === "incorrect" || v === "dont_know") && !pending("check"))
      st.queue.push({ conceptId, afterPos: it.position + 1, purpose: "check", level: LEVELS[li - 1]!, avoidTypes: [it.qtype] });
    // One pending retest per concept, at the level that failed, in a different format, a few questions later.
    st.queue = st.queue.filter((x) => !(x.conceptId === conceptId && x.purpose === "retest"));
    st.queue.push({ conceptId, afterPos: it.position + 3, purpose: "retest", level: it.level, avoidTypes: [...new Set([...a.types, it.qtype])] });
  }
  st.asked[conceptId] = a;
}

// ---------------- teaching ----------------

export async function explainItem(userId: string, sessionId: string, itemId: string, mode: "teach" | "why") {
  const it = await loadItem(userId, sessionId, itemId);
  if (!it || (it.session_kind === "exam" && it.session_status === "active")) return null;
  const attempt = await q1<{ answer: string; points: Grade["points"]; misconceptions: Grade["misconceptions"] }>("SELECT answer, points, misconceptions FROM study_attempts WHERE item_id = $1", [itemId]);
  if (mode === "why" && !attempt) return null;
  if (mode === "teach" && !attempt && it.session_kind !== "exam") return null; // explanation comes after an attempt (or "I don't know")
  const missing = attempt?.points.filter((p) => p.status !== "met").map((p) => p.text) ?? [];
  const mis = attempt?.misconceptions.map((m) => `${m.claim} → ${m.correction}`) ?? [];
  const llm = getLLM();
  let text: string | null = null;
  let generator = "rule";
  if (llm) {
    const r = await teachLLM(llm, { mode, question: it.prompt, modelAnswer: it.answer, studentAnswer: attempt?.answer, missing, misconceptions: mis, evidence: it.evidence });
    if (r) { text = r.explanation; generator = `llm:${llm.provider}:${llm.model}`; }
  }
  if (!text) {
    // Deterministic, source-quoting explanation.
    const quotes = it.evidence.slice(0, 3).map((e) => `${e.excerpt.split("\n").filter(Boolean).slice(0, 5).map((l) => `> ${l.slice(0, 200)}`).join("\n")} [${e.n}]`).join("\n\n");
    text = mode === "why"
      ? [attempt!.misconceptions.length ? `**What was wrong:** ${attempt!.misconceptions.map((m) => m.correction).join(" ")}` : "",
         missing.length ? `**What was missing:** ${missing.join("; ")}.` : "",
         `**Expected:** ${it.answer}`, `**From your course:**\n\n${quotes}`].filter(Boolean).join("\n\n")
      : [`**${it.concept_name}** — ${it.explanation || it.answer}`, `**From your course:**\n\n${quotes}`].join("\n\n");
  }
  // After teaching, schedule a small check on the same concept soon, and the original level again later.
  if (mode === "teach" && it.concept_id && it.session_kind !== "exam") {
    await tx(async (c) => {
      const st = (await c.query("SELECT state FROM study_sessions WHERE id = $1 FOR UPDATE", [sessionId])).rows[0]!.state as PlannerState;
      if (!st.queue.some((x) => x.conceptId === it.concept_id && x.purpose === "check"))
        st.queue.unshift({ conceptId: it.concept_id!, afterPos: it.position + 1, purpose: "check", level: "remember", avoidTypes: [it.qtype] });
      await c.query("UPDATE study_sessions SET state = $2 WHERE id = $1", [sessionId, JSON.stringify(st)]);
    });
  }
  return { markdown: text, evidence: it.evidence, generator };
}

// ---------------- exam ----------------

export async function submitExam(userId: string, sessionId: string): Promise<Summary | null> {
  const s = await getSession(userId, sessionId);
  if (!s || s.kind !== "exam" || s.status !== "active") return null;
  const items = await q<{ item_id: string }>("SELECT si.id AS item_id FROM study_items si WHERE si.session_id = $1 AND NOT EXISTS (SELECT 1 FROM study_attempts a WHERE a.item_id = si.id) ORDER BY si.position", [sessionId]);
  for (const { item_id } of items) {
    const it = (await loadItem(userId, sessionId, item_id))!;
    const d = (it.draft ?? {}) as { answer?: string; dontKnow?: boolean };
    const blank = !d.answer?.trim();
    const g = await grade(it, d.answer ?? "", { dontKnow: d.dontKnow || blank });
    await tx(async (c) => { await recordAttempt(c, userId, sessionId, it, d.answer ?? "", null, g, null); });
  }
  return finishSession(userId, sessionId);
}

// ---------------- finishing & summaries ----------------

export async function finishSession(userId: string, sessionId: string): Promise<Summary | null> {
  const s = await getSession(userId, sessionId);
  if (!s) return null;
  if (s.status === "active" && s.kind === "exam") {
    const unanswered = await q1("SELECT 1 FROM study_items si WHERE si.session_id = $1 AND NOT EXISTS (SELECT 1 FROM study_attempts a WHERE a.item_id = si.id) LIMIT 1", [sessionId]);
    if (unanswered) return submitExam(userId, sessionId);
  }
  const summary = await summarize(userId, sessionId);
  await q("UPDATE study_sessions SET status = 'completed', finished_at = coalesce(finished_at, now()), summary = $2 WHERE id = $1 AND user_id = $3", [sessionId, JSON.stringify(summary), userId]);
  return summary;
}

export type Summary = {
  total: number; breakdown: Record<Verdict, number>;
  strong: { conceptId: string; name: string }[];
  needsWork: { conceptId: string; name: string; why: string }[];
  recognizedOnly: { conceptId: string; name: string }[];
  misconceptions: { concept: string; correction: string }[];
  byType: { qtype: QType; n: number; ok: number }[];
  recommended: string[];
};

export async function summarize(userId: string, sessionId: string): Promise<Summary> {
  const rows = await q<{ concept_id: string | null; concept_name: string; qtype: QType; level: Level; verdict: Verdict; misconceptions: Grade["misconceptions"]; hints_used: number }>(
    `SELECT sq.concept_id, sq.concept_name, sq.qtype, sq.level, a.verdict, a.misconceptions, a.hints_used
     FROM study_attempts a JOIN study_questions sq ON sq.id = a.question_id WHERE a.session_id = $1 AND a.user_id = $2 ORDER BY a.answered_at`, [sessionId, userId]);
  const breakdown: Record<Verdict, number> = { correct: 0, mostly: 0, partial: 0, incorrect: 0, dont_know: 0 };
  rows.forEach((r) => breakdown[r.verdict]++);
  const ok = (v: Verdict) => v === "correct" || v === "mostly";
  const byConcept = new Map<string, typeof rows>();
  for (const r of rows) byConcept.set(r.concept_id ?? r.concept_name, [...(byConcept.get(r.concept_id ?? r.concept_name) ?? []), r]);
  const strong: Summary["strong"] = [], needsWork: Summary["needsWork"] = [], recognizedOnly: Summary["recognizedOnly"] = [];
  for (const [id, rs] of byConcept) {
    const name = rs[0]!.concept_name;
    const recog = rs.filter((r) => ["mcq", "tf", "fill"].includes(r.qtype));
    const open = rs.filter((r) => !["mcq", "tf", "fill"].includes(r.qtype));
    if (recog.some((r) => ok(r.verdict)) && open.length && open.every((r) => !ok(r.verdict))) recognizedOnly.push({ conceptId: id, name });
    const last = rs[rs.length - 1]!;
    if (rs.every((r) => ok(r.verdict) && r.hints_used < 2)) strong.push({ conceptId: id, name });
    else if (!ok(last.verdict) || rs.some((r) => !ok(r.verdict))) {
      const failedLevels = [...new Set(rs.filter((r) => !ok(r.verdict)).map((r) => r.level))];
      needsWork.push({ conceptId: id, name, why: ok(last.verdict) ? `recovered after a miss (${failedLevels.join(", ")})` : `missed at ${failedLevels.join(", ")} level` });
    }
  }
  const misconceptions = rows.flatMap((r) => r.misconceptions.map((m) => ({ concept: r.concept_name, correction: m.correction })))
    .filter((m, i, arr) => arr.findIndex((x) => x.correction === m.correction) === i);
  const types = new Map<QType, { n: number; ok: number }>();
  for (const r of rows) { const t = types.get(r.qtype) ?? { n: 0, ok: 0 }; t.n++; if (ok(r.verdict)) t.ok++; types.set(r.qtype, t); }
  const recommended = [
    ...needsWork.slice(0, 3).map((n) => `Review ${n.name}`),
    ...recognizedOnly.slice(0, 2).map((n) => `Practise recalling ${n.name} without options`),
    ...(misconceptions.length ? ["Retry the questions where a misconception was flagged"] : []),
  ];
  if (!recommended.length && rows.length) recommended.push("Come back when reviews are due — spaced practice makes this stick");
  return { total: rows.length, breakdown, strong, needsWork, recognizedOnly, misconceptions, byType: [...types.entries()].map(([qtype, v]) => ({ qtype, ...v })), recommended };
}

// ---------------- overview: coverage, weak areas, due reviews ----------------

export async function weakAreas(userId: string, courseId: string): Promise<Weakness[]> {
  const concepts = await importantConcepts(courseId);
  if (!concepts.length) return [];
  const mastery = new Map((await q<Record<string, unknown>>("SELECT * FROM concept_mastery WHERE user_id = $1 AND course_id = $2", [userId, courseId])).map((r) => [r.concept_id as string, r]));
  const recent = await q<{ concept_id: string; verdicts: Verdict[] }>(
    `SELECT concept_id, (array_agg(verdict ORDER BY answered_at DESC))[1:5] AS verdicts FROM study_attempts WHERE user_id = $1 AND concept_id = ANY($2) GROUP BY concept_id`,
    [userId, concepts.map((c) => c.id)]);
  const mis = await q<{ concept_id: string; claims: string[] }>(
    `SELECT concept_id, array_agg(correction ORDER BY created_at DESC) AS claims FROM misconception_log WHERE user_id = $1 AND course_id = $2 AND created_at > now() - interval '30 days' GROUP BY concept_id`, [userId, courseId]);
  const now = new Date();
  const out: Weakness[] = [];
  for (const c of concepts) {
    const m = mastery.get(c.id);
    const lastVerdict = recent.find((r) => r.concept_id === c.id)?.verdicts[0] ?? null;
    const w = weakness({
      conceptId: c.id, name: c.name, mastery: m ? { ...rowToMastery(m), lastVerdict } : null,
      recentVerdicts: recent.find((r) => r.concept_id === c.id)?.verdicts ?? [], misconceptions: mis.find((r) => r.concept_id === c.id)?.claims ?? [],
      lectureCount: c.lecture_count, now,
    });
    if (w) out.push(w);
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export async function overview(userId: string, courseId: string) {
  if (!(await ownsCourse(userId, courseId))) return null;
  const lectures = await q<{ id: string; number: number | null; title: string }>("SELECT id, number, title FROM lectures WHERE course_id = $1 ORDER BY position", [courseId]);
  const perLecture = await q<{ lecture_id: string; concept_id: string; name: string; state: string | null; next_review: Date | null }>(
    `SELECT DISTINCT ch.lecture_id, k.id AS concept_id, k.name, cm2.state, cm2.next_review
     FROM concepts k JOIN concept_mentions cm ON cm.concept_id = k.id JOIN chunks ch ON ch.id = cm.chunk_id
     LEFT JOIN concept_mastery cm2 ON cm2.concept_id = k.id AND cm2.user_id = $2
     WHERE k.course_id = $1 AND ch.lecture_id IS NOT NULL AND (cm.role IN ('title','definition') OR k.lecture_count >= 2)`, [courseId, userId]);
  const now = Date.now();
  const coverage = lectures.map((l) => {
    const cs = perLecture.filter((r) => r.lecture_id === l.id);
    const count = (st: string) => cs.filter((c) => (c.state ?? "not_started") === st).length;
    return {
      lectureId: l.id, number: l.number, title: l.title, concepts: cs.length,
      states: { mastered: count("mastered"), strong: count("strong"), learning: count("learning"), needs_review: count("needs_review"), not_started: count("not_started") },
      due: cs.filter((c) => c.next_review && c.next_review.getTime() <= now).length,
      untested: cs.filter((c) => !c.state).slice(0, 8).map((c) => ({ id: c.concept_id, name: c.name })),
    };
  });
  const weak = (await weakAreas(userId, courseId));
  const due = await q<{ id: string; name: string; next_review: Date; state: string }>(
    `SELECT k.id, k.name, m.next_review, m.state FROM concept_mastery m JOIN concepts k ON k.id = m.concept_id WHERE m.user_id = $1 AND m.course_id = $2 AND m.next_review <= now() ORDER BY m.next_review LIMIT 30`, [userId, courseId]);
  const upcoming = await q<{ day: string; n: number }>(
    `SELECT to_char(date_trunc('day', next_review), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM concept_mastery WHERE user_id = $1 AND course_id = $2 AND next_review > now() AND next_review < now() + interval '14 days' GROUP BY 1 ORDER BY 1`, [userId, courseId]);
  const sessions = await q<{ id: string; kind: string; scope: Scope; status: string; started_at: Date; finished_at: Date | null; summary: Summary | null; answered: number; items: number }>(
    `SELECT s.id, s.kind, s.scope, s.status, s.started_at, s.finished_at, s.summary,
       (SELECT count(*)::int FROM study_attempts a WHERE a.session_id = s.id) AS answered, (SELECT count(*)::int FROM study_items i WHERE i.session_id = s.id) AS items
     FROM study_sessions s WHERE s.user_id = $1 AND s.course_id = $2 AND s.status <> 'abandoned' ORDER BY s.started_at DESC LIMIT 8`, [userId, courseId]);
  const byType = await q<{ qtype: string; n: number; ok: number }>(
    `SELECT sq.qtype, count(*)::int AS n, count(*) FILTER (WHERE a.verdict IN ('correct','mostly'))::int AS ok
     FROM study_attempts a JOIN study_questions sq ON sq.id = a.question_id WHERE a.user_id = $1 AND sq.course_id = $2 GROUP BY 1 ORDER BY 2 DESC`, [userId, courseId]);
  const distinct = new Map(perLecture.map((r) => [r.concept_id, r.state]));
  return {
    totals: { concepts: distinct.size, tested: [...distinct.values()].filter(Boolean).length },
    coverage, weak: weak.slice(0, 12), due, upcoming, sessions, byType,
    capability: { llm: !!getLLM(), embeddings: !!getEmbedder() },
    stateLabels: STATE_LABEL,
  };
}

/** Mastery for one concept (concept page). */
export async function conceptStudy(userId: string, conceptId: string) {
  const m = await q1<Record<string, unknown>>("SELECT * FROM concept_mastery WHERE user_id = $1 AND concept_id = $2", [userId, conceptId]);
  const mis = await q<{ correction: string; n: number }>("SELECT correction, count(*)::int AS n FROM misconception_log WHERE user_id = $1 AND concept_id = $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 5", [userId, conceptId]);
  return m ? { ...rowToMastery(m), stateLabel: STATE_LABEL[m.state as MasteryState], misconceptionList: mis } : null;
}
