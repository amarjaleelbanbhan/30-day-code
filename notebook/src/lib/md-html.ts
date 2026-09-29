// Markdown → HTML for inserting AI output / material excerpts into the editor.
// All text is escaped first; only a fixed set of tags is produced, and Tiptap re-parses against its schema.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\$([^$\n]+)\$/g, (_m, tex: string) => `<span data-type="inline-math" data-latex="${tex}"></span>`);
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = Math.min(3, h[1]!.length + 1); out.push(`<h${n}>${inline(h[2]!)}</h${n}>`); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items.push(`<li><p>${inline(lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</p></li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) q.push(inline(lines[i++]!.replace(/^>\s?/, "")));
      out.push(`<blockquote><p>${q.join("<br>")}</p></blockquote>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(inline(lines[i++]!));
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

export { esc as escapeHtml };
