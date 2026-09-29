import { notFound, route } from "@/lib/api";
import { finishSession } from "@/lib/study/engine";

export const maxDuration = 300;
/** Ends the session (grades an exam) and returns the summary. */
export const POST = route<{ sid: string }>(async (_req, user, { sid }) => {
  const s = await finishSession(user.id, sid);
  if (!s) throw notFound();
  return s;
});
