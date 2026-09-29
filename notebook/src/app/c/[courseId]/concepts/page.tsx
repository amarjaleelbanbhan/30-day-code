import { notFound } from "next/navigation";
import { ConceptIndex } from "@/components/ConceptIndex";
import { requireUser } from "@/lib/auth";
import { listConcepts } from "@/lib/concepts";
import { getCourse } from "@/lib/repo";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function ConceptsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId)) notFound();
  const course = await getCourse(user.id, courseId);
  if (!course) notFound();
  const concepts = await listConcepts(user.id, courseId);
  return <ConceptIndex course={{ id: course.id, name: course.name }} concepts={concepts} />;
}
