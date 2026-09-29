import type { ExtractedPage } from "./index";

export const tidy = (s: string) =>
  // Collapse inner whitespace but keep leading indentation (bullet levels).
  s.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/(\S)[ \t]+/g, "$1 ").replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").replace(/^\s*\n/, "").trimEnd();

export function firstLine(s: string): string | null {
  const line = s.split("\n").find((l) => l.trim().length > 0)?.trim();
  return line ? line.slice(0, 160) : null;
}

/** Plain text → one page. Markdown → one "page" per top-level (#/##) section so citations stay precise. */
export function extractText(src: string, markdown: boolean): ExtractedPage[] {
  const text = tidy(src);
  if (!text) return [];
  if (!markdown) return [{ pageNo: 1, title: firstLine(text), body: text, speakerNotes: null }];
  const sections: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && /^#{1,2}\s/.test(line) && cur.some((l) => l.trim())) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim())) sections.push(cur.join("\n"));
  return sections.map((s, i) => ({
    pageNo: i + 1,
    title: firstLine(s)?.replace(/^#+\s*/, "") ?? null,
    body: s.trim(),
    speakerNotes: null,
  }));
}
