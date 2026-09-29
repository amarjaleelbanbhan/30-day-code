import { notFound } from "next/navigation";
import { Workspace } from "@/components/Workspace";
import { requireUser } from "@/lib/auth";
import { getLecture, getOrCreateNote, listLectures, listMaterials } from "@/lib/repo";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function LecturePage({ params }: { params: Promise<{ courseId: string; lectureId: string }> }) {
  const { courseId, lectureId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId) || !isUuid(lectureId)) notFound();
  const lecture = await getLecture(user.id, lectureId);
  if (!lecture || lecture.course_id !== courseId) notFound();
  const [lectures, materials, note] = await Promise.all([
    listLectures(user.id, courseId),
    listMaterials(user.id, courseId),
    getOrCreateNote(user.id, lectureId),
  ]);
  return (
    <Workspace
      key={lectureId}
      course={{ id: courseId, name: lecture.course_name }}
      lecture={{ id: lecture.id, number: lecture.number, title: lecture.title, date: lecture.lecture_date }}
      lectures={lectures.map((l) => ({ id: l.id, number: l.number, title: l.title }))}
      materials={materials
        .filter((m) => m.lecture_id === lectureId || !m.lecture_id)
        .sort((a, b) => Number(!!b.lecture_id) - Number(!!a.lecture_id))
        .map((m) => ({ id: m.id, filename: m.filename, kind: m.kind, status: m.status, error: m.error, embedStatus: m.embed_status, embedError: m.embed_error, mime: m.mime, lectureId: m.lecture_id, pageCount: m.page_count }))}
      note={{ content: note!.content as { type: "doc" }, updatedAt: note!.updated_at.toISOString() }}
    />
  );
}
