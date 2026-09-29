"use client";
import katex from "katex";
import { Fragment, type ReactNode } from "react";

// Minimal, safe Markdown renderer for AI answers: builds React elements (no raw HTML injection).
// Supports headings, lists, code blocks, bold/italic/code, $math$, and [n] citation markers.

type Props = { text: string; onCite?: (n: number) => void };

function Math({ tex, block }: { tex: string; block?: boolean }) {
  try {
    const html = katex.renderToString(tex, { throwOnError: false, displayMode: !!block, trust: false, strict: "ignore" });
    return <span dangerouslySetInnerHTML={{ __html: html }} />; // KaTeX output with trust:false is safe markup
  } catch {
    return <code>{tex}</code>;
  }
}

function inline(src: string, onCite?: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\$[^$\n]+\$)|(\[(\d{1,3})\])/g;
  let last = 0;
  let k = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push(src.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{inline(t.slice(2, -2), onCite)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[4]) out.push(<Math key={k++} tex={t.slice(1, -1)} />);
    else if (m[5]) {
      const n = Number(m[6]);
      out.push(onCite
        ? <button key={k++} type="button" className="cite" onClick={() => onCite(n)} aria-label={`Source ${n}`}>[{n}]</button>
        : <sup key={k++} className="cite">[{n}]</sup>);
    }
    last = m.index! + t.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export function Markdown({ text, onCite }: Props) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    if (line.trim().startsWith("$$")) {
      const body: string[] = [line.trim().slice(2)];
      while (!body.join("\n").trim().endsWith("$$") && i + 1 < lines.length) body.push(lines[++i]!);
      i++;
      blocks.push(<div key={k++} className="overflow-x-auto"><Math tex={body.join("\n").replace(/\$\$\s*$/, "")} block /></div>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const Tag = (h[1]!.length <= 2 ? "h2" : "h3") as "h2" | "h3";
      blocks.push(<Tag key={k++}>{inline(h[2]!, onCite)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items[items.length - 1] += " " + lines[i++]!.trim();
      }
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={k++}>{items.map((it, j) => <li key={j}>{inline(it, onCite)}</li>)}</L>);
      continue;
    }
    if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) q.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k++} className="border-l-2 border-border pl-3 text-fg-2">{inline(q.join(" "), onCite)}</blockquote>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\s*\$\$)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={k++}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, onCite)}</Fragment>)}</p>);
  }
  return <div className="prose-nb">{blocks}</div>;
}
