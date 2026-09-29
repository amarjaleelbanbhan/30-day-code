import { notFound } from "next/navigation";
import { DebugView } from "@/components/DebugView";
import { requireUser } from "@/lib/auth";
import { debugEnabled } from "@/lib/debug";
import { getCourse } from "@/lib/repo";
import { isUuid } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function DebugPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  if (!debugEnabled() || !isUuid(courseId)) notFound();
  const user = await requireUser();
  const course = await getCourse(user.id, courseId);
  if (!course) notFound();
  return <DebugView course={{ id: course.id, name: course.name }} />;
}
