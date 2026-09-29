import { after } from "next/server";
import { notFound, route } from "@/lib/api";
import { processMaterial } from "@/lib/ingest";
import { deleteMaterial, getMaterial, getPages } from "@/lib/repo";
import * as storage from "@/lib/storage";

type P = { id: string };
export const GET = route<P>(async (_req, user, { id }) => {
  const material = await getMaterial(user.id, id);
  if (!material) throw notFound();
  return { material, pages: await getPages(id) };
});
/** Re-run extraction (e.g. after a failure). */
export const POST = route<P>(async (_req, user, { id }) => {
  if (!(await getMaterial(user.id, id))) throw notFound();
  after(() => processMaterial(id));
  return { ok: true };
});
export const DELETE = route<P>(async (_req, user, { id }) => {
  const m = await deleteMaterial(user.id, id);
  if (!m) throw notFound();
  await storage.del(m.storage_key);
  return { ok: true };
});
