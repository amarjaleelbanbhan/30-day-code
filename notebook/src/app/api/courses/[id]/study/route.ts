import { body, HttpError, notFound, route } from "@/lib/api";
import { createSession, overview } from "@/lib/study/engine";
import { studyCreateSchema } from "@/lib/validation";

type P = { id: string };
/** Study overview for a course: coverage, weak areas, due reviews, sessions to resume. */
export const GET = route<P>(async (_req, user, { id }) => {
  const o = await overview(user.id, id);
  if (!o) throw notFound();
  return o;
});
export const maxDuration = 300;
/** Start a study / master / weak-area / review / exam session. */
export const POST = route<P>(async (req, user, { id }) => {
  const { kind, scope, config } = studyCreateSchema.parse(await body(req));
  const r = await createSession(user.id, id, kind, scope, config);
  if (!r) throw notFound();
  if ("error" in r) throw new HttpError(422, r.error ?? "Could not start");
  return r;
});
