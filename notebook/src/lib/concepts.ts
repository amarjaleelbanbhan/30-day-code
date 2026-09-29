import "server-only";
// Concept index built deterministically from the course's own material:
//   candidates  ← slide/page titles, note headings, "Term: definition" / "A term is a …" lines, stated abbreviations
//   mentions    ← full-text phrase matches of each concept (or its aliases) in every chunk
//   relations   ← part_of (name containment, e.g. "CPU scheduling" ⊂ "scheduling") or co-occurrence in ≥ 2 chunks
// No LLM is involved, so no relation exists without textual evidence.
import { q, q1, tx } from "./db";
import { normConcept, tokens } from "./query";

const GENERIC = new Set([
  "introduction", "intro", "overview", "summary", "agenda", "outline", "contents", "table of content", "recap", "review",
  "question", "questions", "q a", "qa", "any question", "thank you", "thanks", "reference", "references", "reading", "readings",
  "objective", "objectives", "learning objective", "learning outcome", "goal", "goals", "example", "examples", "exercise",
  "exercises", "homework", "assignment", "quiz", "lab", "note", "notes", "conclusion", "conclusions", "motivation",
  "background", "definition", "definitions", "key point", "key points", "today", "announcement", "announcements", "untitled",
  "my notes", "drawing", "sketch", "doubt", "doubts", "important", "diagram", "figure", "chapter", "part", "appendix", "course outline", "syllabus",
]);
const PREFIX = /^(?:(?:my\s+)?notes?\s+(?:on|about)|introduction to|intro to|overview of|basics of|types of|kinds of|examples of|example of|more on|the|an?|what is an?|what are)\s+/i;
const DEF_COLON = /^\s*(?:[-•*▪◦]\s*)?([A-Za-z][A-Za-z0-9 ()/-]{1,48}?)\s*(?::|—|–|\s-\s)\s+\S/;
const DEF_IS = /^\s*(?:[-•*▪◦]\s*)?(?:An?|The)\s+([a-z][a-z0-9 -]{1,40}?)\s+(?:is|are)\s+(?:an?|the|defined as|a kind of)\b/i;

export type Candidate = { name: string; norm: string; origin: "title" | "heading" | "definition" | "acronym"; aliases: string[] };

function cleanName(raw: string): string | null {
  let s = raw.replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*\((?:cont(?:inued|'d|\.)?|contd\.?)\)\s*$/i, "")
    .replace(/(?:\s*[-–—:,]\s*|\s+)(?:(?:part|pt\.?)\s*\d+|cont(?:inued|'d|\.)|\d+)\s*$/i, "")
    .replace(/(?:\s*[-–—:,]\s*|\s+)[IVX]{1,4}\s*$/, "").replace(/^\s*(?:lecture|chapter|week|part|section|slide)\s*\d+\s*[:.–—-]?\s*/i, "")
    .replace(/[:.;,!?]+$/, "").replace(/\s+/g, " ").trim();
  while (PREFIX.test(s)) s = s.replace(PREFIX, "");
  const words = s.split(" ");
  if (!s || s.length < 2 || words.length > 5 || /^\d/.test(s) || /[=<>{}]/.test(s)) return null;
  const norm = normConcept(s);
  if (!norm || GENERIC.has(norm) || norm.length < 3) return null;
  if (tokens(s).every((t) => GENERIC.has(t) || t.length < 3)) return null;
  return s;
}

/** Candidate concepts from one chunk (pure; unit-tested). */
export function candidatesFrom(chunk: { section: string | null; text: string; content_type: string; source_type: string }): Candidate[] {
  const out: Candidate[] = [];
  const add = (raw: string, origin: Candidate["origin"], aliases: string[] = []) => {
    const name = cleanName(raw);
    if (name) out.push({ name, norm: normConcept(name), origin, aliases });
  };
  if (chunk.section && chunk.content_type !== "speaker_notes") add(chunk.section, chunk.source_type === "note" ? "heading" : "title");
  for (const line of chunk.text.split("\n").slice(0, 60)) {
    const m = line.match(DEF_COLON) ?? line.match(DEF_IS);
    if (m && m[1]!.split(/\s+/).length <= 4) add(m[1]!, "definition");
  }
  return out;
}

const titleCase = (s: string) => (s === s.toLowerCase() ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

/** Rebuilds the concept index for a course. Concept ids are stable across rebuilds (keyed by normalized name). */
export async function buildConcepts(courseId: string): Promise<void> {
  const chunks = await q<{ id: string; section: string | null; text: string; content_type: string; source_type: string; source_kind: string }>(
    `SELECT id, section, text, content_type, source_type, source_kind FROM chunks WHERE course_id = $1 AND source_kind <> 'ai_note'`, [courseId]);
  const cands = new Map<string, { names: Map<string, number>; origin: Candidate["origin"]; aliases: Set<string> }>();
  const bump = (c: Candidate) => {
    const e = cands.get(c.norm) ?? { names: new Map(), origin: c.origin, aliases: new Set<string>() };
    e.names.set(c.name, (e.names.get(c.name) ?? 0) + 1);
    c.aliases.forEach((a) => e.aliases.add(a));
    if (c.origin === "title" || e.origin === "definition") e.origin = c.origin;
    cands.set(c.norm, e);
  };
  const defPairs: [string, string][] = []; // (norm, chunk_id) where the chunk states a definition of the concept
  for (const ch of chunks) for (const cand of candidatesFrom(ch)) {
    bump(cand);
    if (cand.origin === "definition") defPairs.push([cand.norm, ch.id]);
  }
  for (const a of await q<{ alias: string; expansion: string }>("SELECT alias, expansion FROM course_aliases WHERE course_id = $1", [courseId])) {
    const name = cleanName(a.expansion);
    if (!name) continue;
    bump({ name: titleCase(name), norm: normConcept(name), origin: "acronym", aliases: [a.alias] });
    const e = cands.get(normConcept(name))!;
    e.aliases.add(a.alias);
  }
  // An alias that is itself a candidate (e.g. "PCB" heading) folds into its expansion.
  for (const [norm, e] of cands) for (const al of e.aliases) if (al !== norm && cands.has(al)) { cands.get(al)!.names.forEach((n, k) => e.names.set(k, n)); cands.delete(al); }

  await tx(async (c) => {
    const keep: string[] = [];
    for (const [norm, e] of cands) {
      // Display name: prefer the singular form as written in the material, then the most frequent spelling.
      const singular = (n: string) => normConcept(n) === n.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      const name = [...e.names.entries()].sort((a, b) => Number(singular(b[0])) - Number(singular(a[0])) || b[1] - a[1] || a[0].length - b[0].length)[0]![0];
      const r = await c.query<{ id: string }>(
        `INSERT INTO concepts (course_id, name, norm, aliases, origin) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (course_id, norm) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, origin = excluded.origin
         RETURNING id`, [courseId, titleCase(name), norm, [...e.aliases], e.origin]);
      keep.push(r.rows[0]!.id);
    }
    await c.query("DELETE FROM concepts WHERE course_id = $1 AND NOT (id = ANY($2::uuid[]))", [courseId, keep]);
    await c.query("DELETE FROM concept_mentions cm USING concepts k WHERE k.id = cm.concept_id AND k.course_id = $1", [courseId]);
    // Mentions: phrase match of the name (stemmed) or any alias. One indexed lookup per concept (GIN on tsv).
    const qs = (await c.query<{ id: string; tq: string | null; name: string }>(
      `SELECT k.id, k.name, (SELECT string_agg('(' || x::text || ')', ' | ')
               FROM (SELECT phraseto_tsquery('english', k.norm) AS x UNION ALL SELECT phraseto_tsquery('english', al) FROM unnest(k.aliases) al) p
               WHERE x::text <> '') AS tq
       FROM concepts k WHERE k.course_id = $1`, [courseId])).rows;
    for (const k of qs) {
      if (!k.tq) continue;
      await c.query(
        `INSERT INTO concept_mentions (concept_id, chunk_id, role)
         SELECT $2, ch.id,
           CASE WHEN ch.section IS NOT NULL AND ch.content_type <> 'speaker_notes'
                     AND length(regexp_replace(ch.section, '\\s*\\([^)]*\\)\\s*$', '')) <= length($4) + 3
                     AND to_tsvector('english', ch.section) @@ $3::tsquery THEN 'title' ELSE 'mention' END
         FROM chunks ch WHERE ch.course_id = $1 AND ch.tsv @@ $3::tsquery AND ch.source_kind <> 'ai_note'`,
        [courseId, k.id, k.tq, k.name]);
    }
    // A shorter concept that only occurs inside a longer concept's name in a passage ("process control" inside
    // "process control block") is not really mentioned there.
    const overlaps = (await c.query<{ a: string; chunk_id: string; text: string; an: string; bn: string }>(
      `SELECT ka.id AS a, ch.id AS chunk_id, ch.text || ' ' || coalesce(ch.section, '') AS text, ka.norm AS an, kb.norm AS bn
       FROM concept_mentions ma JOIN concept_mentions mb ON mb.chunk_id = ma.chunk_id AND mb.concept_id <> ma.concept_id
       JOIN concepts ka ON ka.id = ma.concept_id JOIN concepts kb ON kb.id = mb.concept_id JOIN chunks ch ON ch.id = ma.chunk_id
       WHERE ka.course_id = $1 AND ma.role <> 'title' AND length(kb.norm) > length(ka.norm)
         AND (' ' || kb.norm || ' ') LIKE ('% ' || ka.norm || ' %')`, [courseId])).rows;
    const count = (hay: string, needle: string) => hay.split(` ${needle} `).length - 1;
    const drop = new Map<string, string[]>();
    const normCache = new Map<string, string>();
    for (const o of overlaps) {
      const t = normCache.get(o.chunk_id) ?? ` ${normConcept(o.text)} `;
      normCache.set(o.chunk_id, t);
      if (count(t, o.an) <= count(t, o.bn)) drop.set(o.a, [...(drop.get(o.a) ?? []), o.chunk_id]);
    }
    for (const [conceptId, chunkIds] of drop)
      await c.query("DELETE FROM concept_mentions WHERE concept_id = $1 AND chunk_id = ANY($2)", [conceptId, chunkIds]);
    await c.query(
      `UPDATE concept_mentions cm SET role = 'definition'
       FROM concepts k, unnest($2::text[], $3::uuid[]) AS d(norm, chunk_id)
       WHERE k.course_id = $1 AND k.norm = d.norm AND cm.concept_id = k.id AND cm.chunk_id = d.chunk_id AND cm.role = 'mention'`,
      [courseId, defPairs.map((d) => d[0]), defPairs.map((d) => d[1])]);
    await c.query(
      `UPDATE concepts k SET mention_count = s.n, lecture_count = s.l, first_position = s.fp
       FROM (SELECT cm.concept_id, count(*) AS n, count(DISTINCT ch.lecture_id) AS l, min(le.position) AS fp
             FROM concept_mentions cm JOIN chunks ch ON ch.id = cm.chunk_id LEFT JOIN lectures le ON le.id = ch.lecture_id
             GROUP BY cm.concept_id) s
       WHERE s.concept_id = k.id AND k.course_id = $1`, [courseId]);
    await c.query("DELETE FROM concepts WHERE course_id = $1 AND mention_count = 0", [courseId]);

    await c.query("DELETE FROM concept_relations r USING concepts k WHERE k.id = r.a AND k.course_id = $1", [courseId]);
    // part_of: the narrower concept's name contains the broader one's name as whole words.
    await c.query(
      `INSERT INTO concept_relations (a, b, kind, evidence, sample_chunk)
       SELECT n.id, br.id, 'part_of',
         (SELECT count(*) FROM concept_mentions x WHERE x.concept_id = n.id),
         (SELECT x.chunk_id FROM concept_mentions x WHERE x.concept_id = n.id LIMIT 1)
       FROM concepts n JOIN concepts br ON br.course_id = n.course_id AND br.id <> n.id
       WHERE n.course_id = $1 AND (' ' || n.norm || ' ') LIKE ('% ' || br.norm || ' %') AND length(n.norm) > length(br.norm)`, [courseId]);
    // cooccurs: both concepts mentioned in at least two of the same chunks.
    await c.query(
      `INSERT INTO concept_relations (a, b, kind, evidence, sample_chunk)
       SELECT m1.concept_id, m2.concept_id, 'cooccurs', count(*), (array_agg(m1.chunk_id))[1]
       FROM concept_mentions m1 JOIN concept_mentions m2 ON m2.chunk_id = m1.chunk_id AND m1.concept_id < m2.concept_id
       JOIN concepts k ON k.id = m1.concept_id
       WHERE k.course_id = $1
       GROUP BY 1, 2 HAVING count(*) >= 2
       ON CONFLICT DO NOTHING`, [courseId]);
  });
}

// ---------------- reads ----------------

export type ConceptRow = { id: string; name: string; aliases: string[]; mention_count: number; lecture_count: number; first_lecture: number | null };

export const listConcepts = (userId: string, courseId: string) =>
  q<ConceptRow>(
    `SELECT k.id, k.name, k.aliases, k.mention_count, k.lecture_count,
       (SELECT l.number FROM lectures l WHERE l.course_id = k.course_id AND l.position = k.first_position LIMIT 1) AS first_lecture
     FROM concepts k JOIN courses c ON c.id = k.course_id WHERE k.course_id = $1 AND c.user_id = $2
     ORDER BY lower(k.name)`, [courseId, userId]);

/** Best concept for a free-text topic: exact normalized name, alias, then close spelling. */
export async function matchConcept(courseId: string, topic: string) {
  const norm = normConcept(topic);
  if (!norm) return null;
  return q1<{ id: string; name: string; norm: string; aliases: string[] }>(
    `SELECT id, name, norm, aliases FROM concepts WHERE course_id = $1
       AND (norm = $2 OR $2 = ANY(aliases) OR similarity(norm, $2) >= 0.55)
     ORDER BY (norm = $2) DESC, ($2 = ANY(aliases)) DESC, similarity(norm, $2) DESC, mention_count DESC LIMIT 1`, [courseId, norm]);
}

/** Narrower concepts named after this one (e.g. "process" → "process state", "process control block"). */
export const narrowerConcepts = (conceptId: string, limit = 8) =>
  q<{ id: string; name: string; norm: string; aliases: string[] }>(
    `SELECT k.id, k.name, k.norm, k.aliases FROM concept_relations r JOIN concepts k ON k.id = r.a
     WHERE r.b = $1 AND r.kind = 'part_of' ORDER BY k.mention_count DESC LIMIT $2`, [conceptId, limit]);

export async function relatedConcepts(conceptId: string, limit = 12) {
  return q<{ id: string; name: string; kind: string; evidence: number; direction: "narrower" | "broader" | "related" }>(
    `SELECT k.id, k.name, r.kind, r.evidence,
       CASE WHEN r.kind = 'part_of' AND r.b = $1 THEN 'narrower' WHEN r.kind = 'part_of' THEN 'broader' ELSE 'related' END AS direction
     FROM concept_relations r JOIN concepts k ON k.id = CASE WHEN r.a = $1 THEN r.b ELSE r.a END
     WHERE r.a = $1 OR r.b = $1
     ORDER BY (r.kind = 'part_of') DESC, r.evidence DESC, k.name LIMIT $2`, [conceptId, limit]);
}

export async function getConcept(userId: string, conceptId: string) {
  return q1<{ id: string; course_id: string; name: string; norm: string; aliases: string[]; mention_count: number; lecture_count: number }>(
    `SELECT k.id, k.course_id, k.name, k.norm, k.aliases, k.mention_count, k.lecture_count
     FROM concepts k JOIN courses c ON c.id = k.course_id WHERE k.id = $1 AND c.user_id = $2`, [conceptId, userId]);
}

/** Concepts shared by several lectures (for cross-lecture connections), with the chunks that evidence each. */
export const sharedConcepts = (courseId: string, lectureIds: string[]) =>
  q<{ concept_id: string; name: string; lecture_ids: string[]; chunk_ids: string[] }>(
    `SELECT k.id AS concept_id, k.name, array_agg(DISTINCT ch.lecture_id) AS lecture_ids, (array_agg(ch.id ORDER BY ch.page_no NULLS LAST))[1:6] AS chunk_ids
     FROM concepts k JOIN concept_mentions cm ON cm.concept_id = k.id JOIN chunks ch ON ch.id = cm.chunk_id
     WHERE k.course_id = $1 AND ch.lecture_id = ANY($2)
     GROUP BY k.id, k.name HAVING count(DISTINCT ch.lecture_id) >= 2
     ORDER BY count(DISTINCT ch.lecture_id) DESC, count(*) DESC LIMIT 20`, [courseId, lectureIds]);

/** For a lecture: its concepts that also appear in earlier lectures, with the earliest earlier mention. */
export const earlierConnections = (lectureId: string) =>
  q<{ name: string; chunk_id: string; lecture_number: number | null }>(
    `WITH mine AS (
       SELECT DISTINCT k.id, k.name FROM concepts k JOIN concept_mentions cm ON cm.concept_id = k.id JOIN chunks ch ON ch.id = cm.chunk_id
       WHERE ch.lecture_id = $1)
     SELECT DISTINCT ON (mine.id) mine.name, ch.id AS chunk_id, l.number AS lecture_number
     FROM mine JOIN concept_mentions cm ON cm.concept_id = mine.id JOIN chunks ch ON ch.id = cm.chunk_id
     JOIN lectures l ON l.id = ch.lecture_id JOIN lectures me ON me.id = $1
     WHERE l.course_id = me.course_id AND l.position < me.position
     ORDER BY mine.id, l.position, (cm.role = 'title') DESC, ch.page_no NULLS LAST
     LIMIT 15`, [lectureId]);

export type ConceptEvidence = {
  chunk_id: string; lecture_id: string | null; lecture_number: number | null; lecture_title: string | null; lecture_position: number | null;
  material_id: string | null; note_id: string | null; source_kind: string; content_type: string; filename: string | null;
  page_no: number | null; section: string | null; anchor: string | null; content: string; role: string;
};

/** Everything the concept page shows, all from indexed evidence. */
export async function conceptDetail(userId: string, conceptId: string) {
  const concept = await getConcept(userId, conceptId);
  if (!concept) return null;
  const evidence = await q<ConceptEvidence>(
    `SELECT ch.id AS chunk_id, ch.lecture_id, l.number AS lecture_number, l.title AS lecture_title, l.position AS lecture_position,
       ch.material_id, ch.note_id, ch.source_kind, ch.content_type, m.filename, ch.page_no, ch.section, ch.anchor, ch.text AS content, cm.role
     FROM concept_mentions cm JOIN chunks ch ON ch.id = cm.chunk_id
     LEFT JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id
     WHERE cm.concept_id = $1
     ORDER BY l.position NULLS LAST, ch.source_type, ch.page_no NULLS LAST, (ch.content_type = 'speaker_notes'), ch.ord
     LIMIT 400`, [conceptId]);
  const related = await relatedConcepts(conceptId, 16);
  return { concept, evidence, related };
}
