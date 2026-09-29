// Near-duplicate detection for questions about the same concept. "What is a process?", "Define process." and
// "Give the definition of process." reduce to the same (empty) signature once the concept's own words and generic
// question words are removed, so they count as duplicates; questions that add a situation or a contrast do not.
import { contentStems } from "./text";

const QUESTION_WORDS = new Set(contentStems(
  "what is are define definition explain describe meaning mean give state name own words term concept course " +
  "true false fill blank which one does do call called following statement answer briefly short idea key",
));

export function fingerprint(prompt: string, conceptName: string): string {
  const concept = new Set(contentStems(conceptName));
  return [...new Set(contentStems(prompt).filter((s) => !concept.has(s) && !QUESTION_WORDS.has(s)))].sort().join(" ");
}

export function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean)), B = new Set(b.split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Same question type and ≥ 60 % overlapping content words (after removing concept & question words) = duplicate. */
export function isNearDuplicate(a: { fingerprint: string; qtype: string }, b: { fingerprint: string; qtype: string }): boolean {
  const sim = jaccard(a.fingerprint, b.fingerprint);
  return a.qtype === b.qtype ? sim >= 0.6 : sim >= 0.9;
}
