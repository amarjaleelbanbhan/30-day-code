// Runs against a real PostgreSQL (TEST_DATABASE_URL, default: local notebook_test) with pgvector + pg_trgm.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrate";

const url = process.env.TEST_DATABASE_URL ?? "postgres://nb:nb@localhost:5432/notebook_test";
process.env.DATABASE_URL = url;
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "nb-store-"));
delete process.env.EMBEDDING_BASE_URL;
delete process.env.LLM_PROVIDER;

const { pool, q1 } = await import("@/lib/db");
const repo = await import("@/lib/repo");
const { processMaterial, indexNote } = await import("@/lib/ingest");
const { search } = await import("@/lib/search");
const { ask } = await import("@/lib/rag");
const storage = await import("@/lib/storage");
const { sameOrigin } = await import("@/lib/api");

async function user(): Promise<string> {
  return (await q1<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [`${randomUUID()}@t.dev`]))!.id;
}

let alice: string, bob: string, courseId: string, lectureId: string, materialId: string;

beforeAll(async () => {
  await migrate(url);
  alice = await user();
  bob = await user();
  courseId = (await repo.createCourse(alice, { name: "Operating Systems", code: null, instructor: null, semester: null, description: null })).id;
  lectureId = (await repo.createLecture(alice, courseId, { number: null, title: "Processes", lectureDate: null }))!.id;
  const key = `${courseId}/${randomUUID()}.pptx`;
  const bytes = new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "lecture01.pptx")));
  await storage.put(key, bytes);
  const m = await repo.createMaterial({ course_id: courseId, lecture_id: lectureId, kind: "slides", filename: "lecture01.pptx", mime: "x", size_bytes: bytes.length, storage_key: key });
  materialId = m.id;
  await processMaterial(m.id);
});

afterAll(async () => {
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
  await pool().end();
});

describe("authorization boundaries", () => {
  it("hides one user's data from another", async () => {
    expect(await repo.getCourse(bob, courseId)).toBeNull();
    expect(await repo.listLectures(bob, courseId)).toEqual([]);
    expect(await repo.getLecture(bob, lectureId)).toBeNull();
    expect(await repo.getOrCreateNote(bob, lectureId)).toBeNull();
    expect(await repo.saveNote(bob, lectureId, { type: "doc", content: [] }, "")).toBeNull();
    expect(await repo.getMaterial(bob, materialId)).toBeNull();
    expect(await repo.createLecture(bob, courseId, { number: 9, title: "x", lectureDate: null })).toBeNull();
    expect(await repo.updateCourse(bob, courseId, { name: "pwned", code: null, instructor: null, semester: null, description: null })).toBeNull();
    expect(await repo.deleteLecture(bob, lectureId)).toBe(false);
    expect(await repo.deleteCourse(bob, courseId)).toBe(false);
    expect(await repo.reorderLectures(bob, courseId, [lectureId])).toBe(false);
    expect(await repo.deleteMaterial(bob, materialId)).toBeNull();
    expect((await search(bob, courseId, "process")).hits).toEqual([]);
  });
  it("rejects cross-origin mutations", () => {
    const mk = (origin: string | null, method = "POST") =>
      new NextRequest("http://app.test/api/courses", { method, headers: { host: "app.test", ...(origin ? { origin } : {}) } });
    expect(sameOrigin(mk("http://app.test"))).toBe(true);
    expect(sameOrigin(mk("http://evil.test"))).toBe(false);
    expect(sameOrigin(mk(null))).toBe(false);
    expect(sameOrigin(mk(null, "GET"))).toBe(true);
  });
});

describe("course memory", () => {
  it("indexes slides with page numbers and speaker notes", async () => {
    const m = await repo.getMaterial(alice, materialId);
    expect(m).toMatchObject({ status: "ready", page_count: 4 });
    const pages = await repo.getPages(materialId);
    expect(pages[2]).toMatchObject({ page_no: 3, title: "Process States", speaker_notes: "Draw the state diagram on the board" });
  });

  it("finds material by meaning-bearing keywords and fuzzy matches, with citations", async () => {
    const { hits } = await search(alice, courseId, "memory used when function runs");
    expect(hits[0]).toMatchObject({ page_no: 2, section: "Process Memory Layout", lecture_number: 1, filename: "lecture01.pptx" });
    const { hits: fuzzy } = await search(alice, courseId, "proces controll blok");
    expect(fuzzy.some((h) => h.section === "Process Control Block")).toBe(true);
  });

  it("autosaves notes, snapshots history, indexes notes, and restores versions", async () => {
    const doc = (t: string) => ({ type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Semaphores" }] },
      { type: "paragraph", content: [{ type: "text", text: t }] },
    ] });
    const s1 = await repo.saveNote(alice, lectureId, doc("wait and signal operations"), "v1");
    await indexNote(s1!.noteId);
    const { hits } = await search(alice, courseId, "where did we study semaphores");
    expect(hits[0]).toMatchObject({ source_type: "note", section: "Semaphores" });

    await repo.saveNote(alice, lectureId, doc("changed by AI"), "v2", "ai");
    const versions = await repo.listVersions(alice, lectureId);
    expect(versions[0]).toMatchObject({ reason: "before ai", plain_text: "v1" });
    expect(await repo.listVersions(bob, lectureId)).toEqual([]);
    await repo.restoreVersion(alice, lectureId, versions[0]!.id);
    expect((await repo.getOrCreateNote(alice, lectureId))!.plain_text).toBe("v1");
  });

  it("recalls a lecture with an outline and cited sources (retrieval mode without an LLM)", async () => {
    const r = await ask(alice, courseId, "Recall lecture 1");
    expect(r.mode).toBe("retrieval");
    expect(r.title).toBe("Lecture 01 — Processes");
    expect(r.outline![0]!.topics.map((t) => t.title)).toEqual(expect.arrayContaining(["Processes", "Process States", "Semaphores"]));
    expect(r.sources.some((s) => s.label.startsWith("Lecture 01 · Slide 3"))).toBe(true);
  });

  it("says when something is not in the course material", async () => {
    const r = await ask(alice, courseId, "quantum chromodynamics gluon");
    expect(r.notFound).toBe(true);
    expect(r.answer).toBe("This was not found in your uploaded course material.");
  });

  it("reorders lectures", async () => {
    const l2 = (await repo.createLecture(alice, courseId, { number: null, title: "Threads", lectureDate: null }))!;
    expect(l2.number).toBe(2);
    await repo.reorderLectures(alice, courseId, [l2.id, lectureId]);
    expect((await repo.listLectures(alice, courseId)).map((l) => l.title)).toEqual(["Threads", "Processes"]);
  });
});

describe("LLM path (OpenAI-compatible stub server)", () => {
  it("sends numbered sources and returns a cited answer", async () => {
    const http = await import("node:http");
    let prompt = "";
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        prompt = (JSON.parse(b) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "**From course material**\nA process is a program in execution [1]." } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    Object.assign(process.env, { LLM_PROVIDER: "openai", LLM_MODEL: "stub", LLM_API_KEY: "test", LLM_BASE_URL: `http://127.0.0.1:${port}` });
    try {
      const r = await ask(alice, courseId, "What is a process?");
      expect(r.mode).toBe("answer");
      expect(r.answer).toContain("[1]");
      expect(prompt).toMatch(/\[1\] Lecture 01 · Slide \d/);
      expect(prompt).toContain("do not use outside knowledge");
    } finally {
      delete process.env.LLM_PROVIDER;
      server.close();
    }
  });
});
