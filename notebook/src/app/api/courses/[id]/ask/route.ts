import { body, notFound, route } from "@/lib/api";
import { ask } from "@/lib/rag";
import { getCourse } from "@/lib/repo";
import { askSchema } from "@/lib/validation";

export const maxDuration = 180;
export const POST = route<{ id: string }>(async (req, user, { id }) => {
  if (!(await getCourse(user.id, id))) throw notFound();
  const { question, lectureId, allowGeneral } = askSchema.parse(await body(req));
  return ask(user.id, id, question, { lectureId, allowGeneral });
});
