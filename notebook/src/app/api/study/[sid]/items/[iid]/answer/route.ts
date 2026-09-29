import { body, HttpError, notFound, route } from "@/lib/api";
import { answerItem } from "@/lib/study/engine";
import { studyAnswerSchema } from "@/lib/validation";

export const maxDuration = 120;
export const POST = route<{ sid: string; iid: string }>(async (req, user, { sid, iid }) => {
  const r = await answerItem(user.id, sid, iid, studyAnswerSchema.parse(await body(req)));
  if (!r) throw notFound();
  if ("error" in r) throw new HttpError(409, r.error!);
  return r;
});
