// Small, dependency-free text tools used by deterministic question generation and rubric grading.

const STOP = new Set(
  ("a an the and or but of to in on at by for with from as is are was were be been being it its this that these those " +
   "which who whom what when where why how there their they them he she we you i my our your so such than then also " +
   "can could should would will may might must do does did done has have had having not no into onto over under up " +
   "out about via per each every some any all both either etc e g eg ie i.e e.g one two three four five six " +
   "called known used using use uses way ways thing things kind kinds type types part parts").split(/\s+/),
);

export const isStop = (w: string) => STOP.has(w);

export const words = (s: string): string[] =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? [];

/** Light suffix-stripping stemmer (enough to equate execute/executing/execution, stores/stored, variables/variable). */
export function stem(w0: string): string {
  let w = w0.toLowerCase();
  if (w.length <= 3) return w;
  // "executable" must not collapse onto "execution" (an executable file is not something that is executing).
  if (/(able|ible)s?$/.test(w) && w.length > 6) return w.replace(/s$/, "").slice(0, -1);
  if (w.endsWith("ally") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ions")) w = w.slice(0, -4);
  else if (w.endsWith("ion") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && /([bdgmnprt])\1$/.test(w)) w = w.slice(0, -1); // running → runn → run
  return w;
}

export const contentStems = (s: string): string[] => words(s).filter((w) => !isStop(w) && w.length > 1).map(stem);

// General (not course-specific) English equivalences. Strong = same meaning; weak = related but not sufficient alone.
const GROUPS: { strong: string[]; weak?: string[] }[] = [
  { strong: ["execute", "execution", "executing", "run", "running", "runs", "active", "live", "alive"], weak: ["start", "started", "launched", "loaded", "working"] },
  { strong: ["store", "stores", "stored", "storage", "hold", "holds", "keep", "keeps", "contain", "contains", "save", "saved", "put"] },
  { strong: ["temporary", "temp", "short-lived", "transient"] },
  { strong: ["allocate", "allocated", "allocation", "reserve", "reserved", "assign", "assigned", "request", "requested", "malloc"] },
  { strong: ["dynamic", "dynamically", "runtime", "on-demand"] },
  { strong: ["function", "functions", "procedure", "subroutine", "method", "routine"], weak: ["call", "calls"] },
  { strong: ["invoke", "invoking", "invocation", "call", "calling", "called"] },
  { strong: ["parameter", "parameters", "argument", "arguments", "args", "param", "params"] },
  { strong: ["program", "programs", "application", "app", "executable", "software"] },
  { strong: ["instance", "copy", "occurrence"] },
  { strong: ["address", "addresses", "location", "pointer"] },
  { strong: ["variable", "variables", "var", "vars"] },
  { strong: ["global", "globals"] },
  { strong: ["share", "shares", "shared", "sharing", "common"] },
  { strong: ["select", "selects", "choose", "chooses", "pick", "picks", "decide"] },
  { strong: ["wait", "waiting", "blocked", "block", "blocking"] },
  { strong: ["disk", "disc", "secondary"] },
  { strong: ["passive", "inactive", "static"] },
  { strong: ["message", "messages", "messaging"] },
  { strong: ["cpu", "processor", "core"] },
  { strong: ["memory", "ram"] },
  { strong: ["fast", "faster", "quick", "quicker", "efficient", "performance"] },
  { strong: ["slow", "slower", "overhead", "costly"] },
  { strong: ["reliable", "reliability", "robust", "stable", "secure", "security"] },
  { strong: ["extend", "extensible", "extensibility", "modular", "flexible"] },
  { strong: ["shortest", "smallest", "minimum", "min", "least"] },
  { strong: ["priority", "importance", "precedence"] },
  { strong: ["wasted", "waste", "useless"] },
];

const strongMap = new Map<string, number>();
const weakMap = new Map<string, number>();
GROUPS.forEach((g, i) => {
  for (const w of g.strong) strongMap.set(stem(w), i);
  for (const w of g.weak ?? []) if (!strongMap.has(stem(w))) weakMap.set(stem(w), i);
});

/** 1 = same meaning, 0.5 = related (weak), 0 = unrelated. */
export function stemMatch(target: string, candidate: string): number {
  if (target === candidate) return 1;
  if (Math.abs(target.length - candidate.length) === 1 && target.length >= 5 && (target.startsWith(candidate) || candidate.startsWith(target))) return 1;
  const g = strongMap.get(target);
  if (g !== undefined && (strongMap.get(candidate) === g)) return 1;
  if (g !== undefined && weakMap.get(candidate) === g) return 0.5;
  return 0;
}

export type Tok = { stem: string; stop: boolean; negated: boolean };
export type AnswerIndex = { toks: Tok[]; stems: string[]; negated: Set<number> };

const NEG = new Set(["not", "no", "never", "isnt", "arent", "doesnt", "dont", "cannot", "cant", "neither", "nor", "without", "unlike", "instead"]);

/** Tokenizes an answer keeping word order; negation applies to the next few words within the same clause. */
export function indexAnswer(text: string): AnswerIndex {
  const toks: Tok[] = [];
  for (const clause of text.split(/[,.;:!?()]|\s-\s|\bbut\b|\bwhereas\b|\bwhile\b/i)) {
    let negLeft = 0;
    for (const w of words(clause)) {
      if (NEG.has(w)) { negLeft = 4; continue; }
      toks.push({ stem: stem(w), stop: isStop(w), negated: negLeft > 0 });
      if (negLeft > 0) negLeft--;
    }
    toks.push({ stem: "", stop: true, negated: false }); // clause boundary
  }
  const content = toks.filter((t) => !t.stop && t.stem);
  return { toks, stems: content.map((t) => t.stem), negated: new Set(content.flatMap((t, i) => (t.negated ? [i] : []))) };
}

/** Best match (0/0.5/1) for `target` among the answer's words, ignoring negated ones. */
export function bestMatch(target: string, answer: AnswerIndex): number {
  let best = 0;
  for (const [i, s] of answer.stems.entries()) {
    if (answer.negated.has(i)) continue;
    best = Math.max(best, stemMatch(target, s));
    if (best === 1) break;
  }
  return best;
}

/**
 * Match for a head noun that must not carry a *different* modifier: "global variables" does not satisfy
 * "local variables", but "parameters" satisfies "function parameters".
 */
export function headMatch(target: string, modifiers: string[], answer: AnswerIndex): number {
  let best = 0;
  for (const [i, t] of answer.toks.entries()) {
    if (t.stop || t.negated || !t.stem) continue;
    const m = stemMatch(target, t.stem);
    if (!m) continue;
    const prev = answer.toks[i - 1];
    const conflicting = prev && !prev.stop && prev.stem && modifiers.length > 0 && !modifiers.some((k) => stemMatch(k, prev.stem) > 0);
    if (!conflicting) best = Math.max(best, m);
    if (best === 1) break;
  }
  return best;
}

/** Deterministic pseudo-random (seeded) for reproducible option order and template choice. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const article = (s: string) => (/^[aeiou]/i.test(s) && !/^(uni|use|one)/i.test(s) ? "an" : "a");
