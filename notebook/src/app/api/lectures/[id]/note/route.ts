import { after } from "next/server";
import { body, notFound, route } from "@/lib/api";
import { docToPlainText } from "@/lib/chunk";
import { indexNote } from "@/lib/ingest";
import { getOrCreateNote, saveNote } from "@/lib/repo";
import { noteSaveSchema } from "@/lib/validation";

type P = { id: string };
export const GET = route<P>(async (_req, user, { id }) => {
  const note = await getOrCreateNote(user.id, id);
  if (!note) throw notFound();
  return { note };
});
export const PUT = route<P>(async (req, user, { id }) => {
  const input = noteSaveSchema.parse(await body(req));
  if (JSON.stringify(input.content).length > 5_000_000) return Response.json({ error: "Note too large" }, { status: 413 });
  const reason = req.nextUrl.searchParams.get("reason") === "ai" ? "ai" : "autosave";
  // Plain text is derived server-side from the document, never trusted from the client.
  const saved = await saveNote(user.id, id, input.content, docToPlainText(input.content), reason);
  if (!saved) throw notFound();
  after(() => indexNote(saved.noteId));
  return { version: saved.version, updatedAt: saved.updated_at };
});
