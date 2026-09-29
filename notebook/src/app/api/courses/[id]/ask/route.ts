import { body, notFound, route } from "@/lib/api";
import { debugEnabled } from "@/lib/debug";
import { ask } from "@/lib/rag";
import { getCourse } from "@/lib/repo";
import { askSchema } from "@/lib/validation";

export const maxDuration = 300;
export const POST = route<{ id: string }>(async (req, user, { id }) => {
  if (!(await getCourse(user.id, id))) throw notFound();
  const { question, lectureId, mode } = askSchema.parse(await body(req));
  const debug = debugEnabled() && req.nextUrl.searchParams.get("debug") === "1";
  return ask(user.id, id, question, { lectureId, mode, debug });
});
