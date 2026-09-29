import { z } from "zod";
import { body, notFound, route } from "@/lib/api";
import { explainItem } from "@/lib/study/engine";

export const maxDuration = 120;
/** "Explain this" (teaches, then schedules a comprehension check) or "Why was my answer wrong?". */
export const POST = route<{ sid: string; iid: string }>(async (req, user, { sid, iid }) => {
  const { mode } = z.object({ mode: z.enum(["teach", "why"]) }).parse(await body(req));
  const r = await explainItem(user.id, sid, iid, mode);
  if (!r) throw notFound();
  return r;
});
