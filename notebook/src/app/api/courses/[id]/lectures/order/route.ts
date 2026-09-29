import { body, notFound, route } from "@/lib/api";
import { reorderLectures } from "@/lib/repo";
import { reorderSchema } from "@/lib/validation";

export const PUT = route<{ id: string }>(async (req, user, { id }) => {
  if (!(await reorderLectures(user.id, id, reorderSchema.parse(await body(req)).ids))) throw notFound();
  return { ok: true };
});
