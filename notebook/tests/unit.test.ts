import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docToPlainText, noteSections, splitText } from "@/lib/chunk";
import { diffLines } from "@/lib/diff";
import { detectType, extract } from "@/lib/extract";
import { lectureNumbersIn, parseIntent } from "@/lib/intent";
import { mdToHtml } from "@/lib/md-html";

const fx = (f: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", f)));

describe("intent", () => {
  it("recognises recall requests", () => {
    expect(parseIntent("Recall Lecture 5.")).toEqual({ kind: "recall_lecture", numbers: [5] });
    expect(parseIntent("recall lectures 1-3")).toEqual({ kind: "recall_lecture", numbers: [1, 2, 3] });
    expect(parseIntent("Recall course")).toEqual({ kind: "recall_course" });
    expect(parseIntent("Recall the whole course")).toEqual({ kind: "recall_course" });
  });
  it("treats other questions as asks, with mentioned lectures and breadth", () => {
    expect(parseIntent("What concepts connect Lecture 3 and Lecture 5?")).toEqual({ kind: "ask", lectureNumbers: [3, 5], broad: false });
    expect(parseIntent("Recall everything we studied about processes")).toMatchObject({ kind: "ask", broad: true });
    expect(parseIntent("Explain everything from Lecture 1–6").kind).toBe("ask");
    expect(lectureNumbersIn("Explain everything from Lecture 1–6")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lectureNumbersIn("lectures 2, 4 and 7")).toEqual([2, 4, 7]);
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
