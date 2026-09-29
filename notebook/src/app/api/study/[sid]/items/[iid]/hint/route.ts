import { notFound, route } from "@/lib/api";
import { takeHint } from "@/lib/study/engine";

export const POST = route<{ sid: string; iid: string }>(async (_req, user, { sid, iid }) => {
  const r = await takeHint(user.id, sid, iid);
  if (!r) throw notFound();
  return r;
});
