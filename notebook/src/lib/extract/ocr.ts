// Local OCR (Tesseract, English) for image uploads and scanned PDF pages. Runs inside the extract job, never in a request,
// and never leaves the machine. Low-confidence output (photos of handwriting, blur, diagrams) is discarded rather than
// indexed, so garbled text can't become search hits, concepts or study questions.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Worker } from "tesseract.js";
import { tidy } from "./text";

const MIN_CONFIDENCE = Number(process.env.OCR_MIN_CONFIDENCE) || 60;
const MIN_WORDS = 3;

let worker: Promise<Worker> | null = null;

async function init(): Promise<Worker> {
  const { createWorker } = await import("tesseract.js");
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const langPath = process.env.OCR_LANG_PATH || path.dirname(req.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"));
  return createWorker("eng", 1, { langPath, gzip: true, cachePath: os.tmpdir() });
}

/** Text found in an image (PNG/JPEG), or "" when nothing readable was found. */
export async function ocr(image: Uint8Array): Promise<string> {
  const w = await (worker ??= init().catch((e) => { worker = null; throw e; }));
  const { data } = await w.recognize(Buffer.from(image));
  const text = tidy(data.text ?? "");
  const words = text.split(/\s+/).filter((t) => /[A-Za-z]{2,}/.test(t)).length;
  return data.confidence >= MIN_CONFIDENCE && words >= MIN_WORDS ? text : "";
}
