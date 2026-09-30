import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import type { ExtractedPage } from "./index";
import { ocr } from "./ocr";
import { firstLine, tidy } from "./text";

const SCANNED_BELOW_CHARS = 25; // a page with (almost) no text layer is a scan
const MAX_OCR_PAGES = Number(process.env.OCR_MAX_PAGES) || 300;

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  let ocrLeft = MAX_OCR_PAGES;
  const pages: ExtractedPage[] = [];
  for (const [i, raw] of text.entries()) {
    let body = tidy(raw);
    let title = firstLine(body);
    if (body.length < SCANNED_BELOW_CHARS && ocrLeft > 0) {
      ocrLeft--;
      try {
        const png = await renderPageAsImage(pdf, i + 1, { canvasImport: () => import("@napi-rs/canvas"), scale: 2 });
        const found = await ocr(new Uint8Array(png));
        if (found.length > body.length) { body = found; title = null; } // OCR'd first lines are not reliable titles (they would become concepts)
      } catch (e) {
        console.warn(`[ocr] page ${i + 1} failed:`, e instanceof Error ? e.message : e);
      }
    }
    pages.push({ pageNo: i + 1, title, body, speakerNotes: null });
  }
  return pages;
}
