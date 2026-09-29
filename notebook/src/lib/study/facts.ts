// Extracts structured, citable facts from course passages — the raw material for deterministic questions,
// rubrics and misconception rules. Everything here is literally stated in the source text.
import { contentStems, isStop, words } from "./text";

export type Passage = { chunkId: string; section: string | null; text: string; contentType: string; sourceKind: string };

export type Fact = {
  id: string;             // chunkId#index
  chunkId: string;
  term: string;           // "Stack"
  desc: string;           // "temporary data storage when invoking functions, such as function parameters, …"
  items: string[];        // list members stated in the description, if any
  kind: "colon" | "is" | "enumeration" | "title";
  /** For enumerations: what the items are ("states", "models"). */
  noun?: string;
  sentence: string;       // the original line
  section: string | null;
};

const TERM = /^[A-Za-z][A-Za-z0-9 ()/',-]{0,48}$/;
const NUMBER_WORD = /^(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+([a-z][\w-]*)$/i;
const BAD_TERM = /^(?:lecture|week|chapter|part|section|slide)\s*\d+|^(drawing|sketch|my notes|example|examples|e\.g|note|notes|problem|solution|goal|goals|benefits?|challenges?|answer|question|step \d+|result|reason|why|how|what|also|see|remember|important|tip|warning|source|figure|table|p\d+)$/i;

function cleanTerm(t: string): string | null {
  const s = t.replace(/\s*\([^)]*\)\s*$/, "").replace(/^(?:an?|the)\s+/i, "").trim();
  const ws = s.split(/\s+/);
  if (!s || ws.length > 5 || !TERM.test(s) || BAD_TERM.test(s) || /\d{2,}/.test(s)) return null;
  if (words(s).every((w) => isStop(w))) return null;
  return s;
}

/** Splits "such as A, B and C" / "A, B, and C" into items (2–8 short noun phrases). */
export function listItems(desc: string): string[] {
  const m = desc.match(/(?:such as|including|includes|include|e\.g\.,?|namely|like|contains?|consists? of|:)\s+(.+)$/i);
  const tail = (m ? m[1]! : desc).replace(/\.$/, "");
  const parts = tail.split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 8) return [];
  if (parts.some((p) => p.split(/\s+/).length > 6)) return [];
  return parts.map((p) => p.replace(/^(?:the|a|an)\s+/i, ""));
}

const sentences = (line: string) => line.split(/(?<=[.;!?])\s+(?=[A-Z])|;\s+/).map((s) => s.trim()).filter(Boolean);

export function extractFacts(p: Passage): Fact[] {
  if (p.contentType === "speaker_notes" || p.contentType === "drawing" || p.sourceKind === "ai_note") return [];
  const out: Fact[] = [];
  const add = (f: Omit<Fact, "id" | "chunkId" | "section">) => {
    if (out.some((x) => x.term.toLowerCase() === f.term.toLowerCase() && x.desc === f.desc)) return;
    out.push({ ...f, id: `${p.chunkId}#${out.length}`, chunkId: p.chunkId, section: p.section });
  };
  const lines = p.text.split("\n").map((l) => l.replace(/^\s*(?:[-•*▪◦]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  for (const line of lines) {
    // "Term: description"
    const c = line.match(/^([^:,]{1,50}):\s+(.{8,})$/);
    if (c) {
      const desc = c[2]!.trim().replace(/\.$/, "");
      const num = c[1]!.trim().match(NUMBER_WORD);
      const sec = p.section ? cleanTerm(p.section) : null;
      if (num && sec) {
        const items = listItems(`: ${desc}`);
        if (items.length >= 2) { add({ term: sec, desc, items, kind: "enumeration", noun: num[1]!.toLowerCase(), sentence: line }); continue; }
      }
      const term = cleanTerm(c[1]!);
      if (term && contentStems(desc).length >= 2) { add({ term, desc, items: listItems(desc), kind: "colon", sentence: line }); continue; }
    }
    for (const s of sentences(line)) {
      // "A term is a/an/the …" and "Term is a …"
      const m = s.match(/^(?:(?:an?|the|each)\s+)?([A-Za-z][A-Za-z0-9 '-]{1,40}?)\s+(?:is|are)\s+(?:(?:simply|basically|also|always)\s+)?((?:an?|the|one|defined as)\s+.{4,})$/i);
      if (m) {
        const term = cleanTerm(m[1]!);
        const desc = m[2]!.trim().replace(/[.;]$/, "");
        if (term && contentStems(desc).length >= 2 && !/^(?:this|that|it|there|which)$/i.test(term))
          add({ term, desc: desc.replace(/^defined as\s+/i, ""), items: listItems(desc), kind: "is", sentence: s });
      }
    }
    // Enumeration line under a titled slide: "New, Ready, Running, Waiting, Terminated: five states",
    // "CPU utilization, throughput, turnaround time, waiting time, response time".
    const e = line.match(/^((?:[\w/-]+(?:\s+[\w/-]+){0,3}\s*,\s*){2,7}(?:and\s+)?[\w/-]+(?:\s+[\w/-]+){0,3})(?:\s*[:—–]\s*(.+))?$/);
    if (e && p.section) {
      const items = e[1]!.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean)
        .map((x, i) => (i === 0 ? x.replace(/^(?:contains?|includes?|consists? of)\s+/i, "") : x));
      const term = cleanTerm(p.section);
      const noun = e[2]?.match(/([a-z][\w-]*)\s*$/i)?.[1]?.toLowerCase();
      if (term && items.length >= 3) add({ term, desc: `${items.join(", ")}${e[2] ? ` (${e[2].trim()})` : ""}`, items, kind: "enumeration", noun, sentence: line });
    }
  }
  // Slide-title fact: "Microkernels" + first bullet "Moves as much functionality as possible from the kernel into user space".
  const title = p.section ? cleanTerm(p.section) : null;
  const first = lines.find((l) => l !== p.section && l.trim() !== title);
  if (title && first && p.contentType !== "note" && !out.some((f) => f.term.toLowerCase() === title.toLowerCase() || f.sentence === first || first.startsWith(f.sentence))
      && !first.includes(":") && first.split(/\s+/).length >= 5 && !/^(?:lecture|operating systems)/i.test(first)) {
    add({ term: title, desc: first.replace(/\.$/, ""), items: [], kind: "title", sentence: first });
  }
  return out;
}

/** Facts about other terms stated in the same passage (e.g. Text/Data/Heap/Stack) — used for distractors and contrasts. */
export function siblingsOf(f: Fact, all: Fact[]): Fact[] {
  const t = f.term.toLowerCase();
  const seen = new Set<string>();
  return all.filter((x) => {
    const k = x.term.toLowerCase();
    if (x.chunkId !== f.chunkId || k === t || x.kind !== f.kind || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Head of a noun phrase (last content word), e.g. "function parameters" → "parameters". */
export function head(phrase: string): string {
  const ws = words(phrase).filter((w) => !isStop(w));
  return ws[ws.length - 1] ?? phrase;
}
