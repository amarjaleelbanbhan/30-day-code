import { notFound } from "next/navigation";
import { CourseView } from "@/components/CourseView";
import { requireUser } from "@/lib/auth";
import { getCourse, listLectures, listMaterials } from "@/lib/repo";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId)) notFound();
  const course = await getCourse(user.id, courseId);
  if (!course) notFound();
  const [lectures, materials] = await Promise.all([listLectures(user.id, courseId), listMaterials(user.id, courseId)]);
  return (
    <CourseView
      course={{ id: course.id, name: course.name, code: course.code, instructor: course.instructor, semester: course.semester }}
      lectures={lectures.map((l) => ({ id: l.id, number: l.number, title: l.title, date: l.lecture_date, materials: l.materials, lastEdited: l.last_edited.toISOString() }))}
      courseMaterials={materials.filter((m) => !m.lecture_id).map((m) => ({ id: m.id, filename: m.filename, kind: m.kind, status: m.status, error: m.error, embedStatus: m.embed_status, embedError: m.embed_error }))}
    />
  );
}
