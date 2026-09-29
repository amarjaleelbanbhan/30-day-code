import mammoth from "mammoth";
import type { ExtractedPage } from "./index";
import { extractText } from "./text";

/** DOCX → markdown-ish text (headings preserved) → sections. */
export async function extractDocx(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const md = html
    .replace(/<h1[^>]*>/g, "\n# ").replace(/<h2[^>]*>/g, "\n## ").replace(/<h[3-6][^>]*>/g, "\n### ")
    .replace(/<li[^>]*>/g, "\n- ").replace(/<\/(p|h\d|li|tr)>/g, "\n").replace(/<\/t[dh]>/g, " | ")
    .replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return extractText(md, true);
}
