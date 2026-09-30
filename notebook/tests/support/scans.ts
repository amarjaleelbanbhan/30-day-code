// Generates test scans on the fly (no binary fixtures): a PNG of printed text, and an image-only PDF (no text layer).
import { createCanvas } from "@napi-rs/canvas";

export function textImage(lines: string[], type: "image/png" | "image/jpeg" = "image/png") {
  const c = createCanvas(1100, 120 + lines.length * 90);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#000"; g.font = "44px sans-serif";
  lines.forEach((l, i) => g.fillText(l, 40, 90 + i * 90));
  return { bytes: new Uint8Array(type === "image/png" ? c.toBuffer("image/png") : c.toBuffer("image/jpeg", 90)), width: c.width, height: c.height };
}

/** One page per JPEG, each page is only an image — like a scanner produces. */
export function scannedPdf(pages: { bytes: Uint8Array; width: number; height: number }[]): Uint8Array {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => { const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b; parts.push(buf); len += buf.length; };
  const obj = (n: number, body: Buffer | string, stream?: Buffer) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`); push(body);
    if (stream) { push("\nstream\n"); push(stream); push("\nendstream"); }
    push("\nendobj\n");
  };
  push("%PDF-1.4\n");
  const n = pages.length;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`);
  pages.forEach((p, i) => {
    const page = 3 + i * 3, img = page + 1, content = page + 2;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`);
    const jpeg = Buffer.from(p.bytes);
    obj(img, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
    const draw = Buffer.from(`q ${p.width} 0 0 ${p.height} 0 0 cm /Im0 Do Q`, "latin1");
    obj(content, `<< /Length ${draw.length} >>`, draw);
  });
  const xref = len;
  const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
}
