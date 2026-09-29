import { notFound, route } from "@/lib/api";
import { sessionView } from "@/lib/study/engine";

/** Session state. Answers, rubrics and sources are only included for attempted items (after submission in exams). */
export const GET = route<{ sid: string }>(async (_req, user, { sid }) => {
  const v = await sessionView(user.id, sid);
  if (!v) throw notFound();
  return v;
});
