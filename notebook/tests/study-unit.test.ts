import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extract } from "@/lib/extract";
import { extractFacts, type Fact } from "@/lib/study/facts";
import { gradeRule } from "@/lib/study/grade";
import { extractJson, validateGenerated } from "@/lib/study/llm";
import { applyAttempt, emptyMastery, nextLevel, quality, weakness, type Mastery } from "@/lib/study/mastery";
import { fingerprint, isNearDuplicate } from "@/lib/study/novelty";
import { candidates } from "@/lib/study/templates";
import { indexAnswer, stem, stemMatch } from "@/lib/study/text";
import type { QuestionDraft } from "@/lib/study/types";

// Facts from the real Lecture 5 slides of the OS fixture course.
const pages = await extract("pptx", new Uint8Array(readFileSync(path.join(__dirname, "fixtures/os/lecture05.pptx"))));
const facts: Fact[] = pages.flatMap((p) => extractFacts({ chunkId: `s${p.pageNo}`, section: p.title, text: `${p.title}\n${p.body}`, contentType: "slide", sourceKind: "slides" }));
const Q = (term: string, qtype: string): QuestionDraft => {
  const fact = facts.find((f) => f.term.toLowerCase() === term)!;
  return candidates({ fact, facts, conceptName: term, aliases: [], where: "Lecture 05", diagramHint: true, seed: "t" }).find((c) => c.qtype === qtype)!;
};
const g = (q: QuestionDraft, answer: string) => gradeRule({ qtype: q.qtype, rubric: q.rubric, misconceptions: q.misconceptions, options: q.options, answer });

describe("fact extraction from real slides", () => {
  it("finds definitions, labelled parts with lists, enumerations and sibling contrasts", () => {
    const by = (t: string) => facts.filter((f) => f.term.toLowerCase() === t);
    expect(by("process")[0]!.desc).toBe("a program in execution");
    expect(by("program")[0]!.desc).toBe("a passive entity stored on disk");
    expect(by("stack")[0]!.items).toEqual(["function parameters", "return addresses", "local variables"]);
    expect(by("heap")[0]!.desc).toBe("memory that is dynamically allocated during program run time");
    expect(by("process state")[0]).toMatchObject({ kind: "enumeration", items: ["New", "Ready", "Running", "Waiting", "Terminated"], noun: "states" });
    expect(by("process control block")[0]!.items).toContain("program counter");
  });
});

describe("semantic rubric grading (spec cases)", () => {
  const def = Q("process", "definition");
  it("accepts a correct paraphrase", () => {
    expect(g(def, "A running instance of a program.").verdict).toBe("correct");
    expect(g(def, "It's a program that is currently executing").verdict).toBe("correct");
  });
  it("rejects 'a program saved on disk' and explains with the course's own contrast", () => {
    const r = g(def, "A program saved on disk.");
    expect(r.verdict).toBe("incorrect");
    expect(r.misconceptions[0]!.correction).toMatch(/passive entity stored on disk.*program in execution/);
  });
  it("gives partial credit for 'a program that has started'", () => {
    expect(g(def, "A program that has started.").verdict).toBe("mostly");
  });
  it("handles negation and clause boundaries", () => {
    expect(g(def, "It is not a program on disk, it is running").verdict).not.toBe("incorrect");
    expect(g(def, "a program that is not running").verdict).toBe("partial");
  });
  it("stack contents: 'local variables and parameters' → mostly correct, missing return addresses", () => {
    const list = Q("stack", "list");
    const r = g(list, "Local variables and parameters.");
    expect(r.verdict).toBe("mostly");
    expect(r.points.filter((p) => p.status === "missing").map((p) => p.text)).toEqual(["return addresses"]);
  });
  it("a different modifier doesn't count: 'global variables' is not 'local variables'", () => {
    const r = g(Q("stack", "list"), "global variables");
    expect(r.points.find((p) => p.text === "local variables")!.status).toBe("missing");
    expect(r.misconceptions[0]!.correction).toMatch(/^Data section is global variables/);
  });
  it("misconception: return addresses in the heap → incorrect, explicit correction from the source", () => {
    const r = g(Q("stack", "list"), "Return addresses are kept in the heap.");
    expect(r.verdict).toBe("incorrect");
    expect(r.misconceptions.map((m) => m.correction)).toContain("Return addresses belong to stack, not heap.");
  });
  it("heap: paraphrase accepted; text-section description flagged as a misconception", () => {
    const h = Q("heap", "definition");
    expect(g(h, "memory allocated dynamically while the program runs").verdict).toBe("correct");
    const r = g(h, "the executable code");
    expect(r.verdict).toBe("incorrect");
    expect(r.misconceptions[0]!.correction).toMatch(/^Text section is the executable code/);
  });
  it("synonyms match only within meaning groups", () => {
    expect(stemMatch(stem("execution"), stem("running"))).toBe(1);
    expect(stemMatch(stem("execution"), stem("started"))).toBe(0.5);
    expect(stemMatch(stem("process"), stem("processor"))).toBe(0);
    expect(indexAnswer("not stored, but running").negated.size).toBe(1);
  });
  it("choice questions: wrong option explains itself", () => {
    const mcq = Q("heap", "mcq");
    const wrong = mcq.options!.find((o) => !o.correct)!;
    const r = g(mcq, wrong.key);
    expect(r.verdict).toBe("incorrect");
    expect(r.misconceptions[0]!.correction).toBe(wrong.why);
    expect(g(mcq, mcq.options!.find((o) => o.correct)!.key).verdict).toBe("correct");
  });
});

describe("question generation (deterministic)", () => {
  it("produces several formats and cognitive levels per fact, grounded in the fact", () => {
    const fact = facts.find((f) => f.term.toLowerCase() === "heap")!;
    const all = candidates({ fact, facts, conceptName: "Heap", aliases: [], where: "Lecture 05", diagramHint: false, seed: "x" });
    expect(new Set(all.map((c) => c.qtype))).toEqual(new Set(["definition", "indirect", "mcq", "tf", "fill", "comparison"]));
    expect(new Set(all.map((c) => c.level))).toEqual(new Set(["remember", "understand", "apply", "analyze"]));
    for (const c of all) expect(c.evidenceChunkIds).toEqual([fact.chunkId]);
  });
  it("indirect questions reword instead of quoting the slide, and never contain the answer", () => {
    const q = Q("process", "indirect");
    expect(q.prompt).toBe("Something is a program that is currently running. What does the course call it?");
    expect(q.prompt.toLowerCase()).not.toContain("process");
    expect(g(q, "a process").verdict).toBe("correct");
    expect(g(q, "a program").misconceptions[0]!.correction).toMatch(/fits process/);
    // Echoing the prompt's wording while naming the right term is not confusion.
    expect(g(q, "A process is a program in execution with its own memory.")).toMatchObject({ verdict: "correct", misconceptions: [] });
  });
  it("fair trick true/false attaches a neighbour's description and explains the confusion", () => {
    const tf = candidates({ fact: facts.find((f) => f.term.toLowerCase() === "process")!, facts, conceptName: "process", aliases: [], where: "", diagramHint: false, seed: "x" })
      .find((c) => c.generator === "rule:tf-contrast")!;
    expect(tf.prompt).toBe("True or false: Process is a passive entity stored on disk.");
    expect(tf.answer).toBe("False");
    expect(g(tf, "T").misconceptions[0]!.claim).toMatch(/Confuses process with program/);
  });
  it("hints are progressive and don't reveal the answer", () => {
    const q = Q("heap", "definition");
    expect(q.hints).toHaveLength(3);
    for (const h of q.hints) expect(h).not.toMatch(/dynamically allocated/);
  });
  it("diagram questions come from enumerations when the material talks about drawing", () => {
    expect(Q("process state", "diagram").prompt).toBe("Draw a diagram of process state showing all 5 states and the transitions between them.");
  });
});

describe("novelty", () => {
  const fp = (s: string) => ({ fingerprint: fingerprint(s, "Process"), qtype: "definition" });
  it("treats rewordings of the same definition question as duplicates", () => {
    expect(isNearDuplicate(fp("What is a process?"), fp("Define process."))).toBe(true);
    expect(isNearDuplicate(fp("Define process."), fp("Give the definition of process."))).toBe(true);
  });
  it("keeps genuinely different demands apart", () => {
    expect(isNearDuplicate(fp("Define a process."), fp("Why is an executable file on disk not yet a process?"))).toBe(false);
    expect(isNearDuplicate(fp("Define a process."), { fingerprint: fingerprint("Compare a program with a process.", "Process"), qtype: "comparison" })).toBe(false);
  });
});

describe("mastery, adaptivity and spaced review", () => {
  const t0 = new Date("2026-01-01T09:00:00Z");
  const at = (h: number) => new Date(t0.getTime() + h * 3600e3);
  it("three easy correct recognitions then a failed scenario: not mastered, next test stays at application level", () => {
    let m: Mastery = emptyMastery();
    for (let i = 0; i < 3; i++) m = applyAttempt(m, { verdict: "correct", score: 1, level: "remember", qtype: "mcq", hints: 0, misconceptions: 0, now: at(i * 0.1) });
    expect(m.state).not.toBe("mastered");
    expect(m.state).not.toBe("strong"); // one level of recognition isn't understanding
    m = applyAttempt(m, { verdict: "incorrect", score: 0, level: "apply", qtype: "scenario", hints: 0, misconceptions: 0, now: at(0.5) });
    expect(m.state).toBe("needs_review");
    expect(nextLevel(m, ["remember", "understand", "apply"], 2)).toBe("understand");
    expect(nextLevel({ ...m, levels: { ...m.levels, understand: { n: 1, s: 0.9 } } }, ["remember", "understand", "apply"], 2)).toBe("apply");
    expect(m.nextReview!.getTime() - at(0.5).getTime()).toBeLessThan(20 * 60e3); // comes back soon
  });
  it("mastery needs breadth, a higher-level success and retention after a gap", () => {
    let m = emptyMastery();
    const add = (level: "remember" | "understand" | "apply" | "analyze", h: number) =>
      (m = applyAttempt(m, { verdict: "correct", score: 1, level, qtype: level === "remember" ? "mcq" : "definition", hints: 0, misconceptions: 0, now: at(h) }));
    add("remember", 0); add("understand", 0.1); add("apply", 0.2);
    expect(m.state).toBe("strong");
    add("analyze", 30); // correct again after > 20 h
    expect(m.retained).toBe(1);
    expect(m.state).toBe("mastered");
  });
  it("SM-2-style intervals grow on success and reset on failure; hints lower quality", () => {
    let m = emptyMastery();
    const ok = (h: number) => (m = applyAttempt(m, { verdict: "correct", score: 1, level: "understand", qtype: "definition", hints: 0, misconceptions: 0, now: at(h) }));
    ok(0); expect(m.intervalDays).toBe(1);
    ok(24); expect(m.intervalDays).toBe(3);
    ok(96); expect(m.intervalDays).toBeCloseTo(3 * 2.7, 1);
    m = applyAttempt(m, { verdict: "incorrect", score: 0, level: "understand", qtype: "definition", hints: 0, misconceptions: 1, now: at(300) });
    expect(m.reps).toBe(0);
    expect(m.intervalDays).toBeLessThan(0.01);
    expect(quality("correct", 3)).toBe(3);
  });
  it("weak-area analysis explains misconceptions and level gaps; mastered concepts aren't weak", () => {
    const now = at(0);
    const base = { conceptId: "c", name: "Stack", lectureCount: 2, now };
    let m = emptyMastery();
    m = applyAttempt(m, { verdict: "correct", score: 1, level: "remember", qtype: "mcq", hints: 0, misconceptions: 0, now });
    m = applyAttempt(m, { verdict: "correct", score: 1, level: "understand", qtype: "definition", hints: 0, misconceptions: 0, now });
    m = applyAttempt(m, { verdict: "incorrect", score: 0, level: "apply", qtype: "scenario", hints: 0, misconceptions: 1, now });
    const w = weakness({ ...base, mastery: m, recentVerdicts: ["incorrect", "correct", "correct"], misconceptions: ["Return addresses belong to the stack, not the heap."] })!;
    expect(w.reasons).toEqual(["Misconception: Return addresses belong to the stack, not the heap.", "1 recent incorrect answer", "Good recall, weak application"]);
    expect(weakness({ ...base, mastery: null, recentVerdicts: [], misconceptions: [] })!.reasons[0]).toMatch(/Never tested/);
    const mastered = { ...m, state: "mastered" as const, nextReview: new Date(now.getTime() + 864e5) };
    expect(weakness({ ...base, mastery: mastered, recentVerdicts: ["correct"], misconceptions: [] })).toBeNull();
  });
});

describe("structured LLM output handling", () => {
  it("extracts JSON from chatty or fenced replies and rejects garbage", () => {
    expect(extractJson('Sure! ```json\n{"a": {"b": "}"}}\n``` done')).toEqual({ a: { b: "}" } });
    expect(() => extractJson("I cannot do that")).toThrow();
  });
  it("rejects ungrounded rubric ideas, wrong MCQ shapes, leaked answers and copied wording", () => {
    const evText = "A process is a program in execution. A program is a passive entity stored on disk.";
    const ev = [{ n: 1, chunkId: "c", label: "L5", excerpt: evText, lectureId: null, lectureNumber: 5, materialId: null, pageNo: 2, noteId: null, anchor: null, kind: "slides", contentType: "slide" }];
    const stems = new Set(evText.toLowerCase().match(/[a-z]+/g)!.map(stem));
    const base = { question: "An executable file has been loaded and is now running. What is it called?", answer: "A process", rubric: [{ text: "process", keywords: ["process"], essential: true }], misconceptions: [], hints: ["h"], explanation: "", evidence: [1] };
    expect(validateGenerated(base, { qtype: "indirect", evidence: ev }, stems, evText)).toBeNull();
    expect(validateGenerated({ ...base, rubric: [{ text: "uses a PCB", keywords: ["quantum entanglement"], essential: true }] }, { qtype: "indirect", evidence: ev }, stems, evText)).toMatch(/not supported by the evidence/);
    expect(validateGenerated({ ...base, evidence: [3] }, { qtype: "indirect", evidence: ev }, stems, evText)).toMatch(/source number/);
    expect(validateGenerated({ ...base, options: [{ text: "a", correct: true, why: "" }, { text: "b", correct: true, why: "" }, { text: "c", correct: false, why: "" }] }, { qtype: "mcq", evidence: ev }, stems, evText)).toMatch(/exactly one correct/);
    expect(validateGenerated({ ...base, question: "A program is a passive entity stored on disk. What is it?" }, { qtype: "indirect", evidence: ev }, stems, evText)).toMatch(/copies the evidence wording/);
    expect(validateGenerated({ ...base, question: "Is it true that a process is a program in execution?", answer: "a process is a program in execution" }, { qtype: "short", evidence: ev }, stems, evText)).toMatch(/contains its own answer/);
  });
});

describe("misconceptions stated with synonyms", () => {
  it("'a program that is running' for *program* is caught (it describes a process); 'executable' ≠ 'executing'", () => {
    const prog = Q("program", "definition");
    const r = g(prog, "a program that is running in memory");
    expect(r.verdict).toBe("incorrect");
    expect(r.misconceptions[0]!.correction).toMatch(/^Process is a program in execution/);
    expect(stem("executable")).not.toBe(stem("execution"));
    expect(g(Q("heap", "definition"), "memory allocated dynamically while the program runs").misconceptions).toEqual([]);
  });
});
