import { randomUUID } from "node:crypto";
import { HttpError, notFound, route } from "@/lib/api";
import { detectType, isImage, MIME } from "@/lib/extract";
import { queueMaterial } from "@/lib/ingest";
import { createMaterial, getCourse, getLecture, listMaterials } from "@/lib/repo";
import * as storage from "@/lib/storage";
import { isUuid, materialKindSchema } from "@/lib/validation";

type P = { id: string };
const maxBytes = () => Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;

export const GET = route<P>(async (req, user, { id }) => {
  if (!(await getCourse(user.id, id))) throw notFound();
  const lecture = req.nextUrl.searchParams.get("lecture");
  return { materials: await listMaterials(user.id, id, lecture && isUuid(lecture) ? lecture : null) };
});

export const POST = route<P>(async (req, user, { id: courseId }) => {
  if (!(await getCourse(user.id, courseId))) throw notFound();
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes() + 64 * 1024) throw new HttpError(413, `Files must be under ${process.env.MAX_UPLOAD_MB || 50} MB`);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "No file");
  if (file.size > maxBytes()) throw new HttpError(413, `Files must be under ${process.env.MAX_UPLOAD_MB || 50} MB`);
  const lectureId = String(form.get("lectureId") ?? "") || null;
  if (lectureId) {
    const l = await getLecture(user.id, lectureId);
    if (!l || l.course_id !== courseId) throw notFound();
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectType(file.name, bytes);
  if (!type) throw new HttpError(415, "Unsupported or damaged file. Use PDF, PPTX, DOCX, TXT, Markdown or an image.");
  const kindParsed = materialKindSchema.safeParse(form.get("kind"));
  let kind = isImage(type) ? "image" : kindParsed.success ? kindParsed.data : lectureId ? "slides" : "other";
  // A text document uploaded with the default "lecture slides" type is notes, not slides.
  if (kind === "slides" && (type === "md" || type === "txt" || type === "docx")) kind = "notes";
  const key = `${courseId}/${randomUUID()}.${type}`;
  await storage.put(key, bytes);
  const filename = file.name.replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 200);
  const material = await createMaterial({ course_id: courseId, lecture_id: lectureId, kind, filename, mime: MIME[type], size_bytes: file.size, storage_key: key });
  await queueMaterial(material.id, courseId);
  return { material };
});
