import "server-only";
// Hybrid course retrieval. Everything runs in PostgreSQL and is scoped to one course owned by the user.
//
//   query → content terms → (stem presence, typo correction via course vocabulary, abbreviation aliases)
//         → keyword  : OR-tsquery over stems/phrases, ranked by term coverage then ts_rank (titles weighted)
//         → semantic : cosine similarity over vectors from the *current* embedder only
//         → fuzzy    : trigram word similarity (short queries)
//         → reciprocal-rank fusion + coverage/exact-phrase bonus × evidence-class weight (+ query hint)
import { getEmbedder } from "./ai/provider";
import { q } from "./db";
import type { SourceHint } from "./intent";
import { contentTerms, tokens } from "./query";

export type SourceKind = "slides" | "teacher_notes" | "book" | "outline" | "other" | "student_notes" | "ai_note" | "image" | "notes" | "syllabus";

export type Hit = {
  chunk_id: string;
  course_id: string;
  lecture_id: string | null;
  lecture_number: number | null;
  lecture_title: string | null;
  lecture_position: number | null;
  material_id: string | null;
  note_id: string | null;
  source_type: "material" | "note";
  source_kind: SourceKind;
  content_type: string;          // slide | speaker_notes | page | document | note | drawing | ai_note
  filename: string | null;
  page_no: number | null;
  slide_no: number | null;
  section: string | null;
  anchor: string | null;
  content: string;
  score: number;
  methods: string[];             // keyword | semantic | fuzzy | exact | alias | typo
  method_scores: Record<string, number>;
};

export type Analysis = {
  terms: string[];
  corrections: Record<string, string>;
  aliases: { alias: string; expansion: string }[];
  /** Content terms absent from the course (no stem match, no close spelling). */
  missing: string[];
  /** Number of chunks containing each present term (after correction). */
  df: Record<string, number>;
  /** False when the rarest query term never occurs together with any other query term in one passage. */
  cohesive: boolean;
  rarest: string | null;
  semantic: { available: boolean; model: string | null; top: number | null };
};

export type SearchOpts = {
  lectureIds?: string[];
  sourceKinds?: string[];
  contentTypes?: string[];
  excludeContentTypes?: string[];
  limit?: number;
  hint?: SourceHint;
  /** Additional phrases to search (e.g. concept aliases). */
  extraPhrases?: string[];
};

export type SearchTrace = { keyword: TraceRow[]; semantic: TraceRow[]; fuzzy: TraceRow[]; fused: TraceRow[] };
type TraceRow = { chunk_id: string; label: string; score: number };

const COLS = `ch.id AS chunk_id, ch.course_id, ch.lecture_id, l.number AS lecture_number, l.title AS lecture_title, l.position AS lecture_position,
  ch.material_id, ch.note_id, ch.source_type, ch.source_kind, ch.content_type, m.filename, ch.page_no,
  CASE WHEN ch.content_type IN ('slide','speaker_notes') THEN ch.page_no END AS slide_no, ch.section, ch.anchor, ch.text AS content`;
const FROM = `FROM chunks ch JOIN courses c ON c.id = ch.course_id
  LEFT JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id`;
const WHERE = `WHERE ch.course_id = $1 AND c.user_id = $2
  AND ($3::uuid[] IS NULL OR ch.lecture_id = ANY($3))
  AND ($4::text[] IS NULL OR ch.source_kind = ANY($4))
  AND ($5::text[] IS NULL OR ch.content_type = ANY($5))
  AND ($6::text[] IS NULL OR NOT ch.content_type = ANY($6))`;

/** Evidence hierarchy: course material > speaker notes > student notes > book > AI notes. */
export function sourceWeight(h: Pick<Hit, "source_kind" | "content_type"> & { section?: string | null }, hint: SourceHint = null): number {
  let w =
    h.content_type === "speaker_notes" ? 0.97
    : h.source_kind === "slides" || h.source_kind === "teacher_notes" ? 1
    : h.source_kind === "student_notes" ? (h.content_type === "drawing" ? 0.9 : 0.93)
    : h.source_kind === "outline" || h.source_kind === "other" ? 0.85
    : h.source_kind === "book" ? 0.8
    : h.source_kind === "ai_note" ? 0.6
    : 0.85;
  if (h.section && /^\s*(lecture|week|chapter|session)\s*\d+\b/i.test(h.section) && h.content_type !== "speaker_notes") w *= 0.6; // title slides
  if (hint === "teacher" && (h.content_type === "speaker_notes" || h.source_kind === "teacher_notes")) w *= 1.35;
  if (hint === "teacher" && h.source_kind === "slides") w *= 1.1;
  if (hint === "notes" && h.source_kind === "student_notes") w *= 1.4;
  if (hint === "book" && h.source_kind === "book") w *= 1.4;
  return w;
}

type Raw = Omit<Hit, "score" | "methods" | "method_scores"> & { s: number; matched?: number; exact?: boolean };

export async function analyze(courseId: string, query: string, extraPhrases: string[] = []): Promise<Omit<Analysis, "semantic"> & { phrases: string[] }> {
  const terms = contentTerms(query);
  const lower = query.toLowerCase();
  const [presence, aliasRows] = await Promise.all([
    terms.length
      ? q<{ t: string; df: number; present: boolean; fix: string | null; sim: number | null }>(
          `SELECT t, (SELECT count(*)::int FROM chunks WHERE course_id = $1 AND tsv @@ plainto_tsquery('english', t)) AS df,
                  EXISTS (SELECT 1 FROM chunks WHERE course_id = $1 AND tsv @@ plainto_tsquery('english', t))
                     OR EXISTS (SELECT 1 FROM course_terms WHERE course_id = $1 AND term = t) AS present,
                  fx.term AS fix, fx.sim
           FROM unnest($2::text[]) AS t
           LEFT JOIN LATERAL (SELECT term, similarity(term, t) AS sim FROM course_terms
                              WHERE course_id = $1 AND length(t) >= 4 AND term % t AND term <> t ORDER BY sim DESC, term LIMIT 1) fx ON true`,
          [courseId, terms])
      : Promise.resolve([]),
    q<{ alias: string; expansion: string }>(
      `SELECT DISTINCT alias, expansion FROM course_aliases WHERE course_id = $1
         AND (alias = ANY($2::text[]) OR position(expansion IN $3) > 0)`, [courseId, terms, lower]),
  ]);
  const corrections: Record<string, string> = {};
  const missing: string[] = [];
  const df: Record<string, number> = {};
  for (const r of presence) {
    if (r.present) { df[r.t] = r.df; continue; }
    if (r.fix && (r.sim ?? 0) >= 0.4) corrections[r.t] = r.fix;
    else missing.push(r.t);
  }
  // Abbreviation expansions count as presence ("IPC" present if "inter-process communication" is).
  const aliasCovered = new Set(aliasRows.flatMap((a) => [a.alias, ...a.expansion.split(" ")]));
  const stillMissing = missing.filter((t) => !aliasCovered.has(t));
  const phrases = [...new Set([...aliasRows.flatMap((a) => [a.alias, a.expansion]), ...extraPhrases.map((p) => p.toLowerCase())])];
  // Cohesion: does the rarest present term ever appear together with another query term?
  // ("quantum operating systems" → "quantum" only occurs in "time quantum", never near "operating system".)
  const present = Object.keys(df).filter((t) => df[t]! > 0).sort((a, b) => df[a]! - df[b]!);
  const rarest = present[0] ?? null;
  let cohesive = true;
  if (rarest && present.length >= 2) {
    const r = await q<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM chunks WHERE course_id = $1 AND tsv @@ plainto_tsquery('english', $2)
         AND tsv @@ (SELECT string_agg('(' || plainto_tsquery('english', o)::text || ')', ' | ')::tsquery FROM unnest($3::text[]) o
                     WHERE plainto_tsquery('english', o)::text <> '')) AS ok`, [courseId, rarest, present.slice(1)]);
    cohesive = !!r[0]?.ok;
  }
  return { terms, corrections, aliases: aliasRows, missing: stillMissing, phrases, df, cohesive, rarest };
}

export async function search(
  userId: string, courseId: string, query: string, opts: SearchOpts = {},
): Promise<{ hits: Hit[]; analysis: Analysis; trace: SearchTrace }> {
  const limit = opts.limit ?? 20;
  const pool = Math.max(limit * 3, 60);
  const base = [courseId, userId, opts.lectureIds?.length ? opts.lectureIds : null, opts.sourceKinds ?? null, opts.contentTypes ?? null, opts.excludeContentTypes ?? null];
  const a = await analyze(courseId, query, opts.extraPhrases);
  // Present terms and stated aliases count toward coverage; typo corrections only widen recall (they may be wrong).
  const words = [...new Set(a.terms.filter((t) => !a.missing.includes(t) && !(t in a.corrections)))];
  const fixes = [...new Set(Object.values(a.corrections))];
  const phrase = adjacentRun(query, a.terms).map((t) => a.corrections[t] ?? t).join(" ");

  const keyword = words.length || a.phrases.length || fixes.length
    ? q<Raw>(
        `WITH parts AS (
           SELECT plainto_tsquery('english', x) AS tq, true AS counts FROM unnest($7::text[]) x
           UNION ALL SELECT phraseto_tsquery('english', x), true FROM unnest($8::text[]) x
           UNION ALL SELECT plainto_tsquery('english', x), $10::boolean FROM unnest($11::text[]) x),
         good AS (SELECT tq, counts FROM parts WHERE tq::text <> ''),
         qq AS (SELECT (SELECT string_agg('(' || tq::text || ')', ' | ') FROM good)::tsquery AS tq, (SELECT count(*) FROM good WHERE counts) AS n)
         SELECT ${COLS}, ts_rank_cd(ch.tsv, qq.tq, 1) AS s,
           (SELECT count(*) FROM good g WHERE g.counts AND ch.tsv @@ g.tq)::float / greatest(qq.n, 1) AS matched,
           ($9 <> '' AND ch.tsv @@ phraseto_tsquery('english', $9)) AS exact
         ${FROM}, qq ${WHERE} AND qq.tq IS NOT NULL AND ch.tsv @@ qq.tq
         ORDER BY matched DESC, exact DESC, s DESC LIMIT ${pool}`,
        [...base, words, a.phrases, phrase, !words.length && !a.phrases.length, fixes])
    : Promise.resolve([] as Raw[]);

  const fuzzyText = [...words, ...fixes].join(" ");
  const fuzzy = fuzzyText && words.length + fixes.length <= 5
    ? q<Raw>(
        `SELECT ${COLS}, word_similarity($7, ch.text) AS s ${FROM} ${WHERE} AND $7 <% ch.text ORDER BY s DESC LIMIT ${pool}`,
        [...base, fuzzyText])
    : Promise.resolve([] as Raw[]);

  const emb = getEmbedder();
  const semantic: Promise<Raw[]> = emb
    ? emb.embed([query], "query").then(([v]) =>
        q<Raw>(
          `SELECT ${COLS}, 1 - (ch.embedding <=> $7::vector) AS s ${FROM} ${WHERE} AND ch.embedding_model = $8
           ORDER BY ch.embedding <=> $7::vector LIMIT ${pool}`,
          [...base, `[${v!.join(",")}]`, emb.key]))
      .catch((e) => { console.error("semantic search unavailable:", e instanceof Error ? e.message : e); return [] as Raw[]; })
    : Promise.resolve([]);

  const [kw, sem, fz] = await Promise.all([keyword, semantic, fuzzy]);
  const hits = fuse({ keyword: kw, semantic: sem, fuzzy: fz }, opts.hint ?? null, a).slice(0, limit);
  const lab = (r: Raw | Hit) => citationLabel(r as Hit);
  const tr = (rows: (Raw | Hit)[], key: "s" | "score") => rows.slice(0, 15).map((r) => ({ chunk_id: r.chunk_id, label: lab(r), score: round((r as Record<string, unknown>)[key] as number) }));
  return {
    hits,
    analysis: { ...a, semantic: { available: !!emb, model: emb?.key ?? null, top: sem[0] ? round(sem[0].s) : null } },
    trace: { keyword: tr(kw, "s"), semantic: tr(sem, "s"), fuzzy: tr(fz, "s"), fused: tr(hits, "score") },
  };
}

/** Longest run (≥ 2) of content terms that are adjacent in the original query — the only honest "exact phrase". */
export function adjacentRun(query: string, terms: string[]): string[] {
  const set = new Set(terms);
  let best: string[] = [], cur: string[] = [];
  for (const t of tokens(query)) {
    if (set.has(t)) { cur.push(t); if (cur.length > best.length) best = [...cur]; }
    else cur = [];
  }
  return best.length >= 2 ? best : [];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const K = 20;

/** Weighted reciprocal-rank fusion + coverage/exact bonuses, scaled by evidence class. */
export function fuse(lists: { keyword: Raw[]; semantic: Raw[]; fuzzy: Raw[] }, hint: SourceHint, a?: Pick<Analysis, "corrections" | "aliases">): Hit[] {
  const W = { keyword: 1, semantic: 1, fuzzy: 0.35 } as const;
  const acc = new Map<string, Hit>();
  const semTop = lists.semantic[0]?.s ?? 0;
  for (const [method, list] of Object.entries(lists) as [keyof typeof W, Raw[]][]) {
    list.forEach((r, rank) => {
      const { s, matched, exact, ...rest } = r;
      const h = acc.get(r.chunk_id) ?? { ...rest, score: 0, methods: [], method_scores: {} };
      h.score += W[method] / (K + rank + 1);
      h.methods.push(method);
      h.method_scores[method] = round(Number(s));
      if (method === "semantic" && semTop > 0) h.score += 0.035 * Math.max(0, Number(s)) / semTop; // similarity magnitude, not just rank
      if (method === "keyword") {
        h.score += 0.03 * Number(matched ?? 0);         // prefer chunks covering more of the question
        if (exact) { h.score += 0.02; h.methods.push("exact"); }
      }
      acc.set(r.chunk_id, h);
    });
  }
  const typo = a && Object.keys(a.corrections).length > 0;
  const alias = a && a.aliases.length > 0;
  return [...acc.values()]
    .map((h) => {
      if (typo && h.methods.includes("keyword")) h.methods.push("typo");
      if (alias && h.methods.includes("keyword")) h.methods.push("alias");
      return { ...h, score: round(h.score * sourceWeight(h, hint) * 100) / 100 };
    })
    .sort((x, y) => y.score - x.score || (x.lecture_position ?? 1e9) - (y.lecture_position ?? 1e9) || (x.page_no ?? 1e9) - (y.page_no ?? 1e9) || x.chunk_id.localeCompare(y.chunk_id));
}

// ---------------- structured fetches ----------------

/** All chunks of the given lectures in reading order: slides/pages (with their speaker notes), then the student's notes. */
export const lectureChunks = (userId: string, lectureIds: string[]) =>
  q<Hit>(
    `SELECT ${COLS}, 0::float AS score, ARRAY['lecture']::text[] AS methods, '{}'::jsonb AS method_scores ${FROM}
     WHERE ch.lecture_id = ANY($1) AND c.user_id = $2
     ORDER BY l.position, ch.source_type, m.created_at, ch.page_no NULLS LAST,
              (ch.content_type = 'speaker_notes'), ch.ord`, [lectureIds, userId]);

/** Adjacent slides/pages of the same material (for context expansion). */
export const neighborChunks = (userId: string, chunkIds: string[]) =>
  q<Hit & { neighbor_of: string }>(
    `SELECT ${COLS}, 0::float AS score, ARRAY['neighbor']::text[] AS methods, '{}'::jsonb AS method_scores, src.id AS neighbor_of
     FROM chunks src JOIN chunks ch ON ch.material_id = src.material_id AND ch.page_no IN (src.page_no - 1, src.page_no + 1)
       AND ch.content_type = src.content_type
     JOIN courses c ON c.id = ch.course_id LEFT JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id
     WHERE src.id = ANY($1) AND c.user_id = $2 AND src.content_type IN ('slide','page')
     ORDER BY ch.page_no, ch.ord`, [chunkIds, userId]);

const pad = (n: number | null) => (n == null ? "" : String(n).padStart(2, "0"));

/** Human citation label. Always derived from real stored identity (lecture, slide/page, file, note section). */
export function citationLabel(h: Pick<Hit, "lecture_number" | "filename" | "page_no" | "content_type" | "section"> & { source_kind: string }): string {
  const lec = h.lecture_number != null ? `Lecture ${pad(h.lecture_number)}` : null;
  if (h.content_type === "note") return `My notes · ${lec ?? "Course"}${h.section ? ` · ${h.section}` : ""}`;
  if (h.content_type === "drawing") return `My drawing · ${lec ?? "Course"}`;
  if (h.content_type === "ai_note") return `AI note (in my notes) · ${lec ?? "Course"}`;
  const unit = h.content_type === "slide" || h.content_type === "speaker_notes" ? "Slide" : h.content_type === "page" ? "Page" : "Section";
  const where = h.page_no != null ? `${unit} ${h.page_no}` : null;
  const speaker = h.content_type === "speaker_notes" ? "Speaker notes" : null;
  const bookish = h.source_kind === "book" || h.source_kind === "outline" || h.source_kind === "other" || !lec;
  return (bookish ? [h.filename, lec, speaker, where] : [lec, speaker, where, h.filename]).filter(Boolean).join(" · ");
}
