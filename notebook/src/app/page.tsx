import { Home } from "@/components/Home";
import { requireUser } from "@/lib/auth";
import { listCourses } from "@/lib/repo";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireUser();
  const courses = await listCourses(user.id);
  return (
    <Home
      email={user.email}
      courses={courses.map((c) => ({ id: c.id, name: c.name, code: c.code, semester: c.semester, instructor: c.instructor, lectureCount: c.lecture_count }))}
    />
  );
}
