import { notFound } from "next/navigation";
import { ConceptView } from "@/components/ConceptView";
import { requireUser } from "@/lib/auth";
import { conceptDetail } from "@/lib/concepts";
import { getCourse } from "@/lib/repo";
import { citationLabel } from "@/lib/search";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function ConceptPage({ params }: { params: Promise<{ courseId: string; conceptId: string }> }) {
  const { courseId, conceptId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId) || !isUuid(conceptId)) notFound();
  const [course, detail] = await Promise.all([getCourse(user.id, courseId), conceptDetail(user.id, conceptId)]);
  if (!course || !detail || detail.concept.course_id !== courseId) notFound();
  return (
    <ConceptView
      course={{ id: course.id, name: course.name }}
      concept={{ id: detail.concept.id, name: detail.concept.name, aliases: detail.concept.aliases }}
      related={detail.related}
      evidence={detail.evidence.map((e) => ({ ...e, label: citationLabel(e) }))}
    />
  );
}
