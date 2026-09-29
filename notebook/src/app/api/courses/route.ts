import { body, route } from "@/lib/api";
import { createCourse, listCourses } from "@/lib/repo";
import { courseSchema } from "@/lib/validation";

export const GET = route(async (_req, user) => ({ courses: await listCourses(user.id) }));
export const POST = route(async (req, user) => ({ course: await createCourse(user.id, courseSchema.parse(await body(req))) }));
