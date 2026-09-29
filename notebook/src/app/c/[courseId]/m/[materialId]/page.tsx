import { notFound } from "next/navigation";
import { MaterialPage } from "@/components/MaterialPage";
import { requireUser } from "@/lib/auth";
import { getCourse, getMaterial } from "@/lib/repo";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ courseId: string; materialId: string }> }) {
  const { courseId, materialId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId) || !isUuid(materialId)) notFound();
  const [course, m] = await Promise.all([getCourse(user.id, courseId), getMaterial(user.id, materialId)]);
  if (!course || !m || m.course_id !== courseId) notFound();
  return (
    <MaterialPage course={{ id: course.id, name: course.name }}
      material={{ id: m.id, filename: m.filename, kind: m.kind, status: m.status, error: m.error, embedStatus: m.embed_status, embedError: m.embed_error, mime: m.mime, lectureId: m.lecture_id, pageCount: m.page_count }} />
  );
}
