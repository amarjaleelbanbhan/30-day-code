// Local OCR for image uploads and scanned PDFs (real Tesseract; test images are generated, so no binary fixtures).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrate";
import { extract } from "@/lib/extract";
import { app, TEST_DB, testEnv } from "./helpers";
import { scannedPdf, textImage } from "./support/scans";

testEnv();
const A = await app();
const { search } = await import("@/lib/search");

const LINES = ["Deadlock requires four conditions", "Mutual exclusion and hold and wait", "Circular wait and no preemption"];

describe("extraction", () => {
  it("reads printed text from an image", async () => {
    const pages = await extract("png", textImage(LINES).bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body.toLowerCase()).toContain("deadlock requires four conditions");
    expect(pages[0]!.title).toBeNull(); // OCR'd first lines are not trusted as titles
  }, 60_000);

  it("reads a JPEG too", async () => {
    const pages = await extract("jpg", textImage(LINES, "image/jpeg").bytes);
    expect(pages[0]?.body.toLowerCase()).toContain("mutual exclusion");
  }, 60_000);

  it("indexes nothing for a blank or unreadable image (no garbage in search)", async () => {
    const blank = textImage([]);
    expect(await extract("png", blank.bytes)).toEqual([]);
  }, 60_000);

  it("OCRs only the pages of a PDF that have no text layer", async () => {
    const pdf = scannedPdf([textImage(LINES.slice(0, 2), "image/jpeg"), textImage(["Scheduling decides which process runs next", "Round robin gives each process a time slice"], "image/jpeg")]);
    const pages = await extract("pdf", pdf);
    expect(pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(pages[0]!.body.toLowerCase()).toContain("deadlock");
    expect(pages[1]!.body.toLowerCase()).toContain("round robin");
  }, 90_000);

  it("keeps a real text layer untouched (no OCR, titles preserved)", async () => {
    const { readFileSync } = await import("node:fs");
    const pages = await extract("pdf", new Uint8Array(readFileSync(new URL("./fixtures/os/os-textbook.pdf", import.meta.url))));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.some((p) => p.title)).toBe(true);
  }, 60_000);
});

describe("end to end: upload → job → search → citation", () => {
  let userId: string, courseId: string, lectureId: string;
  beforeAll(async () => {
    await migrate(TEST_DB);
    userId = await A.user();
    courseId = (await A.repo.createCourse(userId, { name: "Operating Systems", code: null, instructor: null, semester: null, description: null })).id;
    lectureId = (await A.repo.createLecture(userId, courseId, { number: 8, title: "Deadlocks", lectureDate: null }))!.id;
  }, 60_000);
  afterAll(async () => { await A.db.q("DELETE FROM users WHERE id = $1", [userId]); await A.db.pool().end(); });

  async function put(filename: string, bytes: Uint8Array, kind: string) {
    const ext = filename.split(".").pop()!;
    const key = `${courseId}/${crypto.randomUUID()}.${ext}`;
    await A.storage.put(key, bytes);
    const m = await A.repo.createMaterial({ course_id: courseId, lecture_id: lectureId, kind, filename, mime: "x", size_bytes: bytes.length, storage_key: key });
    await A.ingest.queueMaterial(m.id, courseId);
    return m.id;
  }

  it("a photographed slide becomes searchable, cited course memory", async () => {
    const id = await put("whiteboard.png", textImage(LINES).bytes, "image");
    await A.flushJobs();
    const m = await A.db.q1<{ status: string; page_count: number }>("SELECT status, page_count FROM materials WHERE id = $1", [id]);
    expect(m).toMatchObject({ status: "ready", page_count: 1 });
    const r = await search(userId, courseId, "what are the conditions for deadlock", { limit: 5 });
    const top = r.hits[0]!;
    expect(top.material_id).toBe(id);
    expect(top.lecture_number).toBe(8);
    expect(top.content.toLowerCase()).toContain("mutual exclusion");
  }, 120_000);

  it("a scanned PDF becomes searchable with the right page", async () => {
    const pdf = scannedPdf([textImage(["Introduction to paging"], "image/jpeg"), textImage(["The translation lookaside buffer caches page table entries"], "image/jpeg")]);
    const id = await put("handout.pdf", pdf, "other");
    await A.flushJobs();
    const r = await search(userId, courseId, "translation lookaside buffer", { limit: 5 });
    expect(r.hits[0]).toMatchObject({ material_id: id, page_no: 2 });
  }, 120_000);
});
