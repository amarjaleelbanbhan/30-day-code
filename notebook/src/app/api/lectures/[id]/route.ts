import { body, notFound, route } from "@/lib/api";
import { deleteLecture, updateLecture } from "@/lib/repo";
import { lectureSchema } from "@/lib/validation";

type P = { id: string };
export const PATCH = route<P>(async (req, user, { id }) => {
  const lecture = await updateLecture(user.id, id, lectureSchema.parse(await body(req)));
  if (!lecture) throw notFound();
  return { lecture };
});
export const DELETE = route<P>(async (_req, user, { id }) => {
  if (!(await deleteLecture(user.id, id))) throw notFound();
  return { ok: true };
});
