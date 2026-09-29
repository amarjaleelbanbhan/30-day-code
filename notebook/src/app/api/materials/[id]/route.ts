import { notFound, route } from "@/lib/api";
import { enqueue } from "@/lib/jobs";
import { queueMaterial } from "@/lib/ingest";
import { q } from "@/lib/db";
import { deleteMaterial, getMaterial, getPages } from "@/lib/repo";
import * as storage from "@/lib/storage";

type P = { id: string };
export const GET = route<P>(async (_req, user, { id }) => {
  const material = await getMaterial(user.id, id);
  if (!material) throw notFound();
  return { material, pages: await getPages(id) };
});
/** Retry: re-run extraction after a processing failure, or re-queue embeddings after an indexing failure. */
export const POST = route<P>(async (_req, user, { id }) => {
  const m = await getMaterial(user.id, id);
  if (!m) throw notFound();
  if (m.status === "ready" && m.embed_status === "failed") {
    await q("UPDATE materials SET embed_status = 'pending', embed_error = NULL WHERE id = $1", [id]);
    await enqueue("embed_course", m.course_id, m.course_id);
  } else await queueMaterial(id, m.course_id);
  return { ok: true };
});
export const DELETE = route<P>(async (_req, user, { id }) => {
  const m = await deleteMaterial(user.id, id);
  if (!m) throw notFound();
  await storage.del(m.storage_key);
  return { ok: true };
});
