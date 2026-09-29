import { extractText, getDocumentProxy } from "unpdf";
import type { ExtractedPage } from "./index";
import { firstLine, tidy } from "./text";

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((raw, i) => {
    const body = tidy(raw);
    return { pageNo: i + 1, title: firstLine(body), body, speakerNotes: null };
  });
}
