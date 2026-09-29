import "server-only";
// Indexing pipeline (runs in background jobs, see jobs.ts):
//   material: extract → normalize → chunk (+slide/page, section, evidence class, hash) → lexicon/aliases → embed
//   note:     debounce → diff pieces by content hash → delete removed / insert new → embed only new pieces
// Embeddings are keyed by embedder identity; stale vectors are ignored at query time and re-embedded on demand.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getEmbedder } from "./ai/provider";
import { extractAliases } from "./aliases";
import { notePieces, splitText } from "./chunk";
import { q, q1, tx } from "./db";
import { detectType, extract } from "./extract";
import { enqueue, registerHandler, setFinalFailureHook } from "./jobs";
import * as storage from "./storage";

const EMBED_BATCH = 32;
const NOTE_DEBOUNCE_MS = 4000;
const CONCEPT_DEBOUNCE_MS = 20_000;
const SUMMARY_DEBOUNCE_MS = 120_000;

/** Same as SQL md5(coalesce(section,'') || E'\\x1f' || text). */
export const contentHash = (section: string | null, text: string) => createHash("md5").update(`${section ?? ""}\x1f${text}`).digest("hex");

export const sourceKindFor = (materialKind: string) =>
  materialKind === "notes" ? "teacher_notes" : materialKind === "syllabus" ? "outline" : materialKind;

// ---------------- materials ----------------

export async function queueMaterial(materialId: string, courseId: string) {
  await q("UPDATE materials SET status = 'pending', error = NULL WHERE id = $1", [materialId]);
  await enqueue("extract_material", materialId, courseId);
}

export async function processMaterial(materialId: string): Promise<void> {
  const m = await q1<{ id: string; course_id: string; lecture_id: string | null; filename: string; storage_key: string; kind: string }>(
    "UPDATE materials SET status = 'processing', error = NULL WHERE id = $1 RETURNING id, course_id, lecture_id, filename, storage_key, kind", [materialId]);
  if (!m) return;
  const bytes = await storage.get(m.storage_key);
  const type = detectType(m.filename, bytes);
  if (!type) throw new Error("Unsupported or damaged file");
  const pages = await extract(type, bytes);
  const contentType = type === "pptx" ? "slide" : type === "pdf" ? "page" : "document";
  const sourceKind = sourceKindFor(m.kind);
  const hasText = pages.some((p) => p.body.trim() || p.speakerNotes?.trim());
  const emb = getEmbedder();

  await tx(async (c) => {
    await c.query("DELETE FROM document_pages WHERE material_id = $1", [m.id]);
    await c.query("DELETE FROM chunks WHERE material_id = $1", [m.id]);
    let ord = 0;
    for (const p of pages) {
      await c.query("INSERT INTO document_pages (material_id, page_no, title, body, speaker_notes) VALUES ($1,$2,$3,$4,$5)",
        [m.id, p.pageNo, p.title, p.body, p.speakerNotes]);
      // Slide/page text carries its title so each chunk stands alone; speaker notes are their own evidence class.
      const body = p.title && !p.body.replace(/^#+\s*/, "").startsWith(p.title) ? `${p.title}\n${p.body}` : p.body;
      const pieces: [string, string][] = splitText(body).map((t) => [contentType, t]);
      if (p.speakerNotes?.trim()) pieces.push(...splitText(p.speakerNotes).map((t): [string, string] => ["speaker_notes", t]));
      for (const [ct, text] of pieces) {
        await c.query(
          `INSERT INTO chunks (course_id, lecture_id, material_id, source_type, source_kind, content_type, page_no, section, ord, text, content_hash)
           VALUES ($1,$2,$3,'material',$4,$5,$6,$7,$8,$9, md5(coalesce($7,'') || E'\\x1f' || $9))`,
          [m.course_id, m.lecture_id, m.id, sourceKind, ct, p.pageNo, p.title, ord++, text]);
      }
    }
    await addLexicon(c, m.course_id, "material_id", m.id);
    await saveAliases(c, m.course_id, "material_id", m.id);
    await c.query(
      "UPDATE materials SET status = 'ready', page_count = $2, embed_status = $3, embed_error = NULL WHERE id = $1",
      [m.id, pages.length, emb && hasText ? "pending" : "none"]);
  });
  await afterContentChange(m.course_id, m.lecture_id);
}

// ---------------- notes ----------------

export async function queueNote(noteId: string, courseId: string) {
  await enqueue("index_note", noteId, courseId, NOTE_DEBOUNCE_MS);
}

/** Incremental: unchanged pieces keep their chunk (and embedding); only new/changed pieces are inserted and embedded. */
export async function indexNote(noteId: string): Promise<void> {
  const n = await q1<{ content: { type: "doc" }; lecture_id: string; course_id: string }>(
    "SELECT n.content, n.lecture_id, l.course_id FROM notes n JOIN lectures l ON l.id = n.lecture_id WHERE n.id = $1", [noteId]);
  if (!n) return;
  const pieces = notePieces(n.content);
  let inserted = 0;
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [noteId]);
    const existing = (await c.query<{ id: string; content_hash: string }>("SELECT id, content_hash FROM chunks WHERE note_id = $1", [noteId])).rows;
    const byHash = new Map<string, string[]>();
    for (const r of existing) byHash.set(r.content_hash, [...(byHash.get(r.content_hash) ?? []), r.id]);
    const keep = new Set<string>();
    for (const [ord, p] of pieces.entries()) {
      const hash = contentHash(p.section, p.text);
      const reuse = byHash.get(hash)?.shift();
      if (reuse) {
        keep.add(reuse);
        await c.query("UPDATE chunks SET ord = $2, anchor = $3 WHERE id = $1", [reuse, ord, p.anchor]);
        continue;
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO chunks (course_id, lecture_id, note_id, source_type, source_kind, content_type, section, ord, text, content_hash, anchor)
         VALUES ($1,$2,$3,'note',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [n.course_id, n.lecture_id, noteId, p.sourceKind, p.contentType, p.section, ord, p.text, hash, p.anchor]);
      keep.add(r.rows[0]!.id);
      inserted++;
    }
    const drop = existing.map((r) => r.id).filter((id) => !keep.has(id));
    if (drop.length) await c.query("DELETE FROM chunks WHERE id = ANY($1)", [drop]);
    if (inserted) await addLexicon(c, n.course_id, "note_id", noteId);
    await saveAliases(c, n.course_id, "note_id", noteId);
    const pending = getEmbedder() ? (await c.query("SELECT 1 FROM chunks WHERE note_id = $1 AND embedding IS NULL LIMIT 1", [noteId])).rowCount : 0;
    await c.query("UPDATE notes SET embed_status = $2, embed_error = NULL WHERE id = $1",
      [noteId, !getEmbedder() ? "none" : pending ? "pending" : "ready"]);
  });
  await afterContentChange(n.course_id, n.lecture_id);
}

async function afterContentChange(courseId: string, lectureId: string | null) {
  if (getEmbedder()) await enqueue("embed_course", courseId, courseId);
  await enqueue("build_concepts", courseId, courseId, CONCEPT_DEBOUNCE_MS);
  if (lectureId) await enqueue("summarize_lecture", lectureId, courseId, SUMMARY_DEBOUNCE_MS);
}

// ---------------- lexicon & aliases ----------------

async function addLexicon(c: PoolClient, courseId: string, col: "material_id" | "note_id", id: string) {
  await c.query(
    `INSERT INTO course_terms (course_id, term)
     SELECT DISTINCT $1::uuid, w FROM chunks ch, regexp_split_to_table(lower(ch.text || ' ' || coalesce(ch.section, '')), '[^a-z0-9]+') AS w
     WHERE ch.${col} = $2 AND length(w) BETWEEN 2 AND 40
     ON CONFLICT DO NOTHING`, [courseId, id]);
}

async function saveAliases(c: PoolClient, courseId: string, col: "material_id" | "note_id", id: string) {
  const rows = (await c.query<{ id: string; text: string }>(`SELECT id, text FROM chunks WHERE ${col} = $1`, [id])).rows;
  for (const r of rows)
    for (const a of extractAliases(r.text))
      await c.query(
        "INSERT INTO course_aliases (course_id, alias, expansion, chunk_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [courseId, a.alias, a.expansion, r.id]);
}

/** Rebuilds the course vocabulary from scratch (after deletions or re-chunking). */
export async function rebuildLexicon(courseId: string) {
  await tx(async (c) => {
    await c.query("DELETE FROM course_terms WHERE course_id = $1", [courseId]);
    await c.query(
      `INSERT INTO course_terms (course_id, term)
       SELECT DISTINCT $1::uuid, w FROM chunks ch, regexp_split_to_table(lower(ch.text || ' ' || coalesce(ch.section, '')), '[^a-z0-9]+') AS w
       WHERE ch.course_id = $1 AND length(w) BETWEEN 2 AND 40 ON CONFLICT DO NOTHING`, [courseId]);
  });
}

// ---------------- embeddings ----------------

/** Embeds every chunk of the course that lacks a vector for the current embedder (new or stale). */
export async function embedCourse(courseId: string): Promise<number> {
  const emb = getEmbedder();
  if (!emb) return 0;
  await q(
    `UPDATE materials SET embed_status = 'processing' WHERE course_id = $1 AND status = 'ready'
       AND EXISTS (SELECT 1 FROM chunks ch WHERE ch.material_id = materials.id AND ch.embedding_model IS DISTINCT FROM $2)`, [courseId, emb.key]);
  let done = 0;
  for (;;) {
    // The embedded text carries its lecture + section context; the stored chunk text stays verbatim.
    const rows = await q<{ id: string; input: string }>(
      `SELECT ch.id, concat_ws(E'\\n', CASE WHEN l.id IS NOT NULL THEN concat('Lecture ', l.number, ': ', l.title) END,
                               ch.section, ch.text) AS input
       FROM chunks ch LEFT JOIN lectures l ON l.id = ch.lecture_id
       WHERE ch.course_id = $1 AND ch.embedding_model IS DISTINCT FROM $2
       ORDER BY ch.created_at LIMIT ${EMBED_BATCH}`, [courseId, emb.key]);
    if (!rows.length) break;
    const vecs = await emb.embed(rows.map((r) => r.input.slice(0, 8000)), "document");
    await q(
      `UPDATE chunks ch SET embedding = v.vec::vector, embedding_model = $2
       FROM unnest($1::uuid[], $3::text[]) AS v(id, vec) WHERE ch.id = v.id`,
      [rows.map((r) => r.id), emb.key, vecs.map((v) => `[${v.join(",")}]`)]);
    done += rows.length;
  }
  await q(
    `UPDATE materials m SET embed_status = 'ready', embed_error = NULL WHERE course_id = $1 AND status = 'ready' AND embed_status <> 'none'
       AND NOT EXISTS (SELECT 1 FROM chunks ch WHERE ch.material_id = m.id AND ch.embedding_model IS DISTINCT FROM $2)`, [courseId, emb.key]);
  await q(
    `UPDATE notes n SET embed_status = 'ready', embed_error = NULL FROM lectures l
     WHERE l.id = n.lecture_id AND l.course_id = $1
       AND NOT EXISTS (SELECT 1 FROM chunks ch WHERE ch.note_id = n.id AND ch.embedding_model IS DISTINCT FROM $2)`, [courseId, emb.key]);
  return done;
}

// ---------------- job wiring ----------------

export function registerIndexingJobs(extra: { buildConcepts: (courseId: string) => Promise<void>; summarizeLecture: (lectureId: string) => Promise<void> }) {
  registerHandler("extract_material", (j) => processMaterial(j.target_id));
  registerHandler("index_note", (j) => indexNote(j.target_id));
  registerHandler("embed_course", async (j) => { await embedCourse(j.target_id); });
  registerHandler("build_concepts", (j) => extra.buildConcepts(j.target_id));
  registerHandler("summarize_lecture", (j) => extra.summarizeLecture(j.target_id));
  // Surface final failures on the source so the student sees "Processing failed · Retry".
  setFinalFailureHook(async (job, msg) => {
    if (job.kind === "extract_material") await q("UPDATE materials SET status = 'failed', error = $2 WHERE id = $1", [job.target_id, msg]);
    if (job.kind === "embed_course") {
      await q("UPDATE materials SET embed_status = 'failed', embed_error = $2 WHERE course_id = $1 AND embed_status IN ('pending','processing')", [job.target_id, msg]);
      await q(`UPDATE notes n SET embed_status = 'failed', embed_error = $2 FROM lectures l WHERE l.id = n.lecture_id AND l.course_id = $1 AND n.embed_status IN ('pending','processing')`, [job.target_id, msg]);
    }
  });
}

// ---------------- reindexing ----------------

export type ReindexScope = { kind: "material" | "lecture" | "course"; id: string };

/** Re-extracts/re-chunks and (optionally only) re-embeds content without touching the student's files or notes. */
export async function reindex(scope: ReindexScope, opts: { embeddingsOnly?: boolean } = {}): Promise<{ materials: number; notes: number }> {
  const courseId = scope.kind === "course" ? scope.id
    : scope.kind === "lecture" ? (await q1<{ course_id: string }>("SELECT course_id FROM lectures WHERE id = $1", [scope.id]))?.course_id
    : (await q1<{ course_id: string }>("SELECT course_id FROM materials WHERE id = $1", [scope.id]))?.course_id;
  if (!courseId) return { materials: 0, notes: 0 };
  const where = scope.kind === "course" ? "course_id = $1" : scope.kind === "lecture" ? "lecture_id = $1" : "id = $1";
  if (opts.embeddingsOnly) {
    const col = scope.kind === "course" ? "course_id" : scope.kind === "lecture" ? "lecture_id" : "material_id";
    await q(`UPDATE chunks SET embedding = NULL, embedding_model = NULL WHERE ${col} = $1`, [scope.id]);
    if (getEmbedder()) await enqueue("embed_course", courseId, courseId);
    return { materials: 0, notes: 0 };
  }
  const mats = await q<{ id: string }>(`SELECT id FROM materials WHERE ${where}`, [scope.id]);
  for (const m of mats) await queueMaterial(m.id, courseId);
  const notes = scope.kind === "material" ? [] : await q<{ id: string }>(
    scope.kind === "course" ? "SELECT n.id FROM notes n JOIN lectures l ON l.id = n.lecture_id WHERE l.course_id = $1" : "SELECT id FROM notes WHERE lecture_id = $1",
    [scope.id]);
  if (notes.length) await q("DELETE FROM chunks WHERE note_id = ANY($1)", [notes.map((n) => n.id)]);
  for (const n of notes) await enqueue("index_note", n.id, courseId);
  if (scope.kind === "course") await rebuildLexicon(courseId);
  return { materials: mats.length, notes: notes.length };
}

/** Counts chunks whose vectors were produced by a different embedder than the one configured now. */
export async function embeddingHealth(courseId?: string) {
  const emb = getEmbedder();
  const rows = await q<{ model: string | null; n: number }>(
    `SELECT embedding_model AS model, count(*)::int AS n FROM chunks WHERE ($1::uuid IS NULL OR course_id = $1) GROUP BY 1 ORDER BY 2 DESC`,
    [courseId ?? null]);
  const current = emb?.key ?? null;
  return {
    current,
    byModel: rows,
    stale: rows.filter((r) => r.model && r.model !== current).reduce((s, r) => s + r.n, 0),
    missing: current ? rows.filter((r) => r.model !== current).reduce((s, r) => s + r.n, 0) : 0,
  };
}
