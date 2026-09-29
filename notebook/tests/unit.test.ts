import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docToPlainText, noteSections, splitText } from "@/lib/chunk";
import { diffLines } from "@/lib/diff";
import { detectType, extract } from "@/lib/extract";
import { extractAliases } from "@/lib/aliases";
import { notePieces } from "@/lib/chunk";
import { candidatesFrom } from "@/lib/concepts";
import { buildSources, dedupe, stripCitations, toUnits, validateCitations } from "@/lib/context";
import { lectureNumbersIn, route } from "@/lib/intent";
import { normConcept } from "@/lib/query";
import type { Hit } from "@/lib/search";
import { mdToHtml } from "@/lib/md-html";

const fx = (f: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", f)));

describe("intent routing", () => {
  const k = (q: string) => route(q).intent;
  it("routes recall requests", () => {
    expect(k("Recall Lecture 5.")).toEqual({ kind: "recall_lecture", numbers: [5] });
    expect(k("recall lectures 1-3")).toEqual({ kind: "recall_lecture", numbers: [1, 2, 3] });
    expect(k("Explain everything from Lecture 1–6")).toEqual({ kind: "recall_lecture", numbers: [1, 2, 3, 4, 5, 6] });
    expect(k("Recall course")).toEqual({ kind: "recall_course" });
    expect(k("Recall the whole course")).toEqual({ kind: "recall_course" });
  });
  it("routes topic aggregation, source lookup, comparison, cross-lecture, exam and definitions", () => {
    expect(k("Recall everything we learned about process scheduling")).toEqual({ kind: "topic", topic: "process scheduling", focus: "all" });
    expect(k("Everything about deadlocks.")).toEqual({ kind: "topic", topic: "deadlocks", focus: "all" });
    expect(k("What did we study about processes?")).toEqual({ kind: "topic", topic: "processes", focus: "all" });
    expect(k("Give me everything the teacher has taught about processes")).toMatchObject({ kind: "topic", topic: "processes" });
    expect(k("Find all examples related to semaphores")).toEqual({ kind: "topic", topic: "semaphores", focus: "examples" });
    expect(k("How did the explanation of processes develop throughout the course?")).toEqual({ kind: "topic", topic: "processes", focus: "development" });
    expect(k("Where did we study PCB?")).toEqual({ kind: "source_lookup", topic: "PCB", first: false });
    expect(k("Where was virtual memory first introduced?")).toEqual({ kind: "source_lookup", topic: "virtual memory", first: true });
    expect(k("Show every lecture where scheduling appears")).toEqual({ kind: "source_lookup", topic: "scheduling", first: false });
    expect(k("Difference between process and thread")).toEqual({ kind: "comparison", subjects: ["process", "thread"] });
    expect(k("microkernel vs monolithic kernel")).toEqual({ kind: "comparison", subjects: ["microkernel", "monolithic kernel"] });
    expect(k("Connect lecture 4 and 7")).toEqual({ kind: "cross_lecture", numbers: [4, 7], topic: null });
    expect(k("What did Lecture 3 and Lecture 8 both say about memory?")).toEqual({ kind: "cross_lecture", numbers: [3, 8], topic: "memory" });
    expect(k("What should I revise about CPU scheduling?")).toEqual({ kind: "exam_revision", topic: "CPU scheduling" });
    expect(k("What is PCB?")).toEqual({ kind: "definition", topic: "PCB" });
    expect(k("What is the difference between a process and a program?")).toMatchObject({ kind: "comparison" });
  });
  it("detects source hints and lecture numbers", () => {
    expect(route("what did sir say about scheduling").hint).toBe("teacher");
    expect(route("what is in my notes about threads").hint).toBe("notes");
    expect(lectureNumbersIn("lectures 2, 4 and 7")).toEqual([2, 4, 7]);
  });
});

describe("abbreviations and concepts", () => {
  it("extracts only abbreviations whose initials match", () => {
    expect(extractAliases("Process Control Block (PCB)")).toEqual([{ alias: "pcb", expansion: "process control block" }]);
    expect(extractAliases("First-Come, First-Served (FCFS) Scheduling")).toEqual([{ alias: "fcfs", expansion: "first-come first-served" }]);
    expect(extractAliases("The PCB is also called task control block.")).toEqual([{ alias: "pcb", expansion: "task control block" }]);
    expect(extractAliases("We met in the lab (Tuesday)")).toEqual([]);
    expect(extractAliases("Operating systems (OS) are fun")).toEqual([{ alias: "os", expansion: "operating systems" }]);
  });
  it("finds concept candidates from titles and definitions, skipping generic titles", () => {
    const c = (section: string | null, text: string) => candidatesFrom({ section, text, content_type: "slide", source_type: "material" }).map((x) => x.norm);
    expect(c("Process Control Block (PCB)", "Each process is represented")).toEqual(["process control block"]);
    expect(c("Introduction to Operating Systems", "")).toEqual(["operating system"]);
    expect(c("Summary", "Stack: temporary data storage when invoking functions")).toEqual(["stack"]);
    expect(c("Types of System Calls", "A thread is a basic unit of CPU utilization")).toEqual(["system call", "thread"]);
    expect(normConcept("Policies")).toBe("policy");
  });
});

describe("context construction & citations", () => {
  const hit = (id: string, lec: number, page: number, text: string, score: number, extra: Partial<Hit> = {}): Hit => ({
    chunk_id: id, course_id: "c", lecture_id: `L${lec}`, lecture_number: lec, lecture_title: `T${lec}`, lecture_position: lec,
    material_id: `m${lec}`, note_id: null, source_type: "material", source_kind: "slides", content_type: "slide", filename: `l${lec}.pptx`,
    page_no: page, slide_no: page, section: `S${page}`, anchor: null, content: text, score, methods: ["keyword"], method_scores: {}, ...extra,
  });
  const label = (h: Hit) => `L${h.lecture_number} · Slide ${h.page_no}`;
  it("merges chunks of one slide, dedupes recap slides, keeps lecture diversity and orders chronologically", () => {
    const units = toUnits([
      hit("a", 7, 3, "Round robin uses a time quantum of ten to one hundred ms", 0.9),
      hit("b", 7, 3, "after the quantum the process is preempted", 0.5),
      hit("c", 9, 1, "Round robin uses a time quantum of ten to one hundred ms\nafter the quantum the process is preempted", 0.4),
      hit("d", 7, 4, "priority scheduling can starve", 0.8),
      hit("e", 2, 2, "scheduling is mentioned in the outline", 0.2),
    ], label);
    expect(units).toHaveLength(4);
    const d = dedupe(units);
    expect(d).toHaveLength(3);
    expect(d.find((u) => u.chunkIds.includes("a"))!.alsoIn).toEqual(["L9 · Slide 1"]);
    const s = buildSources(d, { budgetTokens: 10_000, order: "chronological", perLecture: 1 });
    expect(s.map((x) => x.label)).toEqual(["L2 · Slide 2", "L7 · Slide 3", "L7 · Slide 4"]);
    expect(s.map((x) => x.n)).toEqual([1, 2, 3]);
    const tight = buildSources(d, { budgetTokens: 60, order: "relevance", perLecture: 1 });
    expect(tight.length).toBeLessThan(3);
    expect(new Set(tight.map((x) => x.lectureNumber)).size).toBe(tight.length); // diversity first
  });
  it("removes citations to sources that do not exist", () => {
    const v = validateCitations("A [1]. B [7]. C [2, 9]. D [L3] and [L99].", 2, [1, 2, 3]);
    expect(v.text).toBe("A [1]. B. C [2]. D [L3] and.");
    expect(v.cited).toEqual([1, 2]);
    expect(v.invalid).toEqual(["7", "9", "[L99]"]);
    expect(stripCitations("General [1] idea [L2].")).toBe("General idea.");
  });
});

describe("note pieces", () => {
  it("separates typed notes, drawings (by caption) and AI inserts, with anchors", () => {
    const doc = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "States" }] },
      { type: "paragraph", content: [{ type: "text", text: "Mnemonic: Never Really Run While Tired" }] },
      { type: "sketch", attrs: { caption: "process state diagram", shapes: [] } },
      { type: "sketch", attrs: { caption: "", shapes: [] } },
      { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "AI · Revision notes" }] }, { type: "paragraph", content: [{ type: "text", text: "Processes have states" }] }] },
    ] };
    expect(notePieces(doc)).toEqual([
      { section: "States", text: "Mnemonic: Never Really Run While Tired", contentType: "note", sourceKind: "student_notes", anchor: "Mnemonic: Never Really Run While Tired" },
      { section: "States", text: "Drawing: process state diagram", contentType: "drawing", sourceKind: "student_notes", anchor: "process state diagram" },
      { section: "States", text: "AI · Revision notes\nProcesses have states", contentType: "ai_note", sourceKind: "ai_note", anchor: "Processes have states" },
    ]);
  });
});

describe("chunking", () => {
  it("keeps short text whole and splits long text with bounded size", () => {
    expect(splitText("hello")).toEqual(["hello"]);
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(20)).join("\n\n");
    const parts = splitText(long);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1400);
    expect(parts.join(" ")).toContain("Paragraph 59");
  });
  it("sections a Tiptap doc by heading and includes lists, math and drawings", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Process states" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Ready" }] }] }] },
        { type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "x^2" } }] },
        { type: "sketch", attrs: { caption: "state diagram", shapes: [] } },
      ],
    };
    expect(noteSections(doc)).toEqual([
      { section: null, text: "Intro" },
      { section: "Process states", text: "- Ready\n$x^2$\n[Drawing: state diagram]" },
    ]);
    expect(docToPlainText(doc)).toContain("# Process states");
  });
});

describe("extraction", () => {
  it("validates file signatures, not just extensions", () => {
    expect(detectType("a.pdf", fx("syllabus.pdf"))).toBe("pdf");
    expect(detectType("a.pptx", fx("lecture01.pptx"))).toBe("pptx");
    expect(detectType("fake.pdf", fx("lecture01.pptx"))).toBeNull();
    expect(detectType("x.exe", fx("syllabus.pdf"))).toBeNull();
    expect(detectType("n.md", new TextEncoder().encode("# hi"))).toBe("md");
    expect(detectType("n.txt", new Uint8Array([0x61, 0, 0x62]))).toBeNull();
  });
  it("extracts PPTX slide titles, bullets (with levels) and speaker notes in order", async () => {
    const pages = await extract("pptx", fx("lecture01.pptx"));
    expect(pages.map((p) => p.title)).toEqual(["Processes", "Process Memory Layout", "Process States", "Process Control Block"]);
    expect(pages[1]!.body).toContain("Stack: temporary data used when invoking functions");
    expect(pages[2]!.body).toMatch(/\n\s+Only one process/);
    expect(pages[0]!.speakerNotes).toBe("Emphasise: exam question every year");
    expect(pages[1]!.speakerNotes).toBeNull();
  });
  it("extracts PDF text per page", async () => {
    const pages = await extract("pdf", fx("syllabus.pdf"));
    expect(pages).toHaveLength(2);
    expect(pages[1]!.body).toContain("Round Robin");
    expect(pages[1]!.pageNo).toBe(2);
  });
  it("splits Markdown by top-level sections", async () => {
    const pages = await extract("md", new TextEncoder().encode("# A\none\n```\n# not a heading\n```\n## B\ntwo"));
    expect(pages.map((p) => p.title)).toEqual(["A", "B"]);
  });
});

describe("markdown → editor HTML", () => {
  it("escapes HTML in AI output", () => {
    const html = mdToHtml("## T\n- <script>alert(1)</script> **b**\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>b</strong>");
  });
});

describe("diff", () => {
  it("produces a line diff", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { op: "same", text: "a" }, { op: "del", text: "b" }, { op: "same", text: "c" }, { op: "add", text: "d" },
    ]);
  });
});
