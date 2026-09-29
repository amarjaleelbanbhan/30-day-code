import { notFound, route } from "@/lib/api";
import { getMaterial } from "@/lib/repo";
import * as storage from "@/lib/storage";

const INLINE = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);

export const GET = route<{ id: string }>(async (_req, user, { id }) => {
  const m = await getMaterial(user.id, id);
  if (!m) throw notFound();
  const bytes = await storage.get(m.storage_key);
  const disp = INLINE.has(m.mime) ? "inline" : "attachment";
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": m.mime,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${disp}; filename*=UTF-8''${encodeURIComponent(m.filename)}`,
      "x-content-type-options": "nosniff",
      // Browsers' built-in PDF viewers don't run in sandboxed documents; everything else is fully sandboxed.
      ...(m.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "cache-control": "private, max-age=3600",
    },
  });
});
