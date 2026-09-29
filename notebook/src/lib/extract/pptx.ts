import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { ExtractedPage } from "./index";
import { tidy } from "./text";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true, isArray: (_n, _p, _l, isAttr) => !isAttr });

type X = Record<string, unknown>;
const arr = (v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : v ? [v as X] : []);
const get = (node: X | undefined, ...path: string[]): X[] => {
  let cur: X[] = node ? [node] : [];
  for (const p of path) cur = cur.flatMap((n) => arr(n[p]));
  return cur;
};

/** Text of one <a:p> paragraph, joining runs and fields. */
function paragraphText(p: X): string {
  const parts: string[] = [];
  for (const kind of ["r", "fld"]) for (const r of get(p, kind)) for (const t of get(r, "t")) parts.push(textOf(t));
  return parts.join("");
}
function textOf(t: X): string {
  if (typeof t === "string" || typeof t === "number") return String(t);
  const v = (t as X)["#text"];
  return v == null ? "" : String(v);
}

/** Paragraphs of a shape tree (shapes, groups, tables), bullet level kept as indentation. */
function shapeTreeText(tree: X | undefined): { title: string | null; lines: string[] } {
  let title: string | null = null;
  const lines: string[] = [];
  const walk = (node: X) => {
    for (const sp of get(node, "sp")) {
      const ph = get(sp, "nvSpPr", "nvPr", "ph")[0];
      const phType = ph ? String(ph["@type"] ?? "") : "";
      const paras = get(sp, "txBody", "p").map((p) => {
        const lvl = Number(get(p, "pPr")[0]?.["@lvl"] ?? 0);
        return { text: paragraphText(p).trim(), lvl };
      }).filter((x) => x.text);
      if ((phType === "title" || phType === "ctrTitle") && !title) {
        title = paras.map((x) => x.text).join(" ");
        continue;
      }
      if (phType === "sldNum" || phType === "dt" || phType === "ftr") continue;
      for (const x of paras) lines.push(`${"  ".repeat(x.lvl)}${x.text}`);
    }
    for (const gf of get(node, "graphicFrame")) {
      for (const tr of get(gf, "graphic", "graphicData", "tbl", "tr")) {
        const cells = get(tr, "tc").map((tc) => get(tc, "txBody", "p").map(paragraphText).join(" ").trim());
        lines.push(`| ${cells.join(" | ")} |`);
      }
    }
    for (const g of get(node, "grpSp")) walk(g);
  };
  if (tree) walk(tree);
  return { title, lines };
}

async function readXml(zip: JSZip, path: string): Promise<X | null> {
  const f = zip.file(path);
  return f ? (parser.parse(await f.async("string")) as X) : null;
}

/** Slide paths in presentation order (via presentation.xml sldIdLst + rels), falling back to numeric order. */
async function slideOrder(zip: JSZip): Promise<string[]> {
  // sldId carries both `id` and `r:id`; read r:id with a regex since NS-stripping would collide them.
  const presXml = (await zip.file("ppt/presentation.xml")?.async("string")) ?? "";
  const rels = await readXml(zip, "ppt/_rels/presentation.xml.rels");
  const relMap = new Map(get(rels ?? undefined, "Relationships", "Relationship").map((r) => [String(r["@Id"]), String(r["@Target"])]));
  const ordered = [...presXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => relMap.get(m[1]!))
    .filter((t): t is string => !!t)
    .map((t) => "ppt/" + t.replace(/^\/?ppt\//, "").replace(/^\.\//, ""));
  if (ordered.length) return ordered;
  return Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
}

async function notesFor(zip: JSZip, slidePath: string): Promise<string | null> {
  const relsPath = slidePath.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels");
  const rels = await readXml(zip, relsPath);
  const target = get(rels ?? undefined, "Relationships", "Relationship").find((r) => String(r["@Type"]).endsWith("/notesSlide"));
  if (!target) return null;
  const path = "ppt/" + String(target["@Target"]).replace(/^\.\.\//, "");
  const xml = await readXml(zip, path);
  if (!xml) return null;
  const tree = get(xml, "notes", "cSld", "spTree")[0];
  // Notes slides contain a slide-image placeholder and slide number; keep only body text.
  const lines: string[] = [];
  for (const sp of get(tree, "sp")) {
    const ph = get(sp, "nvSpPr", "nvPr", "ph")[0];
    if (ph && ph["@type"] !== "body") continue;
    for (const p of get(sp, "txBody", "p")) {
      const t = paragraphText(p).trim();
      if (t) lines.push(t);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

export async function extractPptx(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const zip = await JSZip.loadAsync(bytes);
  const pages: ExtractedPage[] = [];
  const paths = await slideOrder(zip);
  for (const [i, path] of paths.entries()) {
    const xml = await readXml(zip, path);
    if (!xml) continue;
    const { title, lines } = shapeTreeText(get(xml, "sld", "cSld", "spTree")[0]);
    pages.push({ pageNo: i + 1, title, body: tidy(lines.join("\n")), speakerNotes: await notesFor(zip, path) });
  }
  return pages;
}
