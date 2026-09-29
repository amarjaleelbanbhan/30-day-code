import { body, notFound, route } from "@/lib/api";
import { createLecture, listLectures } from "@/lib/repo";
import { lectureSchema } from "@/lib/validation";

type P = { id: string };
export const GET = route<P>(async (_req, user, { id }) => ({ lectures: await listLectures(user.id, id) }));
export const POST = route<P>(async (req, user, { id }) => {
  const lecture = await createLecture(user.id, id, lectureSchema.parse(await body(req)));
  if (!lecture) throw notFound();
  return { lecture };
});
