// Data access. Every function takes the acting userId and scopes queries through courses.user_id,
// so a user can never read or change another user's courses, lectures, notes or materials.
import type { z } from "zod";
import { q, q1, tx } from "./db";
import type { courseSchema, lectureSchema } from "./validation";

export type Course = {
  id: string; name: string; code: string | null; instructor: string | null;
  semester: string | null; description: string | null; updated_at: Date;
};
export type Lecture = {
  id: string; course_id: string; number: number | null; title: string;
  lecture_date: string | null; position: number; updated_at: Date;
};
export type LectureRow = Lecture & { materials: string[]; last_edited: Date };
export type Material = {
  id: string; course_id: string; lecture_id: string | null; kind: string; filename: string;
  mime: string; size_bytes: number; storage_key: string; status: string; error: string | null;
  page_count: number | null; created_at: Date; embed_status: string; embed_error: string | null;
};
export type Note = { id: string; lecture_id: string; content: unknown; plain_text: string; version: number; updated_at: Date };

const COURSE_COLS = "c.id, c.name, c.code, c.instructor, c.semester, c.description, c.updated_at";
const LECTURE_COLS = "l.id, l.course_id, l.number, l.title, to_char(l.lecture_date,'YYYY-MM-DD') AS lecture_date, l.position, l.updated_at";

// ---------- courses ----------
export const listCourses = (userId: string) =>
  q<Course & { lecture_count: number }>(
    `SELECT ${COURSE_COLS}, (SELECT count(*)::int FROM lectures l WHERE l.course_id = c.id) AS lecture_count
     FROM courses c WHERE c.user_id = $1 ORDER BY c.updated_at DESC`, [userId]);

export const getCourse = (userId: string, id: string) =>
  q1<Course>(`SELECT ${COURSE_COLS} FROM courses c WHERE c.id = $1 AND c.user_id = $2`, [id, userId]);

export async function createCourse(userId: string, d: z.infer<typeof courseSchema>): Promise<Course> {
  const row = await q1<Course>(
    `INSERT INTO courses AS c (user_id, name, code, instructor, semester, description) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING ${COURSE_COLS}`,
    [userId, d.name, d.code, d.instructor, d.semester, d.description]);
  return row!;
}

export const updateCourse = (userId: string, id: string, d: z.infer<typeof courseSchema>) =>
  q1<Course>(
    `UPDATE courses c SET name=$3, code=$4, instructor=$5, semester=$6, description=$7, updated_at=now()
     WHERE c.id=$1 AND c.user_id=$2 RETURNING ${COURSE_COLS}`,
    [id, userId, d.name, d.code, d.instructor, d.semester, d.description]);

export const deleteCourse = async (userId: string, id: string) =>
  (await q<{ id: string }>("DELETE FROM courses WHERE id=$1 AND user_id=$2 RETURNING id", [id, userId])).length > 0;

const touchCourse = (courseId: string) => q("UPDATE courses SET updated_at = now() WHERE id = $1", [courseId]);

// ---------- lectures ----------
export const listLectures = (userId: string, courseId: string) =>
  q<LectureRow>(
    `SELECT ${LECTURE_COLS},
       coalesce((SELECT array_agg(m.filename ORDER BY m.created_at) FROM materials m WHERE m.lecture_id = l.id), '{}') AS materials,
       greatest(l.updated_at, coalesce(n.updated_at, l.updated_at)) AS last_edited
     FROM lectures l JOIN courses c ON c.id = l.course_id LEFT JOIN notes n ON n.lecture_id = l.id
     WHERE l.course_id = $1 AND c.user_id = $2 ORDER BY l.position, l.created_at`, [courseId, userId]);

export const getLecture = (userId: string, id: string) =>
  q1<Lecture & { course_name: string }>(
    `SELECT ${LECTURE_COLS}, c.name AS course_name FROM lectures l JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1 AND c.user_id = $2`, [id, userId]);

export async function createLecture(userId: string, courseId: string, d: z.infer<typeof lectureSchema>) {
  if (!(await getCourse(userId, courseId))) return null;
  const row = await q1<Lecture>(
    `INSERT INTO lectures AS l (course_id, number, title, lecture_date, position)
     SELECT $1,
       coalesce($2::int, (SELECT coalesce(max(number), 0) + 1 FROM lectures WHERE course_id = $1)),
       $3, $4::date,
       (SELECT coalesce(max(position), -1) + 1 FROM lectures WHERE course_id = $1)
     RETURNING ${LECTURE_COLS}`,
    [courseId, d.number ?? null, d.title, d.lectureDate ?? null]);
  await touchCourse(courseId);
  return row!;
}

export async function updateLecture(userId: string, id: string, d: z.infer<typeof lectureSchema>) {
  return q1<Lecture>(
    `UPDATE lectures l SET number = coalesce($3::int, l.number), title = $4, lecture_date = $5::date, updated_at = now()
     FROM courses c WHERE c.id = l.course_id AND l.id = $1 AND c.user_id = $2 RETURNING ${LECTURE_COLS}`,
    [id, userId, d.number ?? null, d.title, d.lectureDate ?? null]);
}

export const deleteLecture = async (userId: string, id: string) =>
  (await q(`DELETE FROM lectures l USING courses c WHERE c.id = l.course_id AND l.id = $1 AND c.user_id = $2 RETURNING l.id`, [id, userId])).length > 0;

export async function reorderLectures(userId: string, courseId: string, ids: string[]): Promise<boolean> {
  if (!(await getCourse(userId, courseId))) return false;
  await q(
    `UPDATE lectures l SET position = o.pos FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
     WHERE l.id = o.id AND l.course_id = $1`, [courseId, ids]);
  return true;
}

// ---------- notes ----------
export async function getOrCreateNote(userId: string, lectureId: string): Promise<Note | null> {
  if (!(await getLecture(userId, lectureId))) return null;
  await q("INSERT INTO notes (lecture_id) VALUES ($1) ON CONFLICT (lecture_id) DO NOTHING", [lectureId]);
  return q1<Note>("SELECT id, lecture_id, content, plain_text, version, updated_at FROM notes WHERE lecture_id = $1", [lectureId]);
}

const SNAPSHOT_EVERY_MIN = 10;

/** Saves the note. Keeps a history snapshot of the previous content at most every 10 minutes (or always for non-autosave reasons). */
export async function saveNote(userId: string, lectureId: string, content: unknown, plainText: string, reason = "autosave") {
  const note = await getOrCreateNote(userId, lectureId);
  if (!note) return null;
  return tx(async (c) => {
    const last = (await c.query<{ created_at: Date }>(
      "SELECT created_at FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC LIMIT 1", [note.id])).rows[0];
    const stale = !last || Date.now() - last.created_at.getTime() > SNAPSHOT_EVERY_MIN * 60e3;
    if ((reason !== "autosave" || stale) && note.plain_text + JSON.stringify(note.content) !== plainText + JSON.stringify(content)) {
      await c.query("INSERT INTO note_versions (note_id, content, plain_text, reason) VALUES ($1,$2,$3,$4)",
        [note.id, JSON.stringify(note.content), note.plain_text, reason === "autosave" ? "autosave" : `before ${reason}`]);
    }
    const r = await c.query<{ version: number; updated_at: Date }>(
      "UPDATE notes SET content = $2, plain_text = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version, updated_at",
      [note.id, JSON.stringify(content), plainText]);
    const course = (await c.query<{ course_id: string }>("SELECT course_id FROM lectures WHERE id = $1", [lectureId])).rows[0]!;
    return { noteId: note.id, courseId: course.course_id, ...r.rows[0]! };
  });
}

export const listVersions = (userId: string, lectureId: string) =>
  q<{ id: string; reason: string; created_at: Date; plain_text: string; content: unknown }>(
    `SELECT v.id, v.reason, v.created_at, v.plain_text, v.content FROM note_versions v
     JOIN notes n ON n.id = v.note_id JOIN lectures l ON l.id = n.lecture_id JOIN courses c ON c.id = l.course_id
     WHERE n.lecture_id = $1 AND c.user_id = $2 ORDER BY v.created_at DESC LIMIT 100`, [lectureId, userId]);

export async function restoreVersion(userId: string, lectureId: string, versionId: string) {
  const v = (await listVersions(userId, lectureId)).find((x) => x.id === versionId);
  if (!v) return null;
  return saveNote(userId, lectureId, v.content, v.plain_text, "restore");
}

// ---------- materials ----------
const MAT_COLS = "m.id, m.course_id, m.lecture_id, m.kind, m.filename, m.mime, m.size_bytes, m.storage_key, m.status, m.error, m.page_count, m.created_at, m.embed_status, m.embed_error";

export const listMaterials = (userId: string, courseId: string, lectureId?: string | null) =>
  q<Material>(
    `SELECT ${MAT_COLS} FROM materials m JOIN courses c ON c.id = m.course_id
     WHERE m.course_id = $1 AND c.user_id = $2 AND ($3::uuid IS NULL OR m.lecture_id = $3)
     ORDER BY m.lecture_id NULLS FIRST, m.created_at`, [courseId, userId, lectureId ?? null]);

export const getMaterial = (userId: string, id: string) =>
  q1<Material>(`SELECT ${MAT_COLS} FROM materials m JOIN courses c ON c.id = m.course_id WHERE m.id = $1 AND c.user_id = $2`, [id, userId]);

export async function createMaterial(d: Omit<Material, "id" | "status" | "error" | "page_count" | "created_at" | "embed_status" | "embed_error">) {
  return (await q1<Material>(
    `INSERT INTO materials AS m (course_id, lecture_id, kind, filename, mime, size_bytes, storage_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${MAT_COLS}`,
    [d.course_id, d.lecture_id, d.kind, d.filename, d.mime, d.size_bytes, d.storage_key]))!;
}

export const deleteMaterial = (userId: string, id: string) =>
  q1<{ storage_key: string }>(
    `DELETE FROM materials m USING courses c WHERE c.id = m.course_id AND m.id = $1 AND c.user_id = $2 RETURNING m.storage_key`, [id, userId]);

export const getPages = (materialId: string) =>
  q<{ page_no: number; title: string | null; body: string; speaker_notes: string | null }>(
    "SELECT page_no, title, body, speaker_notes FROM document_pages WHERE material_id = $1 ORDER BY page_no", [materialId]);
