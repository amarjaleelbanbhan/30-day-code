import { notFound, route } from "@/lib/api";
import { getCourse } from "@/lib/repo";
import { citationLabel, search } from "@/lib/search";
import { isUuid } from "@/lib/validation";

export const GET = route<{ id: string }>(async (req, user, { id }) => {
  if (!(await getCourse(user.id, id))) throw notFound();
  const query = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 500);
  const lecture = req.nextUrl.searchParams.get("lecture");
  if (!query) return { hits: [] };
  const hits = await search(user.id, id, query, { lectureIds: lecture && isUuid(lecture) ? [lecture] : undefined, limit: 30 });
  return { hits: hits.map((h) => ({ ...h, label: citationLabel(h) })) };
});
