// RAG context construction and citation handling (pure; unit-tested).
import type { Hit } from "./search";

export type Source = {
  n: number;
  label: string;
  kind: string;               // evidence class (source_kind)
  contentType: string;
  lectureId: string | null;
  lectureNumber: number | null;
  lectureTitle: string | null;
  materialId: string | null;
  noteId: string | null;
  filename: string | null;
  pageNo: number | null;
  slideNo: number | null;
  section: string | null;
  anchor: string | null;
  excerpt: string;
  chunkIds: string[];
  methods: string[];
  score: number;
  role: "evidence" | "neighbor" | "connection";
  alsoIn: string[];           // labels of near-identical passages elsewhere (e.g. recap slides)
};

export type Unit = Omit<Source, "n"> & { position: number | null; ordKey: number };

const estimate = (s: string) => Math.ceil(s.length / 3.6);

const EVIDENCE_NAME: Record<string, string> = {
  slides: "lecture slide", teacher_notes: "teacher's notes", book: "textbook / reference book", outline: "course outline",
  other: "course material", student_notes: "student's own notes", ai_note: "AI-generated note (not authoritative)", image: "image",
};
export const evidenceName = (s: Pick<Source, "kind" | "contentType">) =>
  s.contentType === "speaker_notes" ? "teacher's speaker notes" : s.contentType === "drawing" ? "student's drawing (caption)" : EVIDENCE_NAME[s.kind] ?? "course material";

/** Merges chunks from the same slide/page (or note section) into one citable unit. */
export function toUnits(hits: Hit[], label: (h: Hit) => string, role: Source["role"] = "evidence"): Unit[] {
  const byKey = new Map<string, Unit>();
  for (const h of hits) {
    const key = h.material_id ? `${h.material_id}:${h.page_no}:${h.content_type}` : `${h.chunk_id}`;
    const u = byKey.get(key);
    if (u) {
      if (!u.chunkIds.includes(h.chunk_id)) { u.chunkIds.push(h.chunk_id); u.excerpt += "\n" + h.content; }
      u.score = Math.max(u.score, h.score);
      u.methods = [...new Set([...u.methods, ...h.methods])];
      continue;
    }
    byKey.set(key, {
      label: label(h), kind: h.source_kind, contentType: h.content_type, lectureId: h.lecture_id, lectureNumber: h.lecture_number,
      lectureTitle: h.lecture_title, materialId: h.material_id, noteId: h.note_id, filename: h.filename, pageNo: h.page_no,
      slideNo: h.slide_no, section: h.section, anchor: h.anchor, excerpt: h.content, chunkIds: [h.chunk_id], methods: [...h.methods],
      score: h.score, role, alsoIn: [], position: h.lecture_position, ordKey: h.page_no ?? 0,
    });
  }
  return [...byKey.values()];
}

function shingles(s: string): Set<string> {
  const w = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  if (!out.size && w.length) out.add(w.join(" "));
  return out;
}
export function similarity(a: string | Set<string>, b: string | Set<string>): number {
  const A = typeof a === "string" ? shingles(a) : a, B = typeof b === "string" ? shingles(b) : b;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
}

/** Drops near-identical passages (e.g. the same slide reused in a recap), remembering where else they appeared. */
export function dedupe(units: Unit[], threshold = 0.85): Unit[] {
  const kept: { u: Unit; sh: Set<string> }[] = [];
  for (const u of [...units].sort((a, b) => b.score - a.score)) {
    const sh = shingles(u.excerpt);
    const dup = kept.find((k) => k.u.contentType === u.contentType && similarity(k.sh, sh) >= threshold);
    if (dup) dup.u.alsoIn.push(u.label);
    else kept.push({ u, sh });
  }
  return kept.map((k) => k.u);
}

export type BuildOpts = {
  budgetTokens: number;
  order: "relevance" | "chronological";
  /** Max units per lecture in the first pass (lecture diversity); remaining budget is filled by score. */
  perLecture?: number;
  neighbors?: Unit[];
  maxUnits?: number;
};

/** Selects units under a token budget with lecture diversity, adds neighbours, orders and numbers them. */
export function buildSources(units: Unit[], opts: BuildOpts): Source[] {
  const ranked = [...units].sort((a, b) => b.score - a.score);
  const chosen: Unit[] = [];
  let used = 0;
  const max = opts.maxUnits ?? 60;
  const fits = (u: Unit) => used + estimate(u.excerpt) + 30 <= opts.budgetTokens;
  const take = (u: Unit) => { chosen.push(u); used += estimate(u.excerpt) + 30; };
  if (opts.perLecture) {
    const perLec = new Map<string, number>();
    // Round-robin: best unit of each lecture first, then second best, … up to perLecture.
    for (let round = 0; round < opts.perLecture; round++) {
      const seen = new Set<string>();
      for (const u of ranked) {
        const k = u.lectureId ?? `course:${u.materialId ?? u.noteId}`;
        if (chosen.includes(u) || seen.has(k) || (perLec.get(k) ?? 0) > round) continue;
        seen.add(k);
        if (chosen.length < max && fits(u)) { take(u); perLec.set(k, (perLec.get(k) ?? 0) + 1); }
      }
    }
  }
  for (const u of ranked) if (!chosen.includes(u) && chosen.length < max && fits(u)) take(u);
  for (const nb of opts.neighbors ?? []) {
    const dupe = chosen.some((c) => c.materialId === nb.materialId && c.pageNo === nb.pageNo && c.contentType === nb.contentType);
    if (!dupe && chosen.length < max && fits(nb)) take(nb);
  }
  const sorted = opts.order === "chronological"
    ? chosen.sort((a, b) =>
        (a.position ?? 1e9) - (b.position ?? 1e9) || Number(a.materialId == null) - Number(b.materialId == null) ||
        (a.materialId ?? "").localeCompare(b.materialId ?? "") || a.ordKey - b.ordKey || Number(a.contentType === "speaker_notes") - Number(b.contentType === "speaker_notes"))
    : chosen.sort((a, b) => (a.role === "neighbor" ? 1 : 0) - (b.role === "neighbor" ? 1 : 0) || b.score - a.score);
  return sorted.map(({ position: _p, ordKey: _o, ...u }, i) => ({ ...u, n: i + 1 }));
}

export function sourceBlock(sources: Source[]): string {
  return sources.map((s) => `[${s.n}] ${s.label} — ${evidenceName(s)}${s.role === "neighbor" ? " (adjacent context)" : ""}\n${s.excerpt.trim()}`).join("\n\n---\n\n");
}

/** Removes citation numbers that don't correspond to a provided source; reports which were cited. */
export function validateCitations(text: string, sourceCount: number, lectureNumbers: number[] = []): { text: string; cited: number[]; invalid: string[] } {
  const cited = new Set<number>();
  const invalid: string[] = [];
  let out = text.replace(/\[((?:\s*\d{1,3}\s*[,;]?)+)\]/g, (_m, inner: string) => {
    const nums = inner.split(/[,;\s]+/).filter(Boolean).map(Number);
    const ok = nums.filter((n) => n >= 1 && n <= sourceCount);
    nums.filter((n) => !ok.includes(n)).forEach((n) => invalid.push(String(n)));
    ok.forEach((n) => cited.add(n));
    return ok.map((n) => `[${n}]`).join("");
  });
  out = out.replace(/\[L(\d{1,4})\]/g, (m, n: string) => {
    if (lectureNumbers.includes(Number(n))) return m;
    invalid.push(m);
    return "";
  });
  return { text: out.replace(/[ \t]+([.,;:])/g, "$1"), cited: [...cited].sort((a, b) => a - b), invalid };
}

/** Removes any [n] markers (used for the general-knowledge supplement, which must not cite course sources). */
export const stripCitations = (s: string) =>
  s.replace(/\[(?:\s*\d{1,3}\s*[,;]?)+\]|\[L\d{1,4}\]/g, "").replace(/[ \t]+([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ");
