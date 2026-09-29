import { z } from "zod";
import { body, notFound, route } from "@/lib/api";
import { q1 } from "@/lib/db";
import { debugEnabled } from "@/lib/debug";
import { reindex } from "@/lib/ingest";
import { getCourse } from "@/lib/repo";

const schema = z.object({
  scope: z.enum(["course", "lecture", "material"]),
  id: z.string().uuid().optional(),
  embeddingsOnly: z.boolean().optional(),
});

/** Developer/admin: re-extract, re-chunk and/or re-embed without touching the student's files or notes. */
export const POST = route<{ id: string }>(async (req, user, { id: courseId }) => {
  if (!debugEnabled() || !(await getCourse(user.id, courseId))) throw notFound();
  const { scope, id, embeddingsOnly } = schema.parse(await body(req));
  const target = scope === "course" ? courseId : id;
  if (!target) throw notFound();
  if (scope !== "course") {
    const table = scope === "lecture" ? "lectures" : "materials";
    if (!(await q1(`SELECT 1 FROM ${table} WHERE id = $1 AND course_id = $2`, [target, courseId]))) throw notFound();
  }
  return reindex({ kind: scope, id: target }, { embeddingsOnly });
});
