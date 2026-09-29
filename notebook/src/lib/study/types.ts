// Shared study types (client-safe).

export type QType =
  | "mcq" | "tf" | "fill" | "definition" | "list" | "short" | "conceptual" | "why" | "comparison"
  | "scenario" | "indirect" | "code" | "diagram" | "formula";
export type Level = "remember" | "understand" | "apply" | "analyze" | "transfer";
export const LEVELS: Level[] = ["remember", "understand", "apply", "analyze", "transfer"];
export type Verdict = "correct" | "mostly" | "partial" | "incorrect" | "dont_know";

export const QTYPE_LABEL: Record<QType, string> = {
  mcq: "Multiple choice", tf: "True / false", fill: "Fill in the blank", definition: "Definition", list: "Recall the parts",
  short: "Short answer", conceptual: "Conceptual", why: "Why / how", comparison: "Comparison", scenario: "Scenario",
  indirect: "Which concept?", code: "Code", diagram: "Diagram", formula: "Problem solving",
};
export const VERDICT_LABEL: Record<Verdict, string> = {
  correct: "Correct", mostly: "Mostly correct", partial: "Partially correct", incorrect: "Incorrect", dont_know: "I don't know",
};

/** Each alternative is a list of stems; the first stem is the head (must match), the rest are supporting words. */
export type RubricPoint = { id: string; text: string; alternatives: string[][]; weight: number; essential: boolean };
/** Fires when every stem of any one cue set appears (un-negated) in the answer. */
/** `pointId`: when the rule fires, that rubric point earns no credit (e.g. the item was put in the wrong place). */
export type MisconceptionRule = { id: string; claim: string; cues: string[][]; correction: string; pointId?: string; /** id of a rubric point that, when met, suppresses this rule */ unless?: string };
export type Option = { key: string; text: string; correct: boolean; why: string };

export type EvidenceRef = {
  n: number; chunkId: string; label: string; excerpt: string; lectureId: string | null; lectureNumber: number | null;
  materialId: string | null; pageNo: number | null; noteId: string | null; anchor: string | null; kind: string; contentType: string;
};

export type QuestionDraft = {
  conceptName: string;
  qtype: QType;
  level: Level;
  difficulty: 1 | 2 | 3;
  prompt: string;
  options: Option[] | null;
  answer: string;
  rubric: RubricPoint[];
  misconceptions: MisconceptionRule[];
  hints: string[];
  explanation: string;
  /** chunk ids of the evidence the question is built from */
  evidenceChunkIds: string[];
  generator: string;
};

export type PointResult = { id: string; text: string; status: "met" | "partial" | "missing" };
export type Grade = {
  verdict: Verdict;
  score: number;
  points: PointResult[];
  misconceptions: { claim: string; correction: string }[];
  grader: string;
};
