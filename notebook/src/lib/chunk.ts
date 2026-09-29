// Splits content into retrieval chunks, keeping section/page metadata for citations.

export const CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 150;

/** Splits text on paragraph/line boundaries into ~CHUNK_CHARS pieces with a small overlap. */
export function splitText(text: string, max = CHUNK_CHARS): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const units = t.split(/\n{2,}|\n(?=[-*•\d])/).flatMap((u) => (u.length > max ? u.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\s|$)|[\\s\\S]{1,${max}}`, "g")) ?? [] : [u]));
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > max) {
      out.push(cur.trim());
      cur = cur.slice(-OVERLAP_CHARS).replace(/^\S*\s/, "") + "\n";
    }
    cur += (cur && !cur.endsWith("\n") ? "\n\n" : "") + u;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---- Tiptap document → sections ----
type PMNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: PMNode[] };

function inlineText(n: PMNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "inlineMath" || n.type === "blockMath") return `$${String(n.attrs?.latex ?? "")}$`;
  if (n.type === "hardBreak") return "\n";
  if (n.type === "sketch") return String(n.attrs?.caption ?? "") ? `[Drawing: ${String(n.attrs?.caption)}]` : "[Drawing]";
  return (n.content ?? []).map(inlineText).join(n.type === "tableRow" ? " | " : "");
}

function blockText(n: PMNode, depth = 0): string {
  switch (n.type) {
    case "bulletList": case "orderedList": case "taskList":
      return (n.content ?? []).map((li, i) => {
        const mark = n.type === "orderedList" ? `${i + 1}.` : n.type === "taskList" ? (li.attrs?.checked ? "[x]" : "[ ]") : "-";
        const [first, ...rest] = li.content ?? [];
        return `${"  ".repeat(depth)}${mark} ${first ? inlineText(first) : ""}${rest.map((r) => "\n" + blockText(r, depth + 1)).join("")}`;
      }).join("\n");
    case "codeBlock": return "```\n" + inlineText(n) + "\n```";
    case "blockquote": case "callout": return (n.content ?? []).map((c) => "> " + blockText(c)).join("\n");
    case "table": return (n.content ?? []).map((r) => "| " + (r.content ?? []).map(inlineText).join(" | ") + " |").join("\n");
    default: return inlineText(n);
  }
}

export type NoteSection = { section: string | null; text: string };

/** Groups a Tiptap doc into sections by heading. Used for note indexing and plain-text export. */
export function noteSections(doc: PMNode): NoteSection[] {
  const out: NoteSection[] = [];
  let cur: NoteSection = { section: null, text: "" };
  for (const n of doc.content ?? []) {
    if (n.type === "heading") {
      if (cur.text.trim()) out.push(cur);
      cur = { section: inlineText(n).trim() || null, text: "" };
      continue;
    }
    const t = blockText(n);
    if (t.trim()) cur.text += (cur.text ? "\n" : "") + t;
  }
  if (cur.text.trim() || cur.section) out.push(cur);
  return out.map((s) => ({ ...s, text: s.text.trim() }));
}

export const docToPlainText = (doc: PMNode) =>
  noteSections(doc).map((s) => (s.section ? `# ${s.section}\n` : "") + s.text).join("\n\n").trim();

// ---- Note → typed index pieces ----
export type NotePiece = {
  section: string | null;
  text: string;
  contentType: "note" | "drawing" | "ai_note";
  sourceKind: "student_notes" | "ai_note";
  /** Verbatim text from the block, used to find and highlight it when a citation is opened. */
  anchor: string;
};

const isAiCallout = (n: PMNode) => n.type === "callout" && /^AI ·/.test(inlineText(n.content?.[0] ?? {}).trim());

/**
 * Splits a note into index pieces: student-written text (grouped by heading), drawings (by caption) and
 * AI-inserted callouts (kept apart so they rank below the student's own notes and course material).
 */
export function notePieces(doc: PMNode): NotePiece[] {
  const out: NotePiece[] = [];
  let section: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    for (const t of splitText(text)) out.push({ section, text: t, contentType: "note", sourceKind: "student_notes", anchor: firstWords(t) });
  };
  for (const n of doc.content ?? []) {
    if (n.type === "heading") {
      flush();
      section = inlineText(n).trim() || null;
      continue;
    }
    if (n.type === "sketch") {
      const caption = String(n.attrs?.caption ?? "").trim();
      if (caption) {
        flush();
        out.push({ section, text: `Drawing: ${caption}`, contentType: "drawing", sourceKind: "student_notes", anchor: caption });
      }
      continue;
    }
    if (isAiCallout(n)) {
      flush();
      const text = (n.content ?? []).map((c) => blockText(c)).join("\n").trim();
      for (const t of splitText(text)) out.push({ section, text: t, contentType: "ai_note", sourceKind: "ai_note", anchor: firstWords(t.replace(/^AI ·[^\n]*\n?/, "")) });
      continue;
    }
    const t = blockText(n);
    if (t.trim()) buf.push(t);
  }
  flush();
  return out;
}

/** First ~8 words of the text with list/quote markers removed — enough to locate a block uniquely in most notes. */
function firstWords(t: string): string {
  const line = t.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.|>|\[[ x]\])\s*/, "").trim()).find((l) => l.length > 0) ?? "";
  return line.split(/\s+/).slice(0, 8).join(" ").slice(0, 120);
}
