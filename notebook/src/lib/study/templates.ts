// Deterministic, source-grounded question generation (works with no language model).
// Every prompt, answer, rubric point and misconception rule is derived from facts literally stated in the material.
import { head, siblingsOf, type Fact } from "./facts";
import { article, cap, contentStems, seeded, stem, words } from "./text";
import type { Level, MisconceptionRule, Option, QType, QuestionDraft, RubricPoint } from "./types";

const PREP = new Set(["in", "that", "which", "who", "of", "for", "with", "when", "during", "from", "between", "by", "to", "into", "on", "where", "while", "used"]);
const GENERIC = new Set(["much", "possible", "many", "most", "more", "small", "large", "set", "number", "given", "certain", "usually", "typically", "each", "one", "other", "another", "entire", "way"].map(stem));

const keyStems = (s: string) => contentStems(s).filter((w) => !GENERIC.has(w));
/** "Process State" → "process state" (acronyms such as CPU/PCB keep their case). */
const lc = (s: string) => s.replace(/\b[A-Z][a-z][\w-]*/g, (w) => w.toLowerCase());
const strip = (s: string) => s.replace(/^(?:an?|the)\s+/i, "");
const idOf = (s: string) => stem(words(s).join("-")).slice(0, 40) || "p";

function point(text: string, opts: { essential: boolean; weight: number; headLast?: boolean; alt?: string[][] }): RubricPoint {
  const ks = keyStems(text);
  const h = opts.headLast ? ks[ks.length - 1] : ks[0];
  const main = h ? [h, ...ks.filter((k) => k !== h)] : ks;
  return { id: idOf(text), text: strip(text), alternatives: [main, ...(opts.alt ?? [])].filter((a) => a.length), weight: opts.weight, essential: opts.essential };
}

/** "a program in execution" → genus "program" + differentia "in execution". */
export function splitDefinition(desc: string): { genus: string; differentia: string } {
  const ws = strip(desc).split(/\s+/);
  const i = ws.findIndex((w, k) => k > 0 && PREP.has(w.toLowerCase()));
  if (i <= 0) return { genus: ws.join(" "), differentia: "" };
  return { genus: ws.slice(0, i).join(" "), differentia: ws.slice(i).join(" ") };
}

/** Rubric for "what is <term>": list items, or genus + differentia (the differentia is what's essential). */
export function rubricFor(f: Fact): RubricPoint[] {
  if (f.items.length >= 2) return f.items.map((it) => point(it, { essential: false, weight: 1, headLast: true }));
  if (f.kind === "title") {
    const ks = keyStems(f.desc);
    return [{ id: "idea", text: f.desc, alternatives: [ks], weight: 1, essential: true }];
  }
  const { genus, differentia } = splitDefinition(f.desc);
  if (!differentia || keyStems(differentia).length === 0) return [point(genus, { essential: true, weight: 1, headLast: true })];
  return [point(genus, { essential: false, weight: 0.35, headLast: true }), point(differentia, { essential: true, weight: 0.65 })];
}

const termAlternatives = (term: string, aliases: string[]): string[][] =>
  [term, ...aliases].map((t) => { const ks = keyStems(t); return ks.length ? [ks[ks.length - 1]!, ...ks.slice(0, -1)] : []; }).filter((a) => a.length);

/** Other facts stating the same term (e.g. "a process is an active entity"). */
const sameTermFacts = (f: Fact, all: Fact[]) => all.filter((x) => x !== f && x.term.toLowerCase() === f.term.toLowerCase() && x.kind !== "title");

/** Misconception rules from what the same passage says about *other* terms. */
export function contrastRules(f: Fact, sibs: Fact[], promptText: string, sameTerm: Fact[] = []): MisconceptionRule[] {
  const mine = new Set([...keyStems(f.desc), ...keyStems(f.term), ...keyStems(promptText), ...sameTerm.flatMap((x) => keyStems(x.desc))]);
  const rules: MisconceptionRule[] = [];
  for (const s of sibs) {
    const all = new Set(sibs.filter((x) => x !== s).flatMap((x) => keyStems(x.desc)));
    const distinct = keyStems(s.desc).filter((k) => !mine.has(k));
    if (!distinct.length) continue;
    const unique = distinct.filter((k) => !all.has(k) && k.length >= 4);
    const cues: string[][] = [...new Set(unique)].slice(0, 4).map((k) => [k]);
    for (let i = 0; i < distinct.length - 1 && cues.length < 8; i++) cues.push([distinct[i]!, distinct[i + 1]!]);
    rules.push({
      id: `contrast-${idOf(s.term)}`,
      claim: `Describes ${lc(f.term)} using what the course says about ${lc(s.term)}`,
      cues,
      correction: `${cap(strip(s.term))} is ${s.desc}; ${lc(strip(f.term))} is ${f.desc}.`,
    });
    // Attributing one of this term's parts to a sibling term ("return addresses are kept in the heap").
    const sHead = keyStems(s.term);
    if (sHead.length) for (const it of f.items) {
      const h = stem(head(it));
      rules.push({ id: `misplaced-${idOf(it)}-${idOf(s.term)}`, claim: `Puts ${it} in ${lc(strip(s.term))}`, cues: [[sHead[sHead.length - 1]!, h]], correction: `${cap(it)} belong to ${lc(strip(f.term))}, not ${lc(strip(s.term))}.`, pointId: idOf(it) });
    }
  }
  return rules;
}

// A few general rewordings so indirect questions don't simply quote the slide.
const REWORD: [RegExp, string][] = [
  [/\bin execution\b/gi, "that is currently running"], [/\bstored on disk\b/gi, "kept on disk"], [/\bdynamically allocated\b/gi, "allocated on demand"],
  [/\binvoking functions\b/gi, "calling functions"], [/\bwhen invoking\b/gi, "when calling"], [/\bexecutable code\b/gi, "machine instructions"],
  [/\bprovides?\b/gi, "offers"], [/\bselects\b/gi, "chooses"], [/\ballocates\b/gi, "hands"], [/\bmoves\b/gi, "shifts"], [/\bas much functionality as possible\b/gi, "as many services as it can"],
  [/\bgives control of\b/gi, "hands over"], [/\bbasic unit of\b/gi, "smallest schedulable unit of"],
];
export const reword = (s: string) => REWORD.reduce((acc, [re, to]) => acc.replace(re, to), s);

/** Blanks every word whose stem is in `stems` (used for hints that point at, but don't give, the answer). */
export const maskStems = (text: string, stems: string[]) =>
  text.replace(/[A-Za-z][A-Za-z-]*/g, (w) => (stems.includes(stem(w)) ? "_____" : w));

const maskTerm = (text: string, term: string, aliases: string[]) =>
  [term, strip(term), ...aliases].filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((acc, t) => acc.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "gi"), "_____"), text);

export type TemplateContext = {
  fact: Fact;
  facts: Fact[];                // all facts in the evidence set (for siblings)
  conceptName: string;
  aliases: string[];
  where: string;                // "Lecture 05 · Process in Memory"
  diagramHint: boolean;         // the material talks about drawing/diagrams for this topic
  seed: string;
};

type Tpl = { qtype: QType; level: Level; difficulty: 1 | 2 | 3; tag?: string; build: (c: TemplateContext) => Omit<QuestionDraft, "conceptName" | "evidenceChunkIds" | "generator" | "qtype" | "level" | "difficulty"> | null };

function hintsFor(c: TemplateContext, rubric: RubricPoint[], answerMasked: string): string[] {
  return [
    `Think about what the course covers in ${c.where}.`,
    rubric.length > 1 ? `A complete answer covers ${rubric.length} points${rubric.some((p) => p.essential) ? ` — the most important is about “${rubric.find((p) => p.essential)!.text.split(/\s+/).slice(0, 2).join(" ")}…”` : ""}.` : `The key idea starts with “${rubric[0]?.text.split(/\s+/)[0] ?? "…"}…”.`,
    `From the course: “${answerMasked}”`,
  ];
}

const TEMPLATES: Tpl[] = [
  { qtype: "definition", level: "understand", difficulty: 2, build: (c) => {
    if (c.fact.kind === "enumeration" || c.fact.items.length >= 2) return null;
    const f = c.fact;
    const prompt = c.fact.kind === "title" ? `In your own words: what is the key idea of ${lc(strip(f.term))}?` : `In your own words, what is ${article(strip(f.term))} ${lc(strip(f.term))}?`;
    const same = sameTermFacts(f, c.facts);
    const rubric = rubricFor(f).map((p) => (p.essential ? { ...p, alternatives: [...p.alternatives, ...same.map((x) => keyStems(x.desc)).filter((a) => a.length)] } : p));
    return { prompt, options: null, answer: `${cap(strip(f.term))}: ${f.desc}.${same.length ? ` (Also: ${same.map((x) => x.desc).join("; ")}.)` : ""}`, rubric,
      misconceptions: contrastRules(f, siblingsOf(f, c.facts), prompt, same),
      hints: hintsFor(c, rubric, maskStems(maskTerm(f.sentence, f.term, c.aliases), keyStems(rubric.find((p) => p.essential)?.text ?? ""))),
      explanation: `The course states: “${f.sentence}”` };
  } },
  { qtype: "list", level: "understand", difficulty: 2, build: (c) => {
    const f = c.fact;
    if (f.items.length < 2) return null;
    const n = f.items.length;
    const prompt = f.kind === "enumeration"
      ? `Name the ${n} ${f.noun ?? "items"} listed under ${lc(strip(f.term))}.`
      : `${cap(strip(f.term))} — ${f.desc.split(/,?\s+(?:such as|including)\b/i)[0]}. Which ${n} things does it include?`;
    const rubric = rubricFor(f);
    return { prompt, options: null, answer: f.items.join(", ") + ".", rubric, misconceptions: contrastRules(f, siblingsOf(f, c.facts), prompt),
      hints: hintsFor(c, rubric, f.items.map((it, i) => (i === 0 ? it : "_____")).join(", ")), explanation: `The course lists: “${f.sentence}”` };
  } },
  { qtype: "indirect", level: "apply", difficulty: 2, build: (c) => {
    const f = c.fact;
    if (f.kind === "enumeration") return null;
    const described = reword(maskTerm(f.desc, f.term, c.aliases));
    if (described.includes("_____") && described.replace(/_____/g, "").trim().length < 12) return null;
    const prompt = f.kind === "title"
      ? `Which idea from the course does this describe?\n“${reword(maskTerm(f.desc, f.term, c.aliases)).replace(/_____/g, "it")}”`
      : `Something is ${described.replace(/_____/g, "it")}. What does the course call it?`;
    const rubric: RubricPoint[] = [{ id: "term", text: strip(f.term), alternatives: termAlternatives(f.term, c.aliases), weight: 1, essential: true }];
    const sibs = siblingsOf(f, c.facts);
    return { prompt, options: null, answer: `${cap(strip(f.term))}.`, rubric,
      // `unless`: naming the right term while echoing the prompt ("a process is a program that runs") is not confusion.
      misconceptions: sibs.map((s) => ({ id: `wrong-term-${idOf(s.term)}`, unless: "term", claim: `Named ${lc(strip(s.term))} instead of ${lc(strip(f.term))}`, cues: termAlternatives(s.term, []), correction: `${cap(strip(s.term))} is ${s.desc} — the description fits ${lc(strip(f.term))}.` })),
      hints: [`It is covered in ${c.where}.`, `It starts with “${strip(f.term).charAt(0).toUpperCase()}”.`, `The course says: “${maskTerm(f.sentence, f.term, c.aliases)}”`],
      explanation: `The course states: “${f.sentence}”` };
  } },
  { qtype: "mcq", level: "remember", difficulty: 1, build: (c) => {
    const f = c.fact;
    const sibs = siblingsOf(f, c.facts).slice(0, 3);
    if (sibs.length < 2 || f.kind === "enumeration") return null;
    const rnd = seeded(c.seed + "mcq");
    const opts: Option[] = [{ key: "", text: strip(f.term), correct: true, why: `${cap(strip(f.term))}: ${f.desc}.` },
      ...sibs.map((s) => ({ key: "", text: strip(s.term), correct: false, why: `${cap(strip(s.term))} is ${s.desc}.` }))]
      .map((o) => ({ o, r: rnd() })).sort((a, b) => a.r - b.r).map(({ o }, i) => ({ ...o, key: "ABCD"[i]! }));
    return { prompt: `Which one matches this description from the course?\n“${reword(maskTerm(f.desc, f.term, c.aliases))}”`, options: opts,
      answer: `${opts.find((o) => o.correct)!.key}. ${strip(f.term)}`, rubric: [{ id: "choice", text: strip(f.term), alternatives: [], weight: 1, essential: true }],
      misconceptions: [], hints: [`Covered in ${c.where}.`, `Eliminate the options whose role you can state from memory.`, `The course says: “${maskTerm(f.sentence, f.term, c.aliases)}”`],
      explanation: `The course states: “${f.sentence}”` };
  } },
  { qtype: "tf", level: "remember", difficulty: 1, tag: "tf-true", build: (c) => {
    const f = c.fact;
    if (f.kind === "enumeration" || f.kind === "title") return null;
    return { prompt: `True or false: ${cap(strip(f.term))} is ${f.desc}.`, options: tfOptions(true, `${cap(strip(f.term))} is ${f.desc}.`, ""),
      answer: "True", rubric: [{ id: "choice", text: "True", alternatives: [], weight: 1, essential: true }], misconceptions: [],
      hints: [`Covered in ${c.where}.`, `Check every word of the statement against what you remember.`, `Recall the course definition of ${lc(strip(f.term))}.`],
      explanation: `True — the course states: “${f.sentence}”` };
  } },
  { qtype: "tf", level: "understand", difficulty: 2, tag: "tf-contrast", build: (c) => {
    // Fair trick: attach a sibling's description to this term (tests discrimination, not wording).
    const f = c.fact;
    const s = siblingsOf(f, c.facts)[0];
    if (!s || f.kind === "enumeration" || f.kind === "title") return null;
    const why = `That describes ${lc(strip(s.term))}. ${cap(strip(f.term))} is ${f.desc}.`;
    return { prompt: `True or false: ${cap(strip(f.term))} is ${s.desc}.`, options: tfOptions(false, why, `Confuses ${lc(strip(f.term))} with ${lc(strip(s.term))}`),
      answer: "False", rubric: [{ id: "choice", text: "False", alternatives: [], weight: 1, essential: true }], misconceptions: [],
      hints: [`Covered in ${c.where}.`, `The description belongs to one of ${lc(strip(f.term))}'s neighbours in the same slide.`, `Recall what distinguishes ${lc(strip(f.term))} from ${lc(strip(s.term))}.`],
      explanation: `False — ${why}` };
  } },
  { qtype: "fill", level: "remember", difficulty: 1, build: (c) => {
    const f = c.fact;
    if (f.kind === "enumeration") return null;
    const masked = f.kind === "colon" ? `_____: ${f.desc}` : maskTerm(f.sentence, f.term, c.aliases);
    if (!masked.includes("_____")) return null;
    return { prompt: `Fill in the blank:\n${masked}`, options: null, answer: strip(f.term),
      rubric: [{ id: "term", text: strip(f.term), alternatives: termAlternatives(f.term, c.aliases), weight: 1, essential: true }],
      misconceptions: siblingsOf(f, c.facts).map((s) => ({ id: `wrong-term-${idOf(s.term)}`, claim: `Filled in ${lc(strip(s.term))} instead of ${lc(strip(f.term))}`, cues: termAlternatives(s.term, []), correction: `${cap(strip(s.term))} is ${s.desc}.` })),
      hints: [`Covered in ${c.where}.`, `It starts with “${strip(f.term).charAt(0).toUpperCase()}”.`, `It has ${strip(f.term).length} letters.`],
      explanation: `The course states: “${f.sentence}”` };
  } },
  { qtype: "comparison", level: "analyze", difficulty: 3, build: (c) => {
    const f = c.fact;
    const s = siblingsOf(f, c.facts)[0];
    if (!s || f.kind === "enumeration") return null;
    const a = { ...rubricFor(f).find((p) => p.essential) ?? rubricFor(f)[0]!, id: "a", essential: true, weight: 1 };
    const b = { ...rubricFor(s).find((p) => p.essential) ?? rubricFor(s)[0]!, id: "b", essential: true, weight: 1 };
    return { prompt: `How does ${lc(strip(f.term))} differ from ${lc(strip(s.term))}?`, options: null,
      answer: `${cap(strip(f.term))} is ${f.desc}, whereas ${lc(strip(s.term))} is ${s.desc}.`,
      rubric: [{ ...a, text: `${strip(f.term)}: ${a.text}` }, { ...b, text: `${strip(s.term)}: ${b.text}` }], misconceptions: [],
      hints: [`Both are covered in ${c.where}.`, `State one defining property of each.`, `Think about what each is *for*.`],
      explanation: `The course states: “${f.sentence}” and “${s.sentence}”` };
  } },
  // ---- list/enumeration formats (so list concepts can be re-tested in different ways) ----
  { qtype: "fill", level: "remember", difficulty: 1, tag: "fill-list", build: (c) => {
    const f = c.fact;
    if (f.items.length < 3) return null;
    const k = Math.floor(seeded(c.seed + "fill-enum")() * f.items.length);
    const shown = f.items.map((it, i) => (i === k ? "_____" : it)).join(", ");
    const missing = f.items[k]!;
    return { prompt: `Fill in the missing ${f.noun ? f.noun.replace(/s$/, "") : "item"} of ${lc(strip(f.term))}:\n${shown}`, options: null, answer: missing,
      rubric: [point(missing, { essential: true, weight: 1, headLast: true })], misconceptions: [],
      hints: [`Covered in ${c.where}.`, `It starts with “${missing.charAt(0).toUpperCase()}”.`, `There are ${f.items.length} ${f.noun ?? "items"} in total.`],
      explanation: `The course lists: “${f.sentence}”` };
  } },
  { qtype: "tf", level: "remember", difficulty: 1, tag: "tf-list", build: (c) => {
    const f = c.fact;
    if (f.items.length < 3) return null;
    const rnd = seeded(c.seed + "tf-enum");
    const foreign = foreignItems(f, c.facts);
    const useForeign = foreign.length > 0 && rnd() < 0.5;
    const item = useForeign ? foreign[Math.floor(rnd() * foreign.length)]! : f.items[Math.floor(rnd() * f.items.length)]!;
    const what = f.noun ? `one of the ${f.items.length} ${f.noun} of ${lc(strip(f.term))}` : `part of ${lc(strip(f.term))}`;
    const why = useForeign ? `“${item}” is not in the list; the course lists ${f.items.join(", ")}.` : `The course lists ${f.items.join(", ")}.`;
    return { prompt: `True or false: “${item}” is ${what}.`, options: tfOptions(!useForeign, why, useForeign ? `Thinks ${item} is ${what}` : ""),
      answer: useForeign ? "False" : "True", rubric: [{ id: "choice", text: useForeign ? "False" : "True", alternatives: [], weight: 1, essential: true }], misconceptions: [],
      hints: [`Covered in ${c.where}.`, `Try listing all ${f.items.length} from memory first.`, `The list starts with “${f.items[0]}”.`], explanation: why };
  } },
  { qtype: "mcq", level: "understand", difficulty: 2, tag: "mcq-odd-one-out", build: (c) => {
    const f = c.fact;
    const foreign = foreignItems(f, c.facts);
    if (f.items.length < 3 || !foreign.length) return null;
    const rnd = seeded(c.seed + "odd");
    const odd = foreign[Math.floor(rnd() * foreign.length)]!;
    const real = [...f.items].sort(() => rnd() - 0.5).slice(0, 3);
    const noun = f.noun ?? "items";
    const opts: Option[] = [...real.map((t) => ({ key: "", text: t, correct: false, why: `${cap(t)} is one of the ${noun} of ${lc(strip(f.term))}.` })),
      { key: "", text: odd, correct: true, why: `${cap(odd)} is not one of them; the course lists ${f.items.join(", ")}.` }]
      .map((o) => ({ o, r: rnd() })).sort((x, y) => x.r - y.r).map(({ o }, i) => ({ ...o, key: "ABCD"[i]! }));
    return { prompt: `Which of these is NOT one of the ${noun} of ${lc(strip(f.term))}?`, options: opts, answer: `${opts.find((o) => o.correct)!.key}. ${odd}`,
      rubric: [{ id: "choice", text: odd, alternatives: [], weight: 1, essential: true }], misconceptions: [],
      hints: [`Covered in ${c.where}.`, `There are ${f.items.length} ${noun} in the course's list.`, `Which option belongs to a different topic?`],
      explanation: `The course lists: “${f.sentence}”` };
  } },
  { qtype: "diagram", level: "apply", difficulty: 2, build: (c) => {
    const f = c.fact;
    if (f.kind !== "enumeration" || !c.diagramHint || f.items.length < 3) return null;
    const rubric = rubricFor(f);
    return { prompt: `Draw a diagram of ${lc(strip(f.term))} showing all ${f.items.length} ${f.noun ?? "parts"}${/state/i.test(f.term + (f.noun ?? "")) ? " and the transitions between them" : ""}.`, options: null,
      answer: f.items.join(" → ") + ".", rubric, misconceptions: [],
      hints: [`Covered in ${c.where}.`, `There are ${f.items.length} ${f.noun ?? "parts"}.`, `Start with “${f.items[0]}”.`],
      explanation: `The course lists: “${f.sentence}”` };
  } },
];

/** Items of *other* lists/terms in the evidence — real course terms that are NOT part of this list. */
function foreignItems(f: Fact, all: Fact[]): string[] {
  const mine = new Set(f.items.map((i) => i.toLowerCase()));
  const out = new Set<string>();
  for (const x of all) {
    if (x === f || x.term.toLowerCase() === f.term.toLowerCase()) continue;
    for (const it of x.items) if (!mine.has(it.toLowerCase()) && it.split(/\s+/).length <= 4) out.add(it);
  }
  return [...out];
}

function tfOptions(truth: boolean, why: string, misconception: string): Option[] {
  return [
    { key: "T", text: "True", correct: truth, why: truth ? why : misconception || why },
    { key: "F", text: "False", correct: !truth, why: truth ? `It is true: ${why}` : why },
  ];
}

/** All deterministic question candidates for a fact. */
export function candidates(c: TemplateContext): QuestionDraft[] {
  const out: QuestionDraft[] = [];
  for (const t of TEMPLATES) {
    const q = t.build(c);
    if (!q) continue;
    out.push({ ...q, conceptName: c.conceptName, qtype: t.qtype, level: t.level, difficulty: t.difficulty, evidenceChunkIds: [c.fact.chunkId], generator: `rule:${t.tag ?? t.qtype}` });
  }
  return out;
}

