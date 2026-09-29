import { z } from "zod";
import { body, notFound, route } from "@/lib/api";
import { queueNote } from "@/lib/ingest";
import { listVersions, restoreVersion } from "@/lib/repo";

type P = { id: string };
export const GET = route<P>(async (_req, user, { id }) => ({ versions: await listVersions(user.id, id) }));
export const POST = route<P>(async (req, user, { id }) => {
  const { versionId } = z.object({ versionId: z.string().uuid() }).parse(await body(req));
  const saved = await restoreVersion(user.id, id, versionId);
  if (!saved) throw notFound();
  await queueNote(saved.noteId, saved.courseId);
  return { version: saved.version };
});
