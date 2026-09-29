// Finds abbreviation ↔ phrase pairs stated in the course material itself, e.g.
//   "Process Control Block (PCB)", "IPC (inter-process communication)", "PCB is also called task control block".
// Only pairs whose initials actually match are kept, so no alias is invented.

export type Alias = { alias: string; expansion: string };

const SMALL = new Set(["of", "and", "the", "for", "in", "on", "to", "a", "an", "with"]);
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();

function initialsMatch(words: string[], acronym: string): boolean {
  const a = acronym.replace(/(?<=[A-Z])s$/, "").toLowerCase();
  const parts = words.flatMap((w) => w.split("-")).filter(Boolean);
  const all = parts.map((p) => p[0]).join("");
  const noSmall = parts.filter((p) => !SMALL.has(p.toLowerCase())).map((p) => p[0]).join("");
  return all.toLowerCase() === a || noSmall.toLowerCase() === a;
}

/** Shortest trailing run of words (≤ 8) whose initials form the acronym. */
function matchTail(words: string[], acronym: string): string[] | null {
  for (let k = 1; k <= Math.min(8, words.length); k++) {
    const tail = words.slice(words.length - k);
    if (initialsMatch(tail, acronym)) return tail;
  }
  return null;
}

export function extractAliases(text: string): Alias[] {
  const out = new Map<string, Alias>();
  const add = (alias: string, expansion: string) => {
    const a = clean(/^[A-Z]{2,8}s$/.test(alias) ? alias.slice(0, -1) : alias), e = clean(expansion);
    if (a && e && a !== e && a.length <= 40 && e.length <= 80) out.set(`${a}|${e}`, { alias: a, expansion: e });
  };
  // Long form (ABBR)
  for (const m of text.matchAll(/((?:[A-Za-z][\w-]*,?[\s]+){0,7}[A-Za-z][\w-]*)\s*\(\s*([A-Z][A-Za-z]{1,7})\s*\)/g)) {
    const tail = matchTail(m[1]!.trim().replace(/,/g, "").split(/\s+/), m[2]!);
    if (tail) add(m[2]!, tail.join(" "));
  }
  // ABBR (long form)
  for (const m of text.matchAll(/\b([A-Z]{2,8})s?\s*\(\s*([A-Za-z][A-Za-z\s-]{3,80}?)\s*\)/g)) {
    if (initialsMatch(m[2]!.trim().split(/\s+/), m[1]!)) add(m[1]!, m[2]!);
  }
  // "X is also called/known as Y": kept only when one side is a stated abbreviation or both sides are short terms.
  for (const m of text.matchAll(/\b([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*){0,3})\s+(?:is\s+|are\s+)?(?:also\s+)(?:called|known as|referred to as)\s+(?:an?\s+|the\s+)?([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*){0,3})/gi)) {
    const x = m[1]!.split(/\s+/), y = m[2]!.replace(/\s+(?:in|on|by|for|and|or|which|that|because|he|she|it)\b.*$/i, "").split(/\s+/);
    const acr = (ws: string[]) => ws.find((w) => /^[A-Z]{2,8}s?$/.test(w));
    const ax = acr(x), ay = acr(y);
    if (ax && !ay) add(ax, y.join(" "));
    else if (ay && !ax) add(ay, x.filter((w) => !/^(the|a|an)$/i.test(w)).slice(-4).join(" "));
    else if (!ax && !ay && x.length <= 3 && y.length <= 3) add(x.filter((w) => !/^(the|a|an)$/i.test(w)).join(" "), y.join(" "));
  }
  return [...out.values()];
}
