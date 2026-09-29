import { notFound } from "next/navigation";
import { StudyHub } from "@/components/study/StudyHub";
import { requireUser } from "@/lib/auth";
import { getCourse, listLectures } from "@/lib/repo";
import { overview } from "@/lib/study/engine";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function StudyPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId)) notFound();
  const course = await getCourse(user.id, courseId);
  if (!course) notFound();
  const [o, lectures] = await Promise.all([overview(user.id, courseId), listLectures(user.id, courseId)]);
  return (
    <StudyHub course={{ id: course.id, name: course.name }} overview={JSON.parse(JSON.stringify(o))}
      lectures={lectures.map((l) => ({ id: l.id, number: l.number, title: l.title }))} />
  );
}
