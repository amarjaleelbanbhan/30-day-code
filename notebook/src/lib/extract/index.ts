import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { extractPptx } from "./pptx";
import { extractText } from "./text";

export type ExtractedPage = { pageNo: number; title: string | null; body: string; speakerNotes: string | null };

export type FileType = "pdf" | "pptx" | "docx" | "txt" | "md" | "png" | "jpg" | "webp" | "gif";

export const MIME: Record<FileType, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export { ACCEPT } from "./accept";

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/** Determines file type from extension AND verifies content signature. Returns null if unsupported/mismatched. */
export function detectType(filename: string, bytes: Uint8Array): FileType | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const zip = starts(bytes, [0x50, 0x4b, 0x03, 0x04]);
  switch (ext) {
    case "pdf": return starts(bytes, [0x25, 0x50, 0x44, 0x46]) ? "pdf" : null;
    case "pptx": return zip ? "pptx" : null;
    case "docx": return zip ? "docx" : null;
    case "png": return starts(bytes, [0x89, 0x50, 0x4e, 0x47]) ? "png" : null;
    case "jpg": case "jpeg": return starts(bytes, [0xff, 0xd8, 0xff]) ? "jpg" : null;
    case "gif": return starts(bytes, [0x47, 0x49, 0x46, 0x38]) ? "gif" : null;
    case "webp": return starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8) ? "webp" : null;
    case "txt": case "md": case "markdown": {
      if (bytes.includes(0)) return null;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
      return ext === "txt" ? "txt" : "md";
    }
    default: return null;
  }
}

export const isImage = (t: FileType) => ["png", "jpg", "webp", "gif"].includes(t);

export async function extract(type: FileType, bytes: Uint8Array): Promise<ExtractedPage[]> {
  switch (type) {
    case "pdf": return extractPdf(bytes);
    case "pptx": return extractPptx(bytes);
    case "docx": return extractDocx(bytes);
    case "txt": case "md": return extractText(new TextDecoder().decode(bytes), type === "md");
    default: return []; // images: stored and viewable; not text-indexed (no OCR yet)
  }
}
