import { notFound, route } from "@/lib/api";
import { capabilities } from "@/lib/ai/provider";
import { q } from "@/lib/db";
import { debugEnabled } from "@/lib/debug";
import { embeddingHealth } from "@/lib/ingest";
import { getCourse } from "@/lib/repo";

/** Developer-only: provider capabilities, index health and job queue for a course. */
export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  if (!debugEnabled() || !(await getCourse(user.id, id))) throw notFound();
  const [caps, health, jobs, chunks, concepts] = await Promise.all([
    capabilities(true),
    embeddingHealth(id),
    q("SELECT kind, target_id, status, attempts, error, run_after FROM jobs WHERE course_id = $1 ORDER BY run_after LIMIT 50", [id]),
    q("SELECT source_kind, content_type, count(*)::int AS n, count(embedding)::int AS embedded FROM chunks WHERE course_id = $1 GROUP BY 1, 2 ORDER BY 1, 2", [id]),
    q("SELECT count(*)::int AS concepts, (SELECT count(*)::int FROM concept_relations r JOIN concepts k ON k.id = r.a WHERE k.course_id = $1) AS relations FROM concepts WHERE course_id = $1", [id]),
  ]);
  return { capabilities: caps, embeddings: health, jobs, chunks, concepts: concepts[0] };
});
