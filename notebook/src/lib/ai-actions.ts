import "server-only";
// Optional AI actions on a lecture's notes. Results are returned for the student to review/insert;
// they never overwrite notes.
import { getLLM } from "./ai/provider";
import { docToPlainText } from "./chunk";
import { getOrCreateNote, getPages } from "./repo";
import { citationLabel, lectureChunks } from "./search";

export type Action = "structure" | "revision" | "explain" | "summarize_slide" | "missing_points" | "examples" | "flashcards" | "quiz";

const TASKS: Record<Action, string> = {
  structure: "Reorganise the student's notes into a clean, well-structured outline with headings and bullet points. Keep ALL of their content and wording where possible; do not add new facts.",
  revision: "Turn the notes and lecture material into concise revision notes: key definitions, key points, formulas, and a 5-line summary at the end.",
  explain: "Explain the given text clearly for a university student, using the lecture material where it covers the topic.",
  summarize_slide: "Summarise this slide/page in a few bullet points, preserving the teacher's terminology.",
  missing_points: "Compare the student's notes with the lecture material and list the important points from the material that are missing from the notes, grouped by topic, each with its source.",
  examples: "Create 3–5 concrete worked examples that illustrate the main concepts of this lecture.",
  flashcards: "Create 10–20 flashcards as a Markdown list in the form `- **Q:** … — **A:** …`, covering the most important concepts.",
  quiz: "Create a quiz: 5 multiple-choice (options a–d), 3 true/false, 3 short-answer and 1 scenario question. Put an answer key with brief justifications at the end under '## Answers'.",
};

const SYSTEM = `You help a university student with their lecture notebook. Ground everything in the provided lecture material and notes and cite sources as [n] when a numbered source is used. If you must add general knowledge, put it under a heading "Additional explanation (general knowledge)". Output concise Markdown without preamble.`;

export async function runAction(userId: string, lectureId: string, action: Action, opts: { text?: string; materialId?: string; pageNo?: number }) {
  const llm = getLLM();
  if (!llm) return { ok: false as const, error: "No AI model is configured (set LLM_PROVIDER, e.g. ollama, and LLM_MODEL). Search and recall evidence still work." };
  const note = await getOrCreateNote(userId, lectureId);
  if (!note) return null;

  const notes = docToPlainText(note.content as { type: "doc" });
  let material = "";
  if (action === "summarize_slide" && opts.materialId && opts.pageNo) {
    const chunks = (await lectureChunks(userId, [lectureId])).filter((c) => c.material_id === opts.materialId && c.page_no === opts.pageNo);
    if (!chunks.length) {
      // Course-level materials are not lecture chunks; fall back to the page text (ownership checked by caller).
      const page = (await getPages(opts.materialId)).find((p) => p.page_no === opts.pageNo);
      material = page ? `[1] Page ${page.page_no}\n${page.title ?? ""}\n${page.body}` : "";
    } else material = chunks.map((c, i) => `[${i + 1}] ${citationLabel(c)}\n${c.content}`).join("\n\n");
  } else {
    const chunks = (await lectureChunks(userId, [lectureId])).filter((c) => c.source_type === "material");
    const maxChars = Math.max(2000, ((await llm.contextTokens()) - 3000) * 3.2);
    let used = 0;
    material = chunks.map((c, i) => `[${i + 1}] ${citationLabel(c)}\n${c.content}`).filter((b) => (used += b.length) < maxChars).join("\n\n");
  }

  const subject = action === "explain" && opts.text ? `Text to explain:\n${opts.text}` : `Student notes:\n${notes || "(empty)"}`;
  try {
    const out = await llm.complete({
      system: SYSTEM,
      messages: [{ role: "user", content: `Lecture material:\n${material || "(none uploaded)"}\n\n${subject}\n\nTask: ${TASKS[action]}` }],
      maxTokens: 1500,
    });
    return { ok: true as const, markdown: out };
  } catch (e) {
    console.error(e);
    return { ok: false as const, error: "The AI provider could not be reached. Your notes are unchanged." };
  }
}
