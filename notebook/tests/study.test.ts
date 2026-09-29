// Study engine integration tests on the 7-lecture OS fixture course (real extraction, concept index, database).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrate";
import { app, setupOsCourse, stubOllama, TEST_DB, testEnv } from "./helpers";

testEnv();
const A = await app();
const E = await import("@/lib/study/engine");

let userId: string, courseId: string, lec: Record<number, string>, otherUser: string;

beforeAll(async () => {
  await migrate(TEST_DB);
  ({ userId, courseId, lec } = await setupOsCourse(A));
  otherUser = await A.user();
}, 90_000);
afterAll(async () => {
  await A.db.q("DELETE FROM users WHERE id = ANY($1)", [[userId, otherUser]]);
  await A.db.pool().end();
});

type View = NonNullable<Awaited<ReturnType<typeof E.sessionView>>>;
const view = async (sid: string) => (await E.sessionView(userId, sid))!;
const current = (v: View) => v.items.find((i) => !i.result)!;
const start = async (kind: Parameters<typeof E.createSession>[2], scope: Parameters<typeof E.createSession>[3], config: Partial<Parameters<typeof E.createSession>[4]> = {}) => {
  const s = await E.createSession(userId, courseId, kind, scope, { types: "mixed", difficulty: "adaptive", ...config });
  if (!s || "error" in s) throw new Error(JSON.stringify(s));
  return s.id;
};
/** Answers the current item; for choice questions picks the correct/incorrect option as asked. */
async function answer(sid: string, how: { text?: string; right?: boolean; dontKnow?: boolean }) {
  const cur = current(await view(sid));
  if (how.dontKnow) await E.answerItem(userId, sid, cur.itemId, { dontKnow: true });
  else if (cur.options) {
    const q = (await A.db.q1<{ options: { key: string; correct: boolean }[] }>("SELECT options FROM study_questions sq JOIN study_items si ON si.question_id = sq.id WHERE si.id = $1", [cur.itemId]))!;
    await E.answerItem(userId, sid, cur.itemId, { answer: q.options.find((o) => o.correct === (how.right ?? true))!.key });
  } else if (cur.qtype === "diagram") {
    const r = await E.answerItem(userId, sid, cur.itemId, { drawing: { shapes: [] } });
    await E.answerItem(userId, sid, cur.itemId, { selfCheck: how.right === false ? [] : (r as { checklist: { id: string }[] }).checklist.map((c) => c.id) });
  } else await E.answerItem(userId, sid, cur.itemId, { answer: how.text ?? "" });
  const v = await view(sid);
  return { item: v.items.find((i) => i.itemId === cur.itemId)!, view: v };
}
/** Correct answer text for the current open question, straight from its model answer. */
const correctText = async (itemId: string) =>
  (await A.db.q1<{ answer: string }>("SELECT sq.answer FROM study_questions sq JOIN study_items si ON si.question_id = sq.id WHERE si.id = $1", [itemId]))!.answer;

describe("practice session on one lecture (no LLM)", () => {
  let sid: string;
  it("starts with a source-grounded question from that lecture and hides the answer", async () => {
    sid = await start("practice", { type: "lecture", lectureIds: [lec[5]!], label: "Lecture 5" });
    const v = await view(sid);
    expect(v.items).toHaveLength(1);
    const q = v.items[0]!;
    expect(q.result).toBeNull();
    expect(JSON.stringify(q)).not.toMatch(/"answer"|rubric|evidence|explanation/);
    const row = (await A.db.q1<{ evidence: { lectureId: string }[]; lecture_ids: string[] }>("SELECT sq.evidence, sq.lecture_ids FROM study_questions sq JOIN study_items si ON si.question_id = sq.id WHERE si.id = $1", [q.itemId]))!;
    expect(row.lecture_ids).toEqual([lec[5]]);
    expect(row.evidence[0]!.lectureId).toBe(lec[5]);
    const src = await A.db.q("SELECT 1 FROM question_sources qs JOIN study_items si ON si.question_id = qs.question_id WHERE si.id = $1", [q.itemId]);
    expect(src.length).toBeGreaterThan(0);
  });

  it("grades a correct answer, records an immutable attempt and updates mastery", async () => {
    const cur = current(await view(sid));
    const { item } = await answer(sid, { text: await correctText(cur.itemId), right: true });
    expect(["correct", "mostly"]).toContain(item.result!.verdict);
    expect(item.result!.evidence.length).toBeGreaterThan(0);
    expect(item.result!.evidence[0]!.label).toMatch(/^Lecture 05 · Slide \d/);
    const again = await E.answerItem(userId, sid, cur.itemId, { answer: "changed my mind" });
    expect(again).toEqual({ error: "already answered" });
    const m = await A.db.q1<{ attempts: number }>("SELECT attempts FROM concept_mastery WHERE user_id = $1 AND concept_id = $2", [userId, cur.conceptId]);
    expect(m!.attempts).toBe(1);
  });

  it("'I don't know' teaches from the course, then a check and a differently-worded retest of the same concept follow", async () => {
    expect(await E.nextItem(userId, sid)).toBeTruthy();
    const failed = current(await view(sid));
    const { item } = await answer(sid, { dontKnow: true });
    expect(item.result!.verdict).toBe("dont_know");
    expect(item.result!.modelAnswer.length).toBeGreaterThan(3);
    const teach = (await E.explainItem(userId, sid, failed.itemId, "teach"))!;
    expect(teach.markdown).toMatch(/From your course/);
    expect(teach.markdown).toMatch(/\[1\]/);
    const seen: { concept: string; prompt: string; qtype: string; purpose: string }[] = [];
    for (let i = 0; i < 5; i++) {
      await E.nextItem(userId, sid);
      const cur = current(await view(sid));
      seen.push({ concept: cur.conceptName, prompt: cur.prompt, qtype: cur.qtype, purpose: cur.purpose });
      await answer(sid, { text: await correctText(cur.itemId), right: true });
    }
    const again = seen.filter((s) => s.concept === failed.conceptName);
    expect(again.length).toBeGreaterThanOrEqual(2);                     // comprehension check + retest
    expect(again[0]!.purpose).toBe("check");
    expect(again.some((s) => s.purpose === "retest")).toBe(true);
    for (const s of again) expect(s.prompt).not.toBe(failed.prompt);   // never the identical question
    expect(again.every((s) => s.qtype !== failed.qtype)).toBe(true);   // different format
  });

  it("hints are progressive, counted, and reduce mastery credit", async () => {
    await E.nextItem(userId, sid);
    const cur = current(await view(sid));
    const h1 = (await E.takeHint(userId, sid, cur.itemId))!;
    const h2 = (await E.takeHint(userId, sid, cur.itemId))!;
    expect(h1.hints).toHaveLength(1);
    expect(h2.hints).toHaveLength(2);
    expect(h2.hints[0]).toBe(h1.hints[0]);
    const { item } = await answer(sid, { text: await correctText(cur.itemId), right: true });
    expect(item.result!.hintsUsed).toBe(2);
  });

  it("resumes after a 'reload' with the same state, and summarises on finish", async () => {
    await E.nextItem(userId, sid);
    const before = await view(sid);
    const again = await view(sid); // a new request = reopening the app
    expect(again.items.map((i) => i.itemId)).toEqual(before.items.map((i) => i.itemId));
    expect(current(again).itemId).toBe(current(before).itemId);
    const summary = (await E.finishSession(userId, sid))!;
    expect(summary.total).toBe(before.items.filter((i) => i.result).length);
    expect(summary.breakdown.dont_know).toBe(1);
    expect(summary.needsWork.length + summary.strong.length).toBeGreaterThan(0);
    expect(summary.recommended.length).toBeGreaterThan(0);
    const done = await view(sid);
    expect(done.status).toBe("completed");
    expect(await E.nextItem(userId, sid)).toBeNull();
  });
});

describe("misconceptions and weak areas", () => {
  it("logs a misconception and 'Study Weak Areas' puts that concept first", async () => {
    const sid = await start("practice", { type: "concept", conceptIds: [(await A.db.q1<{ id: string }>("SELECT id FROM concepts WHERE course_id = $1 AND norm = 'stack'", [courseId]))!.id] }, { types: ["list"] });
    const cur = current(await view(sid));
    expect(cur.conceptName).toBe("Stack");
    const { item } = await answer(sid, { text: "Return addresses are kept in the heap." });
    expect(item.result!.verdict).toBe("incorrect");
    expect(item.result!.misconceptions[0]!.correction).toBe("Return addresses belong to stack, not heap.");
    await E.finishSession(userId, sid);
    const weak = await E.weakAreas(userId, courseId);
    expect(weak[0]!.name).toBe("Stack");
    expect(weak[0]!.reasons[0]).toMatch(/Misconception: Return addresses belong to stack/);
    const w = await start("weak", { type: "weak" });
    expect(current(await view(w)).conceptName).toBe("Stack");
    await E.finishSession(userId, w);
  });
});

describe("exam practice", () => {
  it("hides correctness, hints and sources until submission, then grades everything with sources", async () => {
    const sid = await start("exam", { type: "lectures", lectureIds: [lec[5]!, lec[6]!] }, { count: 4, timeLimitMin: 30 });
    for (let i = 0; i < 4; i++) {
      const v = await view(sid);
      const cur = v.items[v.items.length - 1]!;
      expect(cur.result).toBeNull();
      expect(cur.hintsAvailable).toBe(0);
      expect(await E.takeHint(userId, sid, cur.itemId)).toBeNull();
      expect(cur.qtype).not.toBe("diagram");
      const r = await E.answerItem(userId, sid, cur.itemId, { answer: i === 0 ? await correctText(cur.itemId) : i === 1 ? "no idea really" : cur.options?.[0]?.key ?? "something" });
      expect(r).toEqual({ saved: true });
      const after = await view(sid);
      expect(after.items.every((x) => x.result === null)).toBe(true);
      expect(await E.explainItem(userId, sid, cur.itemId, "teach")).toBeNull();
      if (i < 3) expect(await E.nextItem(userId, sid)).toBeTruthy();
    }
    expect(await E.nextItem(userId, sid)).toBeNull(); // question count reached
    const summary = (await E.submitExam(userId, sid))!;
    expect(summary.total).toBe(4);
    expect(summary.byType.length).toBeGreaterThan(0);
    const v = await view(sid);
    expect(v.status).toBe("completed");
    for (const it of v.items) {
      expect(it.result).not.toBeNull();
      expect(it.result!.evidence.length).toBeGreaterThan(0);
    }
    expect(v.items[0]!.result!.verdict).not.toBe("incorrect");
  });
});

describe("master mode", () => {
  it("keeps going until each concept is shown at understanding AND a higher level, not after easy wins", async () => {
    const pcid = (await A.db.q1<{ id: string }>("SELECT id FROM concepts WHERE course_id = $1 AND norm = 'process'", [courseId]))!.id;
    const sid = await start("master", { type: "concept", conceptIds: [pcid] });
    const asked: { level: string; qtype: string; concept: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const v = await view(sid);
      const cur = v.items.find((x) => !x.result);
      if (!cur) break;
      asked.push({ level: cur.level, qtype: cur.qtype, concept: cur.conceptName });
      await answer(sid, { text: await correctText(cur.itemId), right: true });
      if (!(await E.nextItem(userId, sid))) break;
    }
    const forProcess = asked.filter((a) => a.concept === "Process");
    expect(forProcess.some((a) => ["apply", "analyze", "transfer"].includes(a.level))).toBe(true);
    expect(new Set(forProcess.map((a) => a.level).filter((l) => l !== "remember")).size).toBeGreaterThanOrEqual(2);
    expect(new Set(forProcess.map((a) => a.qtype)).size).toBeGreaterThanOrEqual(2);
    expect(asked.length).toBeLessThan(30); // it does finish once understanding is demonstrated
    await E.finishSession(userId, sid);
  });

  it("cross-lecture question: once a concept is solid, asks how it relates to one taught in another lecture, citing both", async () => {
    const pcid = (await A.db.q1<{ id: string }>("SELECT id FROM concepts WHERE course_id = $1 AND norm = 'process'", [courseId]))!.id;
    const sid = await start("practice", { type: "concept", conceptIds: [pcid] }, { difficulty: 3, count: 14 });
    let found: { prompt: string; evidence: { lectureId: string }[] } | null = null;
    for (let i = 0; i < 14 && !found; i++) {
      const cur = current(await view(sid));
      const row = (await A.db.q1<{ generator: string; prompt: string; evidence: { lectureId: string }[] }>("SELECT generator, prompt, evidence FROM study_questions sq JOIN study_items si ON si.question_id = sq.id WHERE si.id = $1", [cur.itemId]))!;
      if (row.generator === "rule:cross-lecture-comparison") found = row;
      await answer(sid, { text: await correctText(cur.itemId), right: true });
      if (!found && !(await E.nextItem(userId, sid))) break;
    }
    expect(found).not.toBeNull();
    expect(found!.prompt).toBe("How does process differ from thread?");
    expect(new Set(found!.evidence.slice(0, 2).map((e) => e.lectureId))).toEqual(new Set([lec[5], lec[6]]));
    await E.finishSession(userId, sid);
  });

  it("never asks near-duplicate questions about one concept", async () => {
    const qs = await A.db.q<{ fingerprint: string; qtype: string; prompt: string }>(
      `SELECT DISTINCT sq.fingerprint, sq.qtype, sq.prompt FROM study_items si JOIN study_questions sq ON sq.id = si.question_id
       JOIN study_sessions s ON s.id = si.session_id WHERE s.user_id = $1 AND sq.concept_name = 'Process'`, [userId]);
    const { isNearDuplicate } = await import("@/lib/study/novelty");
    for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++)
      expect(isNearDuplicate(qs[i]!, qs[j]!), `${qs[i]!.prompt} ~ ${qs[j]!.prompt}`).toBe(false);
  });
});

describe("authorization", () => {
  it("another user can't see, answer, hint, explain, finish or start sessions on someone else's course", async () => {
    const sid = await start("practice", { type: "course" });
    const cur = current(await view(sid));
    expect(await E.sessionView(otherUser, sid)).toBeNull();
    expect(await E.answerItem(otherUser, sid, cur.itemId, { answer: "x" })).toBeNull();
    expect(await E.takeHint(otherUser, sid, cur.itemId)).toBeNull();
    expect(await E.explainItem(otherUser, sid, cur.itemId, "teach")).toBeNull();
    expect(await E.nextItem(otherUser, sid)).toBeNull();
    expect(await E.finishSession(otherUser, sid)).toBeNull();
    expect(await E.createSession(otherUser, courseId, "practice", { type: "course" }, { types: "mixed", difficulty: "adaptive" })).toBeNull();
    expect(await E.overview(otherUser, courseId)).toBeNull();
    // an item id from one session can't be used through another session id
    const other = await start("quick", { type: "course" });
    expect(await E.answerItem(userId, other, cur.itemId, { answer: "x" })).toBeNull();
  });
});

describe("overview", () => {
  it("reports coverage per lecture, due reviews and question-type performance", async () => {
    const o = (await E.overview(userId, courseId))!;
    expect(o.coverage).toHaveLength(7);
    const l5 = o.coverage.find((c) => c.number === 5)!;
    expect(l5.concepts).toBeGreaterThan(3);
    expect(l5.states.not_started).toBeLessThan(l5.concepts);
    expect(o.coverage.find((c) => c.number === 1)!.untested.length).toBeGreaterThan(0);
    expect(o.byType.length).toBeGreaterThan(1);
    expect(o.capability).toEqual({ llm: false, embeddings: false });
  });
});

describe("LLM paths (stub Ollama server)", () => {
  const good = (u: string) => {
    const n = Number(u.match(/\[(\d+)\]/)?.[1] ?? 1);
    return JSON.stringify({
      question: "A freshly compiled executable is loaded and begins running on the CPU. Which operating-system abstraction now represents it, and why?",
      answer: "A process — a program in execution.", rubric: [{ text: "names process", keywords: ["process"], essential: true }, { text: "program in execution", keywords: ["execution", "running"], essential: false }],
      misconceptions: [{ claim: "Calls it a program", cue_words: ["program", "disk"], correction: "A program on disk is passive; a running program is a process." }],
      hints: ["Think about what changes when a program starts running.", "The OS tracks it with a control block.", "Active vs passive entity."], explanation: "The course defines a process as a program in execution.", evidence: [n],
    });
  };
  it("generates a validated, grounded question and grades with point judgements (verdict computed, not trusted)", async () => {
    const stub = await stubOllama((sys, u) => sys.startsWith("You write ONE exam question") ? good(u)
      : sys.startsWith("You grade ONE") ? JSON.stringify({ points: [{ id: "p1", status: "met" }, { id: "p2", status: "partial" }], misconceptions: [] }) : "{}");
    stub.use();
    try {
      const pcid = (await A.db.q1<{ id: string }>("SELECT id FROM concepts WHERE course_id = $1 AND norm = 'process'", [courseId]))!.id;
      const sid = await start("practice", { type: "concept", conceptIds: [pcid] }, { types: ["scenario"] });
      const cur = current(await view(sid));
      expect(cur.qtype).toBe("scenario");
      expect(cur.prompt).toMatch(/freshly compiled executable/);
      const row = (await A.db.q1<{ generator: string; evidence: unknown[] }>("SELECT generator, evidence FROM study_questions sq JOIN study_items si ON si.question_id = sq.id WHERE si.id = $1", [cur.itemId]))!;
      expect(row.generator).toBe("llm:ollama:stub-llm");
      expect(row.evidence.length).toBeGreaterThan(0);
      expect(stub.calls[0]!.user).toMatch(/Evidence:\n\[1\] Lecture 05/);
      const { item } = await answer(sid, { text: "It becomes a process because it is now running" });
      expect(item.result!.grader).toBe("llm:ollama:stub-llm");
      expect(item.result!.verdict).toBe("mostly"); // 1 met + 1 partial → computed 0.75
      await E.finishSession(userId, sid);
    } finally { stub.off(); await stub.close(); }
  });

  it("malformed or ungrounded model output: one retry, then safe fallback to rule-based questions and grading", async () => {
    let n = 0;
    const stub = await stubOllama((sys) => {
      n++;
      if (sys.startsWith("You write ONE")) return n % 2 ? "Here is your question: What is a process?" : JSON.stringify({ question: "What does the PCB store about quantum entanglement?", answer: "x", rubric: [{ text: "qubits", keywords: ["qubit entanglement"], essential: true }], hints: ["a"], evidence: [1] });
      return "not json at all";
    });
    stub.use();
    try {
      const pcid = (await A.db.q1<{ id: string }>("SELECT id FROM concepts WHERE course_id = $1 AND norm = 'heap'", [courseId]))!.id;
      const sid = await start("practice", { type: "concept", conceptIds: [pcid] }, { types: ["definition"] });
      const cur = current(await view(sid));
      const row = (await A.db.q1<{ generator: string; prompt: string }>("SELECT generator, prompt FROM study_questions sq JOIN study_items si ON si.question_id = sq.id WHERE si.id = $1", [cur.itemId]))!;
      expect(row.generator).toBe("rule:definition");
      expect(row.prompt).not.toMatch(/quantum/);
      const { item } = await answer(sid, { text: "memory allocated dynamically at run time" });
      expect(item.result!.grader).toMatch(/^rule/);        // grading fell back too
      expect(item.result!.verdict).toBe("correct");
      const attempts = await A.db.q("SELECT 1 FROM study_attempts WHERE session_id = $1", [sid]);
      expect(attempts).toHaveLength(1);                      // history stays consistent
      await E.finishSession(userId, sid);
    } finally { stub.off(); await stub.close(); }
  });
});
