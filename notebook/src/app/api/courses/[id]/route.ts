import { body, notFound, route } from "@/lib/api";
import { deleteCourse, listMaterials, updateCourse } from "@/lib/repo";
import * as storage from "@/lib/storage";
import { courseSchema } from "@/lib/validation";

type P = { id: string };
export const PATCH = route<P>(async (req, user, { id }) => {
  const course = await updateCourse(user.id, id, courseSchema.parse(await body(req)));
  if (!course) throw notFound();
  return { course };
});
export const DELETE = route<P>(async (_req, user, { id }) => {
  const files = await listMaterials(user.id, id);
  if (!(await deleteCourse(user.id, id))) throw notFound();
  await Promise.all(files.map((m) => storage.del(m.storage_key)));
  return { ok: true };
});
