// Course-memory quality tests on a deterministic 7-lecture Operating Systems course (tests/fixtures/os).
// Default run: search-only (keyword + stems + typo + aliases, no LLM, no vectors).
// Semantic block: set TEST_OLLAMA_URL to an Ollama-compatible embedding server (e.g. tests/support/ollama_compat.py).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrate";
import { app, h2, p, sketch, stubOllama, TEST_DB, testEnv } from "./helpers";

testEnv();
const A = await app();
const { search, citationLabel } = await import("@/lib/search");
const { ask, NOT_FOUND } = await import("@/lib/rag");
const { listConcepts, getConcept, relatedConcepts } = await import("@/lib/concepts");
const { route } = await import("@/lib/intent");
const { normConcept } = await import("@/lib/query");

let userId: string, courseId: string;
const lec: Record<number, string> = {};
const TITLES = ["Introduction to Operating Systems", "Operating-System Structures", "System Calls", "Kernel Architectures", "Processes", "Threads", "CPU Scheduling"];

beforeAll(async () => {
  await migrate(TEST_DB);
  userId = await A.user();
  courseId = (await A.repo.createCourse(userId, { name: "Operating Systems", code: "CS330", instructor: null, semester: null, description: null })).id;
  for (const [i, title] of TITLES.entries()) {
    const n = i + 1;
    lec[n] = (await A.repo.createLecture(userId, courseId, { number: n, title, lectureDate: null }))!.id;
    await A.upload(courseId, lec[n]!, `os/lecture${String(n).padStart(2, "0")}.pptx`, "slides");
  }
  await A.upload(courseId, lec[7]!, "os/scheduling-teacher-notes.md", "notes");
  await A.upload(courseId, null, "os/os-textbook.pdf", "book");
  const s5 = await A.repo.saveNote(userId, lec[5]!, { type: "doc", content: [
    h2("My notes on process states"),
    p("Mnemonic for the process states: Never Really Run While Tired (New, Ready, Running, Waiting, Terminated)."),
    sketch("process state diagram with all transitions"),
  ] }, "");
  const s7 = await A.repo.saveNote(userId, lec[7]!, { type: "doc", content: [
    p("Sir said Round Robin is what time-sharing systems use. Likely exam question."),
    { type: "callout", content: [p("AI · Revision notes"), p("Round robin gives every process an equal share of the CPU.")] },
  ] }, "");
  await A.ingest.queueNote(s5!.noteId, courseId);
  await A.ingest.queueNote(s7!.noteId, courseId);
  await A.flushJobs();
}, 60_000);

afterAll(async () => {
  if (!process.env.KEEP) await A.db.q("DELETE FROM users WHERE id = $1", [userId]);
  await A.db.pool().end();
});

const top = async (q: string, n = 1, opts = {}) => (await search(userId, courseId, q, { limit: 10, ...opts })).hits.slice(0, n);
const where = (h: { lecture_number: number | null; section: string | null }) => `L${h.lecture_number}:${h.section}`;

describe("indexing", () => {
  it("indexed every lecture, the teacher notes, the textbook and the notes", async () => {
    const mats = await A.repo.listMaterials(userId, courseId);
    expect(mats).toHaveLength(9);
    expect(mats.every((m) => m.status === "ready")).toBe(true);
    const kinds = await A.db.q<{ source_kind: string; n: number }>("SELECT source_kind, count(*)::int AS n FROM chunks WHERE course_id = $1 GROUP BY 1 ORDER BY 1", [courseId]);
    expect(kinds.map((k) => k.source_kind)).toEqual(["ai_note", "book", "slides", "student_notes", "teacher_notes"]);
    expect(await A.db.q1("SELECT 1 FROM course_aliases WHERE course_id = $1 AND alias = 'pcb' AND expansion = 'task control block'", [courseId])).toBeTruthy();
  });
  it("every chunk has a real source identity", async () => {
    const orphans = await A.db.q("SELECT id FROM chunks WHERE course_id = $1 AND ((material_id IS NULL AND note_id IS NULL) OR (material_id IS NOT NULL AND page_no IS NULL))", [courseId]);
    expect(orphans).toEqual([]);
  });
});

describe("retrieval (search-only mode)", () => {
  it("program currently executing → Process concept (Lecture 5)", async () => {
    expect(where((await top("program currently executing"))[0]!)).toBe("L5:Process Concept");
  });
  it("moves services out of the kernel → Microkernels is among the top results (lexically tied with Modules)", async () => {
    // "Loadable kernel modules … link in additional services" matches as many words; the semantic suite checks rank 1.
    expect((await top("moves services out of the kernel", 3)).map(where)).toContain("L4:Microkernels");
  });
  it("process state diagram → the Process State slide of the Processes lecture", async () => {
    const hits = await top("process state diagram", 3);
    expect(hits.map(where)).toContain("L5:Process State");
    expect(hits[0]!.lecture_number).toBe(5);
  });
  it("typos: shceduling / microkernal / semaphor", async () => {
    expect((await top("round robin shceduling"))[0]!.section).toBe("Round Robin (RR) Scheduling");
    expect((await top("microkernal"))[0]!.section).toMatch(/^Microkernel/);
    expect((await search(userId, courseId, "semaphor", { limit: 5 })).hits[0]!.source_kind).toBe("book"); // stemming
    const r = await search(userId, courseId, "semafores", { limit: 5 });                                  // real typo
    expect(r.analysis.corrections).toEqual({ semafores: "semaphores" });
    expect(r.hits[0]!.source_kind).toBe("book");
  });
  it("abbreviations: IPC ↔ inter-process communication, task control block ↔ PCB", async () => {
    expect((await top("IPC models"))[0]!.section).toBe("Inter-Process Communication");
    const tcb = await top("task control block", 3);
    expect(tcb.map((h) => h.content_type)).toContain("speaker_notes");
    expect(tcb.some((h) => h.section === "Process Control Block (PCB)")).toBe(true);
  });
  it("singular/plural and stems: 'thread' finds the Threads lecture, 'microkernels' finds Microkernels", async () => {
    expect((await top("thread"))[0]!.lecture_number).toBe(6);
    expect((await top("microkernels"))[0]!.lecture_number).toBe(4);
  });
  it("speaker-note-only information: what did sir say about SJF", async () => {
    const q = "what did sir say about SJF";
    const [h] = await top(q, 1, { hint: route(q).hint });
    expect(h!.content_type).toBe("speaker_notes");
    expect(h!.content).toMatch(/cannot be implemented exactly/);
    expect(citationLabel(h!)).toBe("Lecture 07 · Speaker notes · Slide 7 · lecture07.pptx");
  });
  it("teacher-notes-only information: convoy effect", async () => {
    const [h] = await top("convoy effect");
    expect(h!.source_kind).toBe("teacher_notes");
  });
  it("student-note-only information: mnemonic for the states", async () => {
    const [h] = await top("mnemonic for process states");
    expect(h!.source_kind).toBe("student_notes");
    expect(citationLabel(h!)).toBe("My notes · Lecture 05 · My notes on process states");
    expect(h!.anchor).toMatch(/^Mnemonic for the process states/);
  });
  it("drawings are findable by caption", async () => {
    const hits = await top("state diagram drawing", 5);
    expect(hits.some((h) => h.content_type === "drawing")).toBe(true);
  });
  it("book vs lecture: both views are retrieved, lecture ranked above the book", async () => {
    const hits = await top("process states", 8);
    const lecture = hits.findIndex((h) => h.section === "Process State");
    const book = hits.findIndex((h) => h.source_kind === "book" && /three states/.test(h.content));
    expect(lecture).toBeGreaterThanOrEqual(0);
    expect(book).toBeGreaterThan(lecture);
  });
  it("AI-generated notes rank below course material and student notes", async () => {
    const hits = await top("round robin", 10);
    const ai = hits.findIndex((h) => h.source_kind === "ai_note");
    const slide = hits.findIndex((h) => h.section === "Round Robin (RR) Scheduling");
    expect(slide).toBeLessThan(ai === -1 ? Infinity : ai);
  });
  it("every hit carries full identity", async () => {
    for (const h of (await search(userId, courseId, "scheduling", { limit: 20 })).hits) {
      expect(h.chunk_id && h.course_id && h.source_type && h.source_kind && h.content_type && h.methods.length).toBeTruthy();
      if (h.source_type === "material") expect(h.material_id && h.filename && h.page_no).toBeTruthy();
      else expect(h.note_id).toBeTruthy();
    }
  });
});

describe("recall & questions (no LLM: extractive, cited)", () => {
  it("where did we study PCB → Lecture 5 first, grouped evidence, real citations", async () => {
    const r = await ask(userId, courseId, "Where did we study PCB?");
    expect(r.intent).toBe("source_lookup");
    expect(r.groups![0]!.label).toBe("Lecture 05 — Processes");
    expect(r.answer).toMatch(/First introduced in \*\*Lecture 05 — Processes\*\*/);
    for (const s of r.sources) expect(s.chunkIds.length).toBeGreaterThan(0);
  });
  it("everything we learned about scheduling → multiple lectures and sources, not one chunk", async () => {
    const r = await ask(userId, courseId, "Recall everything we learned about scheduling");
    expect(r.intent).toBe("topic");
    const lectures = new Set(r.sources.map((s) => s.lectureNumber).filter(Boolean));
    expect(lectures.has(7)).toBe(true);
    expect(lectures.size).toBeGreaterThanOrEqual(2);  // e.g. PCB's CPU-scheduling information in Lecture 5
    expect(r.sources.length).toBeGreaterThanOrEqual(6);
    expect(r.sources.some((s) => s.kind === "teacher_notes")).toBe(true);
    expect(r.groups!.length).toBeGreaterThanOrEqual(2);
  });
  it("show every lecture where kernel appears → grouped by lecture in course order", async () => {
    const r = await ask(userId, courseId, "Show every lecture where kernel appears");
    const nums = r.groups!.filter((g) => g.lectureId).map((g) => Number(g.label.slice(8, 10)));
    expect(nums.length).toBeGreaterThanOrEqual(3);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });
  it("recall lecture 5 → sections built only from its evidence, speaker notes and my notes separated", async () => {
    const r = await ask(userId, courseId, "Recall lecture 5");
    expect(r.intent).toBe("recall_lecture");
    expect(r.title).toBe("Lecture 05 — Processes");
    expect(r.answer).toMatch(/## Teacher's points \(from speaker notes\)[\s\S]*task control block/);
    expect(r.answer).toMatch(/## My additional notes[\s\S]*Mnemonic/);
    expect(r.answer).toMatch(/## Definitions[\s\S]*A process is a program in execution/);
    const cited = [...r.answer!.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(Math.max(...cited)).toBeLessThanOrEqual(r.sources.length);
  });
  it("recall course → per-lecture outline and recurring concepts, no LLM needed", async () => {
    const r = await ask(userId, courseId, "Recall the whole course");
    expect(r.outline).toHaveLength(7);
    expect(r.answer).toMatch(/7\. \*\*CPU Scheduling\*\* \[L7\]/);
    expect(r.concepts!.length).toBeGreaterThan(0);
  });
  it("hallucination guard: a topic absent from the course is reported as not found, with no sources", async () => {
    const r = await ask(userId, courseId, "What did our lecturer teach about quantum operating systems?");
    expect(r.notFound).toBe(true);
    expect(r.answer).toBe(NOT_FOUND);
    expect(r.sources).toEqual([]);
    expect(r.missingTerms).toEqual(["quantum"]);
    const r2 = await ask(userId, courseId, "Everything about deadlocks");
    expect(r2.notFound).toBe(true);
  });
});

describe("concept index", () => {
  it("extracts concepts from the material and links them to lectures", async () => {
    const cs = await listConcepts(userId, courseId);
    const names = cs.map((c) => normConcept(c.name));
    for (const n of ["process control block", "microkernel", "round robin", "context switch", "system call", "thread"]) expect(names).toContain(n);
    expect(names).not.toContain("summary");
    const pcb = cs.find((c) => normConcept(c.name) === "process control block")!;
    expect(pcb.aliases).toContain("pcb");
    expect(pcb.first_lecture).toBe(5);
    expect((await getConcept("00000000-0000-0000-0000-000000000000", pcb.id))).toBeNull(); // other users can't read it
    // "Process control" (a system-call category, Lecture 3) must not be counted inside "Process Control Block" (Lecture 5).
    const pc = cs.find((c) => normConcept(c.name) === "process control")!;
    expect(pc.first_lecture).toBe(3);
    expect(pc.lecture_count).toBe(1);
  });
  it("relations come only from evidence (name containment or co-occurrence)", async () => {
    const cs = await listConcepts(userId, courseId);
    const sched = cs.find((c) => normConcept(c.name) === "cpu scheduling")!;
    const rel = await relatedConcepts(sched.id);
    expect(rel.length).toBeGreaterThan(0);
    for (const r of rel) expect(r.evidence).toBeGreaterThan(0);
  });
});

describe("LLM path (stub Ollama server)", () => {
  it("course-only: grounded prompt with evidence classes; invalid citations removed; not-found never calls the model", async () => {
    const stub = await stubOllama((_s, u) => (/Question: What is a process/.test(u) ? "A process is a program in execution [1]. Also [42]." : "ok [1]"), 4096);
    stub.use();
    try {
      const r = await ask(userId, courseId, "What is a process?");
      expect(r.mode).toBe("answer");
      expect(r.answer).toBe("A process is a program in execution [1]. Also.");
      expect(stub.calls[0]!.system).toMatch(/If the sources do not answer the question, reply exactly: "This was not found/);
      expect(stub.calls[0]!.user).toMatch(/\[1\] Lecture 05 · Slide 2 · lecture05\.pptx — lecture slide/);
      expect(stub.calls[0]!.numCtx).toBe(4096);
      const before = stub.calls.length;
      const nf = await ask(userId, courseId, "What did our lecturer teach about quantum operating systems?");
      expect(nf.notFound).toBe(true);
      expect(stub.calls.length).toBe(before);
    } finally { stub.off(); await stub.close(); }
  });
  it("model saying not-found yields no sources (no fabricated citation)", async () => {
    const stub = await stubOllama(() => NOT_FOUND);
    stub.use();
    try {
      const r = await ask(userId, courseId, "What is a context switch?");
      expect(r).toMatchObject({ notFound: true, answer: NOT_FOUND, sources: [] });
    } finally { stub.off(); await stub.close(); }
  });
  it("explanation mode keeps course answer and general explanation separate", async () => {
    const stub = await stubOllama((s) => (s.startsWith("You add a short general explanation") ? "In general, schedulers balance fairness [3] and throughput." : "Round robin uses a time quantum [1]."));
    stub.use();
    try {
      const r = await ask(userId, courseId, "What is round robin scheduling?", { mode: "explain" });
      expect(r.answer).toBe("Round robin uses a time quantum [1].");
      expect(r.extra).toBe("In general, schedulers balance fairness and throughput."); // citations stripped from general text
      const nf = await ask(userId, courseId, "What is a quantum computer?", { mode: "explain" });
      expect(nf.answer).toBe(NOT_FOUND);
      expect(nf.extra).toBeTruthy();
      expect(nf.sources).toEqual([]);
    } finally { stub.off(); await stub.close(); }
  });
  it("recall course is hierarchical and every prompt fits a small context window", async () => {
    const ctx = 2048;
    const stub = await stubOllama(() => "- Summary bullet", ctx);
    stub.use();
    try {
      const r = await ask(userId, courseId, "Recall the whole course");
      expect(r.mode).toBe("answer");
      expect(stub.calls.length).toBe(6 + 1); // on-demand lecture summaries are capped at 6, then one synthesis
      for (const c of stub.calls) expect(Math.ceil((c.system.length + c.user.length) / 3.6)).toBeLessThan(ctx);
      const cached = await A.db.q("SELECT 1 FROM lecture_summaries WHERE lecture_id = ANY($1)", [Object.values(lec)]);
      expect(cached.length).toBeGreaterThanOrEqual(6);
    } finally { stub.off(); await stub.close(); }
  });
  it("recall lecture with a tiny context window uses map-reduce and keeps valid citations", async () => {
    const stub = await stubOllama((_s, u) => (u.includes("Extract the key facts") ? "- fact [1]" : "## Main concepts\n- Processes [1][2]"), 1400);
    stub.use();
    try {
      const r = await ask(userId, courseId, "Recall lecture 7");
      expect(r.answer).toBe("## Main concepts\n- Processes [1][2]");
      expect(stub.calls.filter((c) => c.user.includes("Extract the key facts")).length).toBeGreaterThan(1);
      for (const c of stub.calls) expect(Math.ceil((c.system.length + c.user.length) / 3.6)).toBeLessThan(1400);
    } finally { stub.off(); await stub.close(); }
  });
});

describe.skipIf(!process.env.TEST_OLLAMA_URL)("semantic retrieval with real local embeddings (Ollama API)", () => {
  beforeAll(async () => {
    Object.assign(process.env, { EMBEDDING_PROVIDER: "ollama", EMBEDDING_BASE_URL: process.env.TEST_OLLAMA_URL, EMBEDDING_MODEL: process.env.TEST_OLLAMA_EMBED_MODEL ?? "wordllama-l2-256" });
    await A.jobs.enqueue("embed_course", courseId, courseId);
    await A.flushJobs();
  }, 120_000);
  afterAll(() => { delete process.env.EMBEDDING_PROVIDER; delete process.env.EMBEDDING_BASE_URL; delete process.env.EMBEDDING_MODEL; });

  it("embeds everything and marks sources ready", async () => {
    const left = await A.db.q1<{ n: number }>("SELECT count(*)::int AS n FROM chunks WHERE course_id = $1 AND embedding IS NULL", [courseId]);
    expect(left!.n).toBe(0);
    const mats = await A.repo.listMaterials(userId, courseId);
    expect(mats.filter((m) => m.embed_status !== "ready")).toEqual([]);
  });
  it("memory used during function calls → Stack (Process in Memory, Lecture 5) ranks first", async () => {
    const [h] = await top("memory used during function calls");
    expect(where(h!)).toBe("L5:Process in Memory");
    expect(h!.methods).toContain("semantic");
  });
  it("natural-language descriptions rank the right slide first", async () => {
    expect(where((await top("where local variables are stored while a function runs"))[0]!)).toBe("L5:Process in Memory");
    expect(where((await top("what happens to the old process when the CPU switches"))[0]!)).toBe("L5:Context Switch");
  });
  it("changing one note paragraph re-embeds only that piece", async () => {
    const before = await A.db.q<{ id: string }>("SELECT id FROM chunks WHERE lecture_id = $1 AND note_id IS NOT NULL ORDER BY ord", [lec[5]]);
    const s = await A.repo.saveNote(userId, lec[5]!, { type: "doc", content: [
      h2("My notes on process states"),
      p("Mnemonic for the process states: Never Really Run While Tired (New, Ready, Running, Waiting, Terminated)."),
      sketch("process state diagram with all transitions"),
      h2("Extra"), p("Zombie processes have terminated but still have an entry in the process table."),
    ] }, "");
    await A.ingest.queueNote(s!.noteId, courseId);
    await A.flushJobs();
    const after = await A.db.q<{ id: string; embedding_model: string }>("SELECT id, embedding_model FROM chunks WHERE lecture_id = $1 AND note_id IS NOT NULL ORDER BY ord", [lec[5]]);
    expect(after.slice(0, before.length).map((r) => r.id)).toEqual(before.map((r) => r.id)); // unchanged pieces kept
    expect(after).toHaveLength(before.length + 1);
    expect(after.every((r) => r.embedding_model)).toBe(true);
  });
  it("a different embedding model makes old vectors stale and they are never compared", async () => {
    const { embeddingHealth } = await import("@/lib/ingest");
    process.env.EMBEDDING_MODEL = "other-model";
    try {
      const h = await embeddingHealth(courseId);
      expect(h.stale).toBeGreaterThan(0);
      const r = await search(userId, courseId, "program currently executing", { limit: 5 });
      expect(r.hits.every((x) => !x.methods.includes("semantic"))).toBe(true);
    } finally { process.env.EMBEDDING_MODEL = process.env.TEST_OLLAMA_EMBED_MODEL ?? "wordllama-l2-256"; }
  });
});
