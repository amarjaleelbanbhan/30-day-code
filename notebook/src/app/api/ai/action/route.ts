import { body, notFound, route } from "@/lib/api";
import { runAction } from "@/lib/ai-actions";
import { getMaterial } from "@/lib/repo";
import { aiActionSchema } from "@/lib/validation";

export const maxDuration = 180;
export const POST = route(async (req, user) => {
  const input = aiActionSchema.parse(await body(req));
  if (input.materialId && !(await getMaterial(user.id, input.materialId))) throw notFound();
  const out = await runAction(user.id, input.lectureId, input.action, input);
  if (!out) throw notFound();
  return out;
});
