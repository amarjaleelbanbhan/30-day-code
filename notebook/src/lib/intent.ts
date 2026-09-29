// Deterministic query-intent routing. Each intent maps to a different retrieval strategy in rag.ts.

export type SourceHint = "teacher" | "notes" | "book" | null;

export type Intent =
  | { kind: "recall_course" }
  | { kind: "recall_lecture"; numbers: number[] }
  | { kind: "cross_lecture"; numbers: number[]; topic: string | null }
  | { kind: "comparison"; subjects: [string, string] }
  | { kind: "source_lookup"; topic: string; first: boolean }
  | { kind: "topic"; topic: string; focus: "all" | "examples" | "development" }
  | { kind: "exam_revision"; topic: string | null }
  | { kind: "definition"; topic: string }
  | { kind: "ask"; lectureNumbers: number[] };

export type RoutedQuery = { intent: Intent; hint: SourceHint; question: string };

const NUM = String.raw`(\d{1,4})`;

export function lectureNumbersIn(text: string): number[] {
  const out = new Set<number>();
  const range = new RegExp(String.raw`\b(?:lectures?|lec|l)\s*${NUM}\s*(?:-|–|—|to|through)\s*(?:lectures?\s*|l\s*)?${NUM}`, "gi");
  for (const m of text.matchAll(range)) {
    const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y) as [number, number];
    for (let i = a; i <= Math.min(b, a + 100); i++) out.add(i);
  }
  const single = new RegExp(String.raw`\b(?:lectures?|lec)\s*${NUM}((?:\s*(?:,|and|&)\s*(?:lectures?\s*)?${NUM})*)`, "gi");
  for (const m of text.matchAll(single)) {
    out.add(Number(m[1]));
    for (const n of (m[2] ?? "").matchAll(/\d{1,4}/g)) out.add(Number(n[0]));
  }
  return [...out].sort((a, b) => a - b);
}

const clean = (s: string) =>
  s.replace(/[?.!]+$/, "").replace(/^\s*(?:the|a|an)\s+/i, "").replace(/\s+/g, " ").trim();

/** Removes lecture references and filler from a topic phrase. */
function topicOf(s: string): string {
  return clean(
    s.replace(/\b(?:in|from|across|during|throughout)?\s*(?:lectures?|lec)\s*\d+(?:\s*(?:-|–|—|to|and|&|,)\s*(?:lectures?\s*)?\d+)*/gi, " ")
      .replace(/\b(?:in|throughout|across|during)\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:course|semester|class|lectures)\b/gi, " ")
      .replace(/\b(?:our|my|the)\s+(?:teacher|lecturer|professor|sir|instructor)\b/gi, " "),
  );
}

export function sourceHint(q: string): SourceHint {
  if (/\b(sir|madam|miss|teacher|lecturer|professor|prof|instructor|he|she)\s+(say|said|says|mention(?:ed)?|told|stress(?:ed)?|emphasi[sz]ed?|explain(?:ed)?|talk(?:ed)? about)\b/i.test(q)) return "teacher";
  if (/\b(my|our)\s+(own\s+)?notes?\b|\bi\s+(wrote|noted)\b/i.test(q)) return "notes";
  if (/\b(text\s?book|the book|reference book|chapter)\b/i.test(q)) return "book";
  return null;
}

export function route(question: string): RoutedQuery {
  const q = question.trim().replace(/\s+/g, " ");
  const t = q.replace(/[?.!]+$/, "");
  const nums = lectureNumbersIn(t);
  const hint = sourceHint(t);
  const R = (intent: Intent): RoutedQuery => ({ intent, hint, question: q });
  let m: RegExpMatchArray | null;

  if (/^(?:recall|reconstruct|summari[sz]e|review|overview of|give me an overview of)\s+(?:the\s+|this\s+|my\s+)?(?:whole\s+|entire\s+|full\s+)?(?:course|semester|subject)$/i.test(t))
    return R({ kind: "recall_course" });

  if (nums.length && /^(?:recall|reconstruct|summari[sz]e|review|revise)\s+(?:the\s+)?(?:lectures?|lec|l)\b[\s\d,–—&-]*(?:and|to|through)?[\s\d,–—&-]*$/i.test(t))
    return R({ kind: "recall_lecture", numbers: nums });

  if (nums.length && /^(?:explain|summari[sz]e|recall|reconstruct|revise)\s+(?:everything|all)\s+(?:from|in|of)\s+(?:lectures?|lec)\b/i.test(t) && !/\babout\b/i.test(t))
    return R({ kind: "recall_lecture", numbers: nums });

  if (nums.length >= 2 && /\b(connect|connection|link|relate|relationship|both|common|compare|between|and)\b/i.test(t)) {
    const about = t.match(/\babout\s+(.+)$/i)?.[1];
    const topic = about ? topicOf(about) : null;
    return R({ kind: "cross_lecture", numbers: nums, topic: topic || null });
  }

  if ((m = t.match(/\b(?:difference|differences|differ|distinguish)\s+between\s+(.+?)\s+and\s+(.+)$/i)) ||
      (m = t.match(/^(?:compare|contrast)\s+(.+?)\s+(?:and|with|to|vs\.?|versus)\s+(.+)$/i)) ||
      (m = t.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i)) ||
      (m = t.match(/^how (?:is|are|does|do)\s+(.+?)\s+differ(?:ent)? from\s+(.+)$/i)))
    return R({ kind: "comparison", subjects: [topicOf(m[1]!), topicOf(m[2]!)] });

  if ((m = t.match(/^(?:where|when|in which lectures?|which lectures?)\s+(?:did|do|was|were|is|are|have|has)\s+(?:we\s+|i\s+|the\s+teacher\s+|sir\s+)?(?:first\s+)?(?:study|studied|learn|learned|learnt|cover|covered|discuss|discussed|see|saw|mention|mentioned|introduce|introduced|talk about|explain|explained)?\s*(?:about\s+)?(.+?)(?:\s+(?:first\s+)?(?:introduced|covered|discussed|mentioned|explained|taught|studied))?$/i)) ||
      (m = t.match(/^(?:show|list|find)\s+(?:me\s+)?(?:every|all|each)\s+(?:lectures?|places?|slides?)\s+(?:where|that|which|mentioning|about|on)\s+(?:mention\s+|cover\s+|discuss\s+)?(.+?)(?:\s+(?:appears?|is mentioned|comes up|is discussed))?$/i)))
    return R({ kind: "source_lookup", topic: topicOf(m[1]!), first: /\bfirst\b/i.test(t) });

  if ((m = t.match(/^(?:find|show|list|give me)\s+(?:me\s+)?(?:all|every)\s+(?:the\s+)?examples?\s+(?:related to|about|of|on|for)\s+(.+)$/i)))
    return R({ kind: "topic", topic: topicOf(m[1]!), focus: "examples" });

  if ((m = t.match(/^how\s+(?:did|has)\s+(?:the\s+)?(?:explanation|understanding|treatment|coverage|idea|concept)?\s*(?:of\s+)?(.+?)\s+(?:develop|evolve|change|progress|build up)/i)))
    return R({ kind: "topic", topic: topicOf(m[1]!), focus: "development" });

  if (/\b(exam|revise|revision|test me|important for|likely to (?:come|be asked)|what should i (?:study|revise|focus))\b/i.test(t)) {
    const about = t.match(/\b(?:about|on|for|in)\s+(.+)$/i)?.[1];
    return R({ kind: "exam_revision", topic: about ? topicOf(about.replace(/\b(the\s+)?exams?\b/gi, "")) || null : null });
  }

  if ((m = t.match(/^(?:recall|tell me|give me|summari[sz]e|explain|show me)?\s*(?:everything|all)\s+(?:that\s+)?(?:we(?:'ve| have)?\s+|i(?:'ve| have)?\s+|the teacher\s+|sir\s+)?(?:learned|learnt|studied|know|covered|taught|did|said)?\s*(?:about|on|regarding|related to|of)\s+(.+)$/i)) ||
      (m = t.match(/^what\s+(?:did|have)\s+(?:we|i)\s+(?:study|studied|learn|learned|learnt|cover|covered)\s+(?:about|on|regarding)\s+(.+)$/i)) ||
      (m = t.match(/^(?:give me\s+)?everything\s+(?:the\s+teacher|sir|our\s+lecturer)\s+(?:has\s+)?(?:taught|said|told us)\s+about\s+(.+)$/i)) ||
      (m = t.match(/^(?:recall|reconstruct)\s+(?:the\s+topic\s+(?:of\s+)?)?(.+)$/i)) ||
      (m = t.match(/^everything\s+(?:about|on)\s+(.+)$/i)))
    return R({ kind: "topic", topic: topicOf(m[1]!), focus: "all" });

  if ((m = t.match(/^(?:what\s+(?:is|are|was|were)|what's|whats|define|definition of|meaning of|explain)\s+(?:a|an|the)?\s*(.{1,60})$/i)) && m[1]!.split(/\s+/).length <= 6 && !nums.length)
    return R({ kind: "definition", topic: topicOf(m[1]!) });

  return R({ kind: "ask", lectureNumbers: nums });
}
