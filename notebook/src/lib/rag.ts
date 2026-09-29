import "server-only";
// Question answering & recall over course memory. Every strategy starts from retrieved evidence and every
// citation maps to a stored chunk. Without an LLM, each strategy returns an extractive, cited answer instead.
import { estimateTokens, getLLM, type LLM } from "./ai/provider";
import { earlierConnections, matchConcept, narrowerConcepts, sharedConcepts } from "./concepts";
import { buildSources, dedupe, evidenceName, sourceBlock, stripCitations, toUnits, validateCitations, type Source, type Unit } from "./context";
import { q, q1 } from "./db";
import { route, type Intent, type RoutedQuery, type SourceHint } from "./intent";
import { contentTerms } from "./query";
import { listLectures, type LectureRow } from "./repo";
import { citationLabel, lectureChunks, neighborChunks, search, type Analysis, type Hit, type SearchTrace } from "./search";

export const NOT_FOUND = "This was not found in your uploaded course material.";
export type AnswerMode = "course" | "explain";
export type { Source };

export type Group = { key: string; lectureId: string | null; label: string; items: { n: number; label: string; snippet: string; kind: string }[] };
export type Outline = { lectureId: string; label: string; topics: { title: string; materialId: string | null; pageNo: number | null }[] }[];

export type AskResult = {
  intent: Intent["kind"];
  title: string;
  mode: "answer" | "retrieval" | "not_found";
  /** Course-grounded answer (Markdown with [n] / [Lnn] citations). */
  answer: string | null;
  /** Explanation mode only: general-knowledge supplement, never cites the course. */
  extra: string | null;
  sources: Source[];
  groups?: Group[];
  outline?: Outline;
  concepts?: { id: string; name: string; lectures: number }[];
  notFound?: boolean;
  missingTerms?: string[];
  uncited?: boolean;
  aiError?: string;
  trace?: Trace;
};

export type Trace = {
  route: RoutedQuery;
  searches: { query: string; analysis: Analysis; trace: SearchTrace }[];
  selected: { n: number; label: string; role: string; score: number; methods: string[] }[];
  prompts: { system: string; user: string; output: string }[];
  citations: { cited: number[]; invalid: string[] };
  notes: string[];
  ms: number;
};

type Ctx = { userId: string; courseId: string; lectures: LectureRow[]; mode: AnswerMode; lectureId?: string | null; llm: LLM | null; trace: Trace };

const pad = (n: number | null) => (n == null ? "—" : String(n).padStart(2, "0"));
const lectureName = (l: Pick<LectureRow, "number" | "title">) => `Lecture ${pad(l.number)}${l.title ? ` — ${l.title}` : ""}`;
const minSemantic = () => Number(process.env.EMBEDDING_MIN_SIMILARITY ?? 0.5);

const GROUNDED = `You answer a university student's question using ONLY the numbered sources from their own course (lecture slides, the teacher's speaker notes and notes, the student's own notes, textbooks).
Rules:
1. End every sentence that states course content with the citation(s) supporting it, e.g. [2] or [2][5]. Use only the numbers given. Never invent a source.
2. Do not add facts that are not in the sources and do not use outside knowledge. If the sources do not answer the question, reply exactly: "${NOT_FOUND}"
3. Evidence priority: lecture slides and teacher's notes, then speaker notes (what the teacher said), then the student's own notes, then textbooks. AI-generated notes are not authoritative.
4. If sources disagree (for example lecture vs textbook), say so and attribute each view with its citation. Never merge them into one fact.
5. Only say the teacher emphasised something when a speaker-notes source or the student's notes say so.
6. Concise Markdown (short headings, bullets). No preamble, no closing remarks.`;

const EXPLAIN_SYSTEM = `You add a short general explanation to help a university student understand a topic.
Your text is shown under the heading "Additional explanation — general knowledge, not from your course".
Never claim anything comes from the course, the lecture, the slides or the teacher. Do not use citation numbers.
Keep it to 3–8 sentences or bullets, plain Markdown.`;

// ---------------- entry point ----------------

export async function ask(
  userId: string, courseId: string, question: string,
  opts: { lectureId?: string | null; mode?: AnswerMode; debug?: boolean } = {},
): Promise<AskResult> {
  const t0 = Date.now();
  const routed = route(question);
  const lectures = await listLectures(userId, courseId);
  const trace: Trace = { route: routed, searches: [], selected: [], prompts: [], citations: { cited: [], invalid: [] }, notes: [], ms: 0 };
  const ctx: Ctx = { userId, courseId, lectures, mode: opts.mode ?? "course", lectureId: opts.lectureId, llm: getLLM(), trace };
  const it = routed.intent;
  let r: AskResult;
  switch (it.kind) {
    case "recall_course": r = await recallCourse(ctx); break;
    case "recall_lecture": {
      const targets = lectures.filter((l) => l.number != null && it.numbers.includes(l.number));
      r = targets.length ? await recallLectures(ctx, targets)
        : { intent: it.kind, title: question, mode: "not_found", answer: `No lecture numbered ${it.numbers.join(", ")} exists in this course.`, extra: null, sources: [], notFound: true };
      break;
    }
    case "source_lookup": r = await sourceLookup(ctx, it.topic, it.first, routed.hint); break;
    case "topic": r = await topicRecall(ctx, it.topic, it.focus, routed.hint); break;
    case "exam_revision": r = await examRevision(ctx, it.topic, routed.hint); break;
    case "comparison": r = await comparison(ctx, it.subjects, routed.hint); break;
    case "cross_lecture": r = await crossLecture(ctx, it.numbers, it.topic); break;
    case "definition": r = await definition(ctx, it.topic, question, routed.hint); break;
    default: r = await general(ctx, question, it.lectureNumbers, routed.hint);
  }
  r = await withExplanation(ctx, question, r);
  trace.ms = Date.now() - t0;
  trace.selected = r.sources.map((s) => ({ n: s.n, label: s.label, role: s.role, score: s.score, methods: s.methods }));
  return opts.debug ? { ...r, trace } : r;
}

// ---------------- shared helpers ----------------

async function doSearch(ctx: Ctx, query: string, o: Parameters<typeof search>[3] = {}) {
  const res = await search(ctx.userId, ctx.courseId, query, o);
  ctx.trace.searches.push({ query, analysis: res.analysis, trace: res.trace });
  return res;
}

/** Evidence gate: a distinctive term that doesn't occur anywhere in the course (no stem, spelling or alias match) and
 *  no strong semantic match means the course doesn't cover it — answer "not found" instead of guessing. */
function gate(ctx: Ctx, a: Analysis, hits: Hit[], topicTerms: string[]): { notFound: boolean; missing: string[] } {
  if (!hits.length) return { notFound: true, missing: topicTerms };
  const semOk = a.semantic.top != null && a.semantic.top >= minSemantic();
  const missing = a.missing.filter((t) => topicTerms.includes(t));
  const present = topicTerms.filter((t) => !missing.includes(t) && (a.df[t] ?? 0) > 0);
  const note = (why: string) => ctx.trace.notes.push(`gate: ${why}; top semantic similarity ${a.semantic.top ?? "n/a"} (threshold ${minSemantic()})`);
  // 1) The rarest term never co-occurs with the rest of the question → the combination isn't in the course.
  if (!a.cohesive && present.length >= 2) {
    // Strictly lexical on purpose: vector similarity to the *other* words (e.g. "operating systems") must not rescue it.
    note(`"${a.rarest}" never appears together with ${present.filter((t) => t !== a.rarest).join("/")}`);
    return { notFound: true, missing: [a.rarest!] };
  }
  if (!missing.length) return { notFound: false, missing };
  // 2) Words absent from the course: fine when they're filler around a well-supported question ("program *currently*
  //    executing"), not when the question's subject itself is absent ("deadlocks", "mutex").
  note(`missing terms: ${missing.join(", ")}`);
  if (semOk || present.length >= 2) return { notFound: false, missing };
  return { notFound: true, missing };
}

function notFound(intent: Intent["kind"], title: string, missing: string[]): AskResult {
  return { intent, title, mode: "not_found", answer: NOT_FOUND, extra: null, sources: [], notFound: true, missingTerms: missing };
}

async function budgetFor(ctx: Ctx, outputTokens: number): Promise<number> {
  if (!ctx.llm) return 6000; // extractive mode: bound what we show
  const window = await ctx.llm.contextTokens();
  return Math.max(800, Math.floor((window - outputTokens - 900) * 0.9));
}

async function generate(ctx: Ctx, system: string, user: string, maxTokens = 1500): Promise<{ text: string | null; error?: string }> {
  if (!ctx.llm) return { text: null };
  try {
    const out = (await ctx.llm.complete({ system, messages: [{ role: "user", content: user }], maxTokens })).trim();
    ctx.trace.prompts.push({ system, user: user.slice(0, 30_000), output: out });
    return { text: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.trace.prompts.push({ system, user: user.slice(0, 30_000), output: `ERROR: ${msg}` });
    return { text: null, error: "The AI model could not be reached, so here is the evidence from your course." };
  }
}

/** Runs the grounded generation and enforces the citation contract. */
async function grounded(ctx: Ctx, base: Omit<AskResult, "mode" | "answer" | "extra">, task: string, fallback: string, maxTokens = 1500): Promise<AskResult> {
  const { text, error } = await generate(ctx, GROUNDED, `Sources:\n\n${sourceBlock(base.sources)}\n\n${task}`, maxTokens);
  if (!text) return { ...base, mode: "retrieval", answer: fallback, extra: null, aiError: error };
  if (text.includes(NOT_FOUND) && text.replace(NOT_FOUND, "").replace(/[\s"'.]/g, "").length < 40)
    return { ...base, mode: "not_found", answer: NOT_FOUND, extra: null, sources: [], groups: [], notFound: true };
  const v = validateCitations(text, base.sources.length, ctx.lectures.map((l) => l.number ?? -1));
  ctx.trace.citations = { cited: v.cited, invalid: v.invalid };
  return { ...base, mode: "answer", answer: v.text, extra: null, uncited: v.cited.length === 0 };
}

async function withExplanation(ctx: Ctx, question: string, r: AskResult): Promise<AskResult> {
  if (ctx.mode !== "explain" || !ctx.llm || r.intent === "recall_course" || r.intent === "recall_lecture") return r;
  const course = r.notFound ? "(Nothing about this was found in the student's course material.)" : stripCitations(r.answer ?? "").slice(0, 6000);
  const { text } = await generate(ctx, EXPLAIN_SYSTEM, `Student's question: ${question}\n\nWhat their course material says:\n${course}\n\nWrite the additional explanation.`, 700);
  return { ...r, extra: text ? stripCitations(text) : null };
}

function groupsOf(sources: Source[], lectures: LectureRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const s of sources.filter((x) => x.role !== "neighbor")) {
    const lec = lectures.find((l) => l.id === s.lectureId);
    const key = s.lectureId ?? `f:${s.filename ?? s.kind}`;
    const g = map.get(key) ?? { key, lectureId: s.lectureId, label: lec ? lectureName(lec) : s.filename ?? "Course material", items: [] };
    g.items.push({ n: s.n, label: s.label, snippet: s.excerpt.replace(/\s+/g, " ").slice(0, 220), kind: evidenceName(s) });
    map.set(key, g);
  }
  const pos = (g: Group) => lectures.find((l) => l.id === g.lectureId)?.position ?? 1e9;
  return [...map.values()].sort((a, b) => pos(a) - pos(b));
}

const units = (hits: Hit[], role: Source["role"] = "evidence") => toUnits(hits, citationLabel, role);

async function neighborUnits(ctx: Ctx, sources: Unit[], top = 4): Promise<Unit[]> {
  const ids = sources.filter((s) => s.materialId && (s.contentType === "slide" || s.contentType === "page")).slice(0, top).flatMap((s) => s.chunkIds);
  if (!ids.length) return [];
  const nb = await neighborChunks(ctx.userId, ids);
  return units(nb, "neighbor").map((u) => ({ ...u, score: 0 }));
}

/** Filters retrieval hits to those that actually match the topic (keyword/alias/typo or a strong vector match). */
function relevant(hits: Hit[], analysis: Analysis): Hit[] {
  if (!hits.length) return hits;
  const top = hits[0]!.score;
  return hits.filter((h) =>
    h.score >= top * 0.2 &&
    (h.methods.includes("keyword") || (h.method_scores.semantic ?? 0) >= minSemantic() || (analysis.semantic.available === false && h.methods.includes("fuzzy"))));
}

/** Title slides ("Lecture 5: Processes") carry little evidence. */
export const isTitleSlide = (s: { section: string | null; pageNo?: number | null }) => !!s.section && /^\s*(lecture|week|chapter|session)\s*\d+\b/i.test(s.section);

// Deterministic extractive snippets used when no LLM is configured.
const sentenceWith = (text: string, re: RegExp) =>
  text.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).find((s) => re.test(s) && s.length > 12);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------- strategies ----------------

async function definition(ctx: Ctx, topic: string, question: string, hint: SourceHint): Promise<AskResult> {
  const concept = await matchConcept(ctx.courseId, topic);
  const extra = concept ? [concept.name, ...concept.aliases] : [];
  const { hits, analysis } = await doSearch(ctx, topic, { limit: 16, hint, extraPhrases: extra });
  const g = gate(ctx, analysis, hits, contentTerms(topic));
  if (g.notFound) return notFound("definition", question, g.missing);
  // Prefer passages that actually define the term.
  const names = [topic, ...extra].map((n) => esc(n.toLowerCase().replace(/s$/, ""))).join("|");
  // The term must open a sentence/bullet ("A process is a …", "PCB: …"), not merely precede "is" ("Each process is represented").
  const defRe = new RegExp(`(?:^|\\n|[.!?]\\s+)\\s*(?:[-•*▪]\\s*)?(?:an?\\s+|the\\s+)?(?:${names})s?\\b(?:\\s*\\([^)]*\\))?\\s*(?::|—|–|\\s-\\s|\\s(?:is|are)\\s+(?:an?|the|defined as|called|also called)\\b|\\s(?:refers to|means)\\b)`, "i");
  const rel = relevant(hits, analysis).map((h) => ({ ...h, score: defRe.test(h.content) ? h.score * 1.6 : h.score })).sort((a, b) => b.score - a.score);
  const u = dedupe(units(rel.slice(0, 10)));
  const budget = await budgetFor(ctx, 800);
  const sources = buildSources(u, { budgetTokens: budget, order: "relevance", neighbors: await neighborUnits(ctx, u, 2), maxUnits: 10 });
  const best = sources.find((s) => defRe.test(s.excerpt)) ?? sources[0]!;
  const quote = sentenceWith(best.excerpt, defRe) ?? best.excerpt.split("\n").slice(0, 3).join(" ");
  const fallback = `> ${quote} [${best.n}]\n\nSee the sources below for the full context.`;
  return grounded(ctx, { intent: "definition", title: question, sources, groups: groupsOf(sources, ctx.lectures) },
    `Question: ${question}\nGive the course's definition first (quote the teacher's wording where possible), then any important details, each with citations.`, fallback, 800);
}

async function topicEvidence(ctx: Ctx, topic: string, hint: SourceHint, limit = 60) {
  const concept = await matchConcept(ctx.courseId, topic);
  const narrower = concept ? await narrowerConcepts(concept.id, 6) : [];
  const extra = [...(concept ? [concept.name, ...concept.aliases] : []), ...narrower.flatMap((n) => [n.name, ...n.aliases])];
  ctx.trace.notes.push(`concept: ${concept?.name ?? "none"}; expansions: ${extra.join(", ") || "none"}`);
  const { hits, analysis } = await doSearch(ctx, topic, { limit, hint, extraPhrases: extra });
  // Also pull every chunk the concept index links to the concept, so coverage isn't limited to top-K.
  if (concept) {
    const direct = await q<{ chunk_id: string }>(
      `SELECT cm.chunk_id FROM concept_mentions cm WHERE cm.concept_id = ANY($1::uuid[])`, [[concept.id, ...narrower.map((n) => n.id)]]);
    const have = new Set(hits.map((h) => h.chunk_id));
    const missingIds = direct.map((d) => d.chunk_id).filter((id) => !have.has(id));
    if (missingIds.length) {
      const extraHits = await q<Hit>(
        `SELECT ch.id AS chunk_id, ch.course_id, ch.lecture_id, l.number AS lecture_number, l.title AS lecture_title, l.position AS lecture_position,
           ch.material_id, ch.note_id, ch.source_type, ch.source_kind, ch.content_type, m.filename, ch.page_no,
           CASE WHEN ch.content_type IN ('slide','speaker_notes') THEN ch.page_no END AS slide_no, ch.section, ch.anchor, ch.text AS content,
           0.001::float AS score, ARRAY['concept']::text[] AS methods, '{}'::jsonb AS method_scores
         FROM chunks ch JOIN courses c ON c.id = ch.course_id LEFT JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id
         WHERE ch.id = ANY($1) AND c.user_id = $2 LIMIT 200`, [missingIds, ctx.userId]);
      hits.push(...extraHits);
    }
  }
  return { hits, analysis, concept };
}

async function sourceLookup(ctx: Ctx, topic: string, first: boolean, hint: SourceHint): Promise<AskResult> {
  const title = first ? `Where ${topic} was first introduced` : `Where you studied ${topic}`;
  const { hits, analysis, concept } = await topicEvidence(ctx, topic, hint, 60);
  const g = gate(ctx, analysis, hits, contentTerms(topic));
  if (g.notFound) return notFound("source_lookup", title, g.missing);
  const rel = hits.filter((h) => h.methods.includes("concept")).concat(relevant(hits.filter((h) => !h.methods.includes("concept")), analysis));
  const sources = buildSources(units(rel), { budgetTokens: 1e9, order: "chronological", maxUnits: 80 });
  const groups = groupsOf(sources, ctx.lectures);
  const lectureGroups = groups.filter((x) => x.lectureId);
  const firstG = lectureGroups[0];
  const name = concept?.name ?? topic;
  const answer = !sources.length ? NOT_FOUND
    : lectureGroups.length
      ? `**${name}** appears in ${lectureGroups.length} lecture${lectureGroups.length > 1 ? "s" : ""}: ${lectureGroups.map((x) => x.label.split(" — ")[0]).join(", ")}.` +
        (firstG ? `\n\nFirst introduced in **${firstG.label}** [${firstG.items[0]!.n}].` : "") +
        (groups.length > lectureGroups.length ? `\n\nAlso in course-level material: ${groups.filter((x) => !x.lectureId).map((x) => x.label).join(", ")}.` : "")
      : `**${name}** appears only in course-level material: ${groups.map((x) => x.label).join(", ")}.`;
  return { intent: "source_lookup", title, mode: "retrieval", answer, extra: null, sources, groups, notFound: !sources.length };
}

const FOCUS_TASK = {
  all: (t: string) => `Reconstruct everything the course teaches about "${t}". Organise by sub-topic (definition, how it works, variants, examples, related ideas). Note in which lecture each idea appears and how the explanation builds up over the course. Cite every point.`,
  examples: (t: string) => `List every example related to "${t}" that appears in the sources, grouped by lecture, each with a one-line explanation and citation.`,
  development: (t: string) => `Explain how the course's treatment of "${t}" developed lecture by lecture, in chronological order: what was introduced first and what later lectures added or refined. Cite every point.`,
  exam: (t: string) => `Help the student revise "${t}" for an exam using only the sources: key definitions, core mechanisms, formulas/algorithms, typical examples, and points the teacher emphasised (only if speaker notes or the student's notes say so). End with 5 likely exam questions (no answers). Cite every point.`,
};

async function topicRecall(ctx: Ctx, topic: string, focus: "all" | "examples" | "development" | "exam", hint: SourceHint): Promise<AskResult> {
  const title = focus === "examples" ? `Examples of ${topic}` : focus === "development" ? `How ${topic} developed` : focus === "exam" ? `Revise: ${topic}` : `Everything about ${topic}`;
  const { hits, analysis, concept } = await topicEvidence(ctx, topic, hint, 80);
  const g = gate(ctx, analysis, hits, contentTerms(topic));
  if (g.notFound) return notFound(focus === "exam" ? "exam_revision" : "topic", title, g.missing);
  let rel = hits.filter((h) => h.methods.includes("concept")).concat(relevant(hits.filter((h) => !h.methods.includes("concept")), analysis));
  if (focus === "examples") rel = rel.map((h) => ({ ...h, score: /\b(e\.g\.|example|for instance|such as|consider)\b/i.test(h.content) ? h.score * 1.8 + 0.01 : h.score }));
  if (focus === "exam") rel = rel.map((h) => ({ ...h, score: /\b(important|exam|remember|must|note that|always|never|key)\b/i.test(h.content) ? h.score * 1.4 + 0.005 : h.score }));
  const all = dedupe(units(rel));
  const budget = await budgetFor(ctx, 2000);
  const sources = buildSources(all, { budgetTokens: budget, order: "chronological", perLecture: 4, maxUnits: 40, neighbors: await neighborUnits(ctx, all.sort((a, b) => b.score - a.score), 3) });
  const groups = groupsOf(sources, ctx.lectures);
  const name = concept?.name ?? topic;
  const itemText = (n: number) => {
    const s = sources.find((x) => x.n === n)!;
    const what = s.contentType === "speaker_notes" ? `teacher: “${s.excerpt.replace(/\s+/g, " ").slice(0, 80)}…”`
      : s.kind === "student_notes" ? `my notes: “${s.excerpt.replace(/\s+/g, " ").slice(0, 80)}…”`
      : s.section ?? s.excerpt.replace(/\s+/g, " ").slice(0, 80);
    return `${what} [${n}]`;
  };
  const fallback = [`**${name}** appears in ${groups.length} place${groups.length === 1 ? "" : "s"} in your course (lecture order):`,
    ...groups.map((gr) => {
      const items = gr.items.filter((i) => !isTitleSlide(sources.find((x) => x.n === i.n)!));
      return `- **${gr.label}**: ${(items.length ? items : gr.items).slice(0, 6).map((i) => itemText(i.n)).join(" · ")}`;
    })].join("\n");
  const omitted = all.length - sources.filter((s) => s.role === "evidence").length;
  if (omitted > 0) ctx.trace.notes.push(`${omitted} relevant passages beyond the context budget (listed in groups only)`);

  if (ctx.llm && all.length > sources.length) {
    // Hierarchical: summarise evidence per lecture batch first, then synthesise — keeps within the context window.
    const perBatch = buildBatches(all, budget);
    if (perBatch.length > 1) return mapReduceTopic(ctx, title, name, focus, perBatch, fallback);
  }
  return grounded(ctx, { intent: focus === "exam" ? "exam_revision" : "topic", title, sources, groups }, FOCUS_TASK[focus](name), fallback, 2000);
}

function buildBatches(all: Unit[], budget: number): Source[][] {
  // Chronological list numbered once (global numbering keeps citations valid across batches).
  const numbered = buildSources(all, { budgetTokens: 1e9, order: "chronological", maxUnits: 400 });
  const batches: Source[][] = [];
  let cur: Source[] = [];
  let used = 0;
  for (const s of numbered) {
    const t = estimateTokens(s.excerpt) + 30;
    if (cur.length && used + t > budget) { batches.push(cur); cur = []; used = 0; }
    cur.push(s);
    used += t;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function mapReduceTopic(ctx: Ctx, title: string, name: string, focus: keyof typeof FOCUS_TASK, batches: Source[][], fallback: string): Promise<AskResult> {
  const sources = batches.flat();
  const notes: string[] = [];
  for (const b of batches) {
    const { text } = await generate(ctx, GROUNDED,
      `Sources:\n\n${sourceBlock(b)}\n\nExtract every point these sources make about "${name}" as terse bullet points, each ending with its citation(s). Output only bullets.`, 900);
    if (text && !text.includes(NOT_FOUND)) notes.push(validateCitations(text, sources.length).text);
  }
  const base = { intent: "topic" as const, title, sources, groups: groupsOf(sources, ctx.lectures) };
  if (!notes.length) return { ...base, mode: "retrieval", answer: fallback, extra: null };
  const { text, error } = await generate(ctx, GROUNDED,
    `Cited notes extracted from the course (citations refer to the sources listed below):\n\n${notes.join("\n")}\n\nSource list:\n${sources.map((s) => `[${s.n}] ${s.label}`).join("\n")}\n\n${FOCUS_TASK[focus](name)} Keep the citations from the notes.`, 2000);
  if (!text) return { ...base, mode: "retrieval", answer: fallback, extra: null, aiError: error };
  const v = validateCitations(text, sources.length);
  ctx.trace.citations = { cited: v.cited, invalid: v.invalid };
  return { ...base, mode: "answer", answer: v.text, extra: null, uncited: !v.cited.length };
}

async function examRevision(ctx: Ctx, topic: string | null, hint: SourceHint): Promise<AskResult> {
  if (topic) return topicRecall(ctx, topic, "exam", hint);
  const target = ctx.lectures.find((l) => l.id === ctx.lectureId);
  if (target) return recallLectures(ctx, [target]);
  return recallCourse(ctx);
}

async function comparison(ctx: Ctx, [a, b]: [string, string], hint: SourceHint): Promise<AskResult> {
  const title = `${a} vs ${b}`;
  const [ra, rb] = [await topicEvidence(ctx, a, hint, 12), await topicEvidence(ctx, b, hint, 12)];
  const ga = gate(ctx, ra.analysis, ra.hits, contentTerms(a)), gb = gate(ctx, rb.analysis, rb.hits, contentTerms(b));
  if (ga.notFound && gb.notFound) return notFound("comparison", title, [...ga.missing, ...gb.missing]);
  const pick = (r: typeof ra) => relevant(r.hits.filter((h) => !h.methods.includes("concept")), r.analysis).slice(0, 8);
  const u = dedupe(units([...pick(ra), ...pick(rb)]));
  const budget = await budgetFor(ctx, 1500);
  const sources = buildSources(u, { budgetTokens: budget, order: "relevance", maxUnits: 16 });
  const side = (t: string, r: typeof ra) => {
    const s = sources.find((x) => r.hits.some((h) => x.chunkIds.includes(h.chunk_id)));
    return s ? `- **${t}**: ${s.excerpt.replace(/\s+/g, " ").slice(0, 200)} [${s.n}]` : `- **${t}**: ${NOT_FOUND}`;
  };
  const fallback = `${side(a, ra)}\n${side(b, rb)}`;
  const missingNote = ga.notFound || gb.notFound ? `\nNote: "${ga.notFound ? a : b}" was not found in the sources; say so explicitly instead of describing it.` : "";
  return grounded(ctx, { intent: "comparison", title, sources, groups: groupsOf(sources, ctx.lectures) },
    `Compare "${a}" and "${b}" using only the sources: a short definition of each, then a Markdown table of differences, then similarities. Cite every row.${missingNote}`, fallback, 1500);
}

async function crossLecture(ctx: Ctx, numbers: number[], topic: string | null): Promise<AskResult> {
  const targets = ctx.lectures.filter((l) => l.number != null && numbers.includes(l.number));
  const title = `${targets.map((l) => `Lecture ${pad(l.number)}`).join(" & ")}${topic ? ` — ${topic}` : ""}`;
  if (targets.length < 2) return { intent: "cross_lecture", title, mode: "not_found", answer: `Those lectures don't all exist in this course.`, extra: null, sources: [], notFound: true };
  const ids = targets.map((l) => l.id);
  let evidence: Hit[];
  if (topic) {
    const { hits, analysis } = await doSearch(ctx, topic, { lectureIds: ids, limit: 40 });
    const g = gate(ctx, analysis, hits, contentTerms(topic));
    if (g.notFound) return notFound("cross_lecture", title, g.missing);
    evidence = relevant(hits, analysis);
  } else evidence = await lectureChunks(ctx.userId, ids);
  const shared = await sharedConcepts(ctx.courseId, ids);
  ctx.trace.notes.push(`shared concepts: ${shared.map((s) => s.name).join(", ") || "none"}`);
  const sharedIds = new Set(shared.flatMap((s) => s.chunk_ids));
  const scored = evidence.map((h) => ({ ...h, score: h.score + (sharedIds.has(h.chunk_id) ? 1 : 0) }));
  const budget = await budgetFor(ctx, 1800);
  const sources = buildSources(dedupe(units(scored)), { budgetTokens: budget, order: "chronological", perLecture: 8, maxUnits: 40 });
  const groups = groupsOf(sources, ctx.lectures);
  const cite = (chunkIds: string[]) => sources.filter((s) => s.chunkIds.some((c) => chunkIds.includes(c))).map((s) => `[${s.n}]`).slice(0, 4).join("");
  const fallback = shared.length
    ? `Concepts that appear in more than one of these lectures:\n${shared.slice(0, 12).map((s) => `- **${s.name}** ${cite(s.chunk_ids)}`).join("\n")}`
    : "No concept in the concept index appears in more than one of these lectures. See the evidence below.";
  const sharedTxt = shared.length ? `Concepts found (by the index) in more than one of these lectures: ${shared.map((s) => s.name).join(", ")}.` : "";
  return grounded(ctx, { intent: "cross_lecture", title, sources, groups },
    `${sharedTxt}\nExplain what ${targets.map(lectureName).join(" and ")} ${topic ? `say about "${topic}"` : "have in common"}, and how they connect. Organise by lecture, then list the connections. Only state a connection when the sources support it. Cite every point.`, fallback, 1800);
}

async function general(ctx: Ctx, question: string, lectureNumbers: number[], hint: SourceHint): Promise<AskResult> {
  let lectureIds = ctx.lectures.filter((l) => l.number != null && lectureNumbers.includes(l.number)).map((l) => l.id);
  if (!lectureIds.length && ctx.lectureId && /\b(this|today'?s?|current) (lecture|slide|class)\b/i.test(question)) lectureIds = [ctx.lectureId];
  const { hits, analysis } = await doSearch(ctx, question, { lectureIds, limit: 20, hint });
  const g = gate(ctx, analysis, hits, contentTerms(question));
  if (g.notFound) return notFound("ask", question, g.missing);
  const u = dedupe(units(relevant(hits, analysis)));
  const budget = await budgetFor(ctx, 1500);
  const sources = buildSources(u, { budgetTokens: budget, order: "relevance", perLecture: 3, maxUnits: 14, neighbors: await neighborUnits(ctx, u, 3) });
  const fallback = sources.slice(0, 5).map((s) => `- ${s.excerpt.replace(/\s+/g, " ").slice(0, 200)} [${s.n}]`).join("\n");
  return grounded(ctx, { intent: "ask", title: question, sources, groups: groupsOf(sources, ctx.lectures) }, `Question: ${question}`, fallback);
}

// ---------------- recall lecture ----------------

const RECALL_SECTIONS = (speaker: boolean, mine: boolean) => [
  "What this lecture was about", "Main concepts", "Definitions", "Important explanations", "Diagrams / visual concepts", "Formulas", "Code / examples",
  ...(speaker ? ["Teacher's points (from speaker notes)"] : []), ...(mine ? ["My additional notes"] : []),
  "Connections to previous lectures", "Likely to matter in an exam",
];

export async function recallLectures(ctx: Ctx, targets: LectureRow[]): Promise<AskResult> {
  const title = targets.length === 1 ? lectureName(targets[0]!) : `Lectures ${targets.map((l) => l.number).join(", ")}`;
  const hits = await lectureChunks(ctx.userId, targets.map((l) => l.id));
  const outline = buildOutline(targets, hits);
  if (!hits.length) return { intent: "recall_lecture", title, mode: "retrieval", answer: "Nothing has been written or uploaded for this lecture yet.", extra: null, sources: [], outline };

  // Connections: concepts of this lecture that also appear earlier (from the concept index), with their earliest evidence.
  const conn = targets.length === 1 ? await earlierConnections(targets[0]!.id) : [];
  const connHits = conn.length ? await q<Hit>(
    `SELECT ch.id AS chunk_id, ch.course_id, ch.lecture_id, l.number AS lecture_number, l.title AS lecture_title, l.position AS lecture_position,
       ch.material_id, ch.note_id, ch.source_type, ch.source_kind, ch.content_type, m.filename, ch.page_no,
       CASE WHEN ch.content_type IN ('slide','speaker_notes') THEN ch.page_no END AS slide_no, ch.section, ch.anchor, ch.text AS content,
       0::float AS score, ARRAY['concept']::text[] AS methods, '{}'::jsonb AS method_scores
     FROM chunks ch LEFT JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id WHERE ch.id = ANY($1)`,
    [conn.map((c) => c.chunk_id)]) : [];

  const lectureUnits = units(hits).map((u, i) => ({ ...u, score: 1000 - i }));
  const connUnits = units(connHits, "connection").map((u) => ({ ...u, score: -1 }));
  const budget = await budgetFor(ctx, 2500);
  const everything = [...lectureUnits, ...connUnits];
  const fitsAll = everything.reduce((s, u) => s + estimateTokens(u.excerpt) + 30, 0) <= budget;
  const sources = buildSources(everything, { budgetTokens: fitsAll ? budget : 1e9, order: "chronological", maxUnits: 500 });
  const speaker = sources.filter((s) => s.contentType === "speaker_notes");
  const mine = sources.filter((s) => s.kind === "student_notes");
  const connSrc = sources.filter((s) => s.role === "connection");
  const base = { intent: "recall_lecture" as const, title, sources, outline, groups: groupsOf(sources, ctx.lectures) };
  const fallback = extractiveRecall(sources, conn);

  if (!ctx.llm) return { ...base, mode: "retrieval", answer: fallback, extra: null };
  const sections = RECALL_SECTIONS(speaker.length > 0, mine.length > 0);
  const legend = [
    speaker.length ? `Speaker-notes sources (what the teacher said): ${speaker.map((s) => `[${s.n}]`).join("")}.` : "There are NO speaker notes: do not claim the teacher emphasised anything unless the student's notes say so.",
    mine.length ? `Student's own notes: ${mine.map((s) => `[${s.n}]`).join("")}.` : "",
    connSrc.length ? `Sources from EARLIER lectures (use only for "Connections to previous lectures"): ${connSrc.map((s) => `[${s.n}]`).join("")}. Shared concepts: ${conn.map((c) => `${c.name} (Lecture ${pad(c.lecture_number)})`).join(", ")}.` : "No earlier-lecture evidence: write \"No connections found in earlier lectures.\" in that section.",
  ].filter(Boolean).join("\n");
  const task = `Reconstruct ${title} for revision. Use these "##" sections in this order, and omit a section entirely if the sources give nothing for it: ${sections.join("; ")}.\n${legend}\nPut exam-style questions without answers. Cite every point.`;

  if (fitsAll) return grounded(ctx, base, task, fallback, 2500);
  // Too large for one call: extract cited notes per batch, then write the recall from those notes.
  const batches: Source[][] = [];
  let cur: Source[] = [], used = 0;
  for (const s of sources) {
    const t = estimateTokens(s.excerpt) + 30;
    if (cur.length && used + t > budget) { batches.push(cur); cur = []; used = 0; }
    cur.push(s); used += t;
  }
  if (cur.length) batches.push(cur);
  ctx.trace.notes.push(`recall map-reduce over ${batches.length} batches`);
  const notes: string[] = [];
  for (const b of batches) {
    const { text } = await generate(ctx, GROUNDED, `Sources:\n\n${sourceBlock(b)}\n\nExtract the key facts, definitions, formulas, examples and teacher remarks as terse bullets, each ending with its citation(s). Output only bullets.`, 1000);
    if (text) notes.push(validateCitations(text, sources.length).text);
  }
  const { text, error } = await generate(ctx, GROUNDED,
    `Cited notes extracted from ${title}:\n\n${notes.join("\n")}\n\nSource list:\n${sources.map((s) => `[${s.n}] ${s.label} — ${evidenceName(s)}`).join("\n")}\n\n${task} Keep the citations from the notes.`, 2500);
  if (!text) return { ...base, mode: "retrieval", answer: fallback, extra: null, aiError: error };
  const v = validateCitations(text, sources.length);
  ctx.trace.citations = { cited: v.cited, invalid: v.invalid };
  return { ...base, mode: "answer", answer: v.text, extra: null, uncited: !v.cited.length };
}

/** Evidence-only reconstruction (no LLM): every line is quoted or listed from a real source. */
function extractiveRecall(sources: Source[], conn: { name: string; lecture_number: number | null; chunk_id: string }[]): string {
  const lecture = sources.filter((s) => s.role === "evidence");
  const material = lecture.filter((s) => s.kind !== "student_notes" && s.kind !== "ai_note" && !isTitleSlide(s));
  const lines = (s: Source) => s.excerpt.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  const sec = (h: string, items: string[]) => { if (items.length) out.push(`## ${h}`, ...items.slice(0, 12)); };
  const seen = new Set<string>();
  const titles = material.filter((s) => s.section && s.contentType !== "speaker_notes")
    .filter((s) => (seen.has(s.section!.toLowerCase()) ? false : (seen.add(s.section!.toLowerCase()), true)));
  sec("What this lecture was about", titles.map((s) => `- ${s.section} [${s.n}]`));
  const defs = material.flatMap((s) => lines(s).filter((l) => /^[-•*]?\s*[A-Z]?[\w ()/-]{2,40}\s*(:|—|–)\s+\S|\b(is|are) (an?|the|defined as)\b/.test(l) && l.length < 240).map((l) => `- ${l.replace(/^[-•*]\s*/, "")} [${s.n}]`));
  sec("Definitions", [...new Set(defs)]);
  const formulas = material.flatMap((s) => lines(s).filter((l) => /\$[^$]+\$|[A-Za-z]\s*[=≤≥<>]\s*[\w(]|[∑∫√±×÷]/.test(l)).map((l) => `- ${l} [${s.n}]`));
  sec("Formulas", [...new Set(formulas)]);
  const code = material.flatMap((s) => lines(s).filter((l) => /\w+\([^)]*\)\s*;?$|^\s*(for|while|if|int|void|def|return)\b|[{};]\s*$|\b(e\.g\.|example|for instance)\b/i.test(l)).map((l) => `- ${l} [${s.n}]`));
  sec("Code / examples", [...new Set(code)]);
  sec("Teacher's points (from speaker notes)", lecture.filter((s) => s.contentType === "speaker_notes").map((s) => `- ${s.excerpt.replace(/\s+/g, " ")} [${s.n}]`));
  sec("My additional notes", lecture.filter((s) => s.kind === "student_notes").map((s) => `- ${s.excerpt.replace(/\s+/g, " ").slice(0, 300)} [${s.n}]`));
  const connSrc = sources.filter((s) => s.role === "connection");
  sec("Connections to previous lectures", conn.map((c) => {
    const s = connSrc.find((x) => x.chunkIds.includes(c.chunk_id));
    return `- **${c.name}** — also in Lecture ${pad(c.lecture_number)}${s ? ` [${s.n}]` : ""}`;
  }));
  return out.join("\n") || "The lecture has content but no structured points could be extracted; see the sources.";
}

function buildOutline(lectures: LectureRow[], hits: Hit[]): Outline {
  return lectures.map((l) => {
    const seen = new Set<string>();
    const topics: Outline[number]["topics"] = [];
    for (const h of hits) {
      if (h.lecture_id !== l.id || !h.section || h.content_type === "speaker_notes" || h.source_kind === "ai_note") continue;
      const key = h.section.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push({ title: h.section, materialId: h.material_id, pageNo: h.page_no });
    }
    return { lectureId: l.id, label: lectureName(l), topics: topics.slice(0, 60) };
  });
}

// ---------------- recall course (hierarchical) ----------------

const SUMMARY_SYSTEM = `You summarise one university lecture from its sources for a course overview. Use only the sources. Output 3–6 terse bullets: the main theme first, then key concepts. No citations, no preamble.`;

async function lectureEvidenceHash(lectureId: string) {
  return (await q1<{ h: string | null }>(
    "SELECT md5(string_agg(content_hash, ',' ORDER BY content_hash)) AS h FROM chunks WHERE lecture_id = $1 AND source_kind <> 'ai_note'", [lectureId]))?.h ?? null;
}

/** Cached per-lecture summary (level 1 of course recall). Regenerated only when the lecture's evidence changes. */
export async function summarizeLecture(lectureId: string, llm = getLLM()): Promise<string | null> {
  if (!llm) return null;
  const hash = await lectureEvidenceHash(lectureId);
  if (!hash) return null;
  const cached = await q1<{ summary: string; evidence_hash: string; model: string }>("SELECT summary, evidence_hash, model FROM lecture_summaries WHERE lecture_id = $1", [lectureId]);
  const modelKey = `${llm.provider}:${llm.model}`;
  if (cached && cached.evidence_hash === hash && cached.model === modelKey) return cached.summary;
  const owner = await q1<{ user_id: string }>("SELECT c.user_id FROM lectures l JOIN courses c ON c.id = l.course_id WHERE l.id = $1", [lectureId]);
  if (!owner) return null;
  const hits = (await lectureChunks(owner.user_id, [lectureId])).filter((h) => h.source_kind !== "ai_note");
  const window = await llm.contextTokens();
  const budget = Math.max(800, Math.floor((window - 600 - 900) * 0.9));
  const u = toUnits(hits, citationLabel).map((x, i) => ({ ...x, score: 1000 - i }));
  // Prefer titles + first lines when the lecture exceeds the window.
  const compact = u.map((x) => ({ ...x, excerpt: x.excerpt.split("\n").slice(0, 6).join("\n") }));
  const sources = buildSources(compact, { budgetTokens: budget, order: "chronological", maxUnits: 400 });
  const out = (await llm.complete({ system: SUMMARY_SYSTEM, messages: [{ role: "user", content: `Sources:\n\n${sourceBlock(sources)}\n\nSummarise this lecture.` }], maxTokens: 400 })).trim();
  const summary = stripCitations(out);
  await q(
    `INSERT INTO lecture_summaries (lecture_id, evidence_hash, summary, model) VALUES ($1,$2,$3,$4)
     ON CONFLICT (lecture_id) DO UPDATE SET evidence_hash = excluded.evidence_hash, summary = excluded.summary, model = excluded.model, created_at = now()`,
    [lectureId, hash, summary, modelKey]);
  return summary;
}

const ON_DEMAND_SUMMARIES = 6;

export async function recallCourse(ctx: Ctx): Promise<AskResult> {
  const title = "Course overview";
  const outlineHits = await q<Hit>(
    `SELECT DISTINCT ON (ch.lecture_id, lower(ch.section)) ch.id AS chunk_id, ch.course_id, ch.lecture_id, l.number AS lecture_number,
       l.title AS lecture_title, l.position AS lecture_position, ch.material_id, ch.note_id, ch.source_type, ch.source_kind, ch.content_type,
       m.filename, ch.page_no, NULL::int AS slide_no, ch.section, ch.anchor, ''::text AS content, 0::float AS score, '{}'::text[] AS methods, '{}'::jsonb AS method_scores
     FROM chunks ch JOIN courses c ON c.id = ch.course_id JOIN lectures l ON l.id = ch.lecture_id LEFT JOIN materials m ON m.id = ch.material_id
     WHERE ch.course_id = $1 AND c.user_id = $2 AND ch.section IS NOT NULL AND ch.content_type NOT IN ('speaker_notes','ai_note')
     ORDER BY ch.lecture_id, lower(ch.section), ch.source_type, ch.page_no NULLS LAST, ch.ord`, [ctx.courseId, ctx.userId]);
  outlineHits.sort((a, b) => (a.page_no ?? 1e9) - (b.page_no ?? 1e9));
  const outline = buildOutline(ctx.lectures, outlineHits);
  const concepts = await q<{ id: string; name: string; lectures: number; first: number | null }>(
    `SELECT k.id, k.name, k.lecture_count AS lectures, (SELECT l.number FROM lectures l WHERE l.course_id = k.course_id AND l.position = k.first_position LIMIT 1) AS first
     FROM concepts k WHERE k.course_id = $1 AND k.lecture_count >= 2 ORDER BY k.lecture_count DESC, k.mention_count DESC LIMIT 25`, [ctx.courseId]);
  const base = { intent: "recall_course" as const, title, sources: [], outline, concepts: concepts.map((c) => ({ id: c.id, name: c.name, lectures: c.lectures })) };
  if (!outline.some((o) => o.topics.length)) return { ...base, mode: "retrieval", answer: "Nothing has been uploaded or written in this course yet.", extra: null };

  const conceptLine = concepts.length ? concepts.map((c) => `${c.name} (${c.lectures} lectures, first in Lecture ${pad(c.first)})`).join("; ") : "";
  const deterministic = [
    ...ctx.lectures.map((l) => {
      const o = outline.find((x) => x.lectureId === l.id)!;
      return `${l.number ?? "—"}. **${l.title || "Untitled"}** [L${l.number}] — ${o.topics.slice(0, 6).map((t) => t.title).join(", ") || "no content yet"}`;
    }),
    ...(concepts.length ? ["", "## Concepts that recur across lectures", ...concepts.slice(0, 15).map((c) => `- **${c.name}** — ${c.lectures} lectures, first in [L${c.first}]`)] : []),
  ].join("\n");
  if (!ctx.llm) return { ...base, mode: "retrieval", answer: deterministic, extra: null };

  // Level 1: cached lecture summaries (generate a few on demand; the rest are queued in the background).
  const summaries = new Map<string, string>();
  let generated = 0;
  for (const l of ctx.lectures) {
    const hash = await lectureEvidenceHash(l.id);
    if (!hash) continue;
    const c = await q1<{ summary: string; evidence_hash: string }>("SELECT summary, evidence_hash FROM lecture_summaries WHERE lecture_id = $1", [l.id]);
    if (c && c.evidence_hash === hash) summaries.set(l.id, c.summary);
    else if (generated < ON_DEMAND_SUMMARIES) {
      generated++;
      const s = await summarizeLecture(l.id, ctx.llm).catch(() => null);
      if (s) summaries.set(l.id, s);
    }
  }
  ctx.trace.notes.push(`lecture summaries: ${summaries.size}/${ctx.lectures.length} (generated now: ${generated})`);
  const lectureBlock = (l: LectureRow) => {
    const o = outline.find((x) => x.lectureId === l.id)!;
    return `[L${l.number}] ${lectureName(l)}\n${summaries.get(l.id) ?? `Topics: ${o.topics.slice(0, 10).map((t) => t.title).join("; ") || "(no content)"}`}`;
  };
  // Level 2: reduce in groups that fit the context window, then a final synthesis.
  const budget = await budgetFor(ctx, 2000);
  const blocks = ctx.lectures.map(lectureBlock);
  const OVERVIEW_SYSTEM = `You write a course overview for a student from per-lecture summaries. Use only the given summaries and concept list. Reference lectures with their tags exactly as given, e.g. [L3]. Do not invent topics or relationships.`;
  const groups: string[][] = [];
  let cur: string[] = [], used = 0;
  for (const b of blocks) {
    const t = estimateTokens(b);
    if (cur.length && used + t > budget) { groups.push(cur); cur = []; used = 0; }
    cur.push(b); used += t;
  }
  if (cur.length) groups.push(cur);
  let material = blocks.join("\n\n");
  if (groups.length > 1) {
    const partials: string[] = [];
    for (const g of groups) {
      const { text } = await generate(ctx, OVERVIEW_SYSTEM, `${g.join("\n\n")}\n\nCondense these lectures into one line each: "[Ln] Theme: key concepts".`, 1200);
      partials.push(text ?? g.map((b) => b.split("\n")[0]).join("\n"));
    }
    material = partials.join("\n");
  }
  const { text, error } = await generate(ctx, OVERVIEW_SYSTEM,
    `${material}\n\nConcepts that recur across lectures (from the course's concept index): ${conceptLine || "none"}\n\n` +
    `Write: 1) a numbered list, one line per lecture: "**Theme** [Ln]: one sentence"; 2) "## Major concepts and how they connect" — only connections supported by the summaries or the recurring-concept list, with [Ln] tags.`, 2000);
  if (!text) return { ...base, mode: "retrieval", answer: deterministic, extra: null, aiError: error };
  const v = validateCitations(text, 0, ctx.lectures.map((l) => l.number ?? -1));
  ctx.trace.citations = { cited: [], invalid: v.invalid };
  return { ...base, mode: "answer", answer: v.text, extra: null };
}

export const _test = { groupsOf, extractiveRecall };
