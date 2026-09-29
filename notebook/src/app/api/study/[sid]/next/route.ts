import { notFound, route } from "@/lib/api";
import { getSession, nextItem } from "@/lib/study/engine";

export const maxDuration = 300;
export const POST = route<{ sid: string }>(async (_req, user, { sid }) => {
  if (!(await getSession(user.id, sid))) throw notFound();
  const n = await nextItem(user.id, sid);
  return n ?? { done: true };
});
