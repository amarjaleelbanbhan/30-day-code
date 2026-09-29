import { notFound } from "next/navigation";
import { StudySession } from "@/components/study/StudySession";
import { requireUser } from "@/lib/auth";
import { getCourse } from "@/lib/repo";
import { getSession } from "@/lib/study/engine";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ courseId: string; sessionId: string }> }) {
  const { courseId, sessionId } = await params;
  const user = await requireUser();
  if (!isUuid(courseId) || !isUuid(sessionId)) notFound();
  const [course, s] = await Promise.all([getCourse(user.id, courseId), getSession(user.id, sessionId)]);
  if (!course || !s || s.course_id !== courseId) notFound();
  return <StudySession course={{ id: course.id, name: course.name }} sessionId={sessionId} />;
}
