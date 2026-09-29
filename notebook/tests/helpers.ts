import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://nb:nb@localhost:5432/notebook_test";

/** Must run before importing app modules. Default mode: no LLM, no embeddings (search-only). */
export function testEnv() {
  process.env.DATABASE_URL = TEST_DB;
  process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "nb-store-"));
  for (const k of ["LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];
}

export const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", name)));

export async function app() {
  const db = await import("@/lib/db");
  const repo = await import("@/lib/repo");
  const ingest = await import("@/lib/ingest");
  const jobs = await import("@/lib/jobs");
  const storage = await import("@/lib/storage");
  const worker = await import("@/lib/worker");
  worker.registerJobs();

  /** Runs every queued job now (ignoring debounce delays) until the queue is empty. */
  async function flushJobs() {
    for (let i = 0; i < 20; i++) {
      await db.q("UPDATE jobs SET run_after = now() WHERE status = 'pending'");
      const n = await jobs.drain();
      const left = await db.q1<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE status = 'pending'");
      if (!n && !left?.n) return;
    }
  }
  async function user() {
    return (await db.q1<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [`${randomUUID()}@t.dev`]))!.id;
  }
  async function upload(courseId: string, lectureId: string | null, file: string, kind: string) {
    const bytes = fixture(file);
    const ext = file.split(".").pop()!;
    const key = `${courseId}/${randomUUID()}.${ext}`;
    await storage.put(key, bytes);
    const m = await repo.createMaterial({ course_id: courseId, lecture_id: lectureId, kind, filename: path.basename(file), mime: "application/octet-stream", size_bytes: bytes.length, storage_key: key });
    await ingest.queueMaterial(m.id, courseId);
    return m.id;
  }
  return { db, repo, ingest, jobs, storage, flushJobs, user, upload };
}

export type Doc = { type: "doc"; content: unknown[] };
export const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
export const h2 = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
export const sketch = (caption: string) => ({ type: "sketch", attrs: { caption, height: 300, shapes: [{ id: "s1", t: "pen", c: "currentColor", w: 2, p: [10, 10, 50, 60, 90, 20] }] } });

/**
 * Test double speaking the Ollama chat API. Records every request and answers with `respond(prompt)`.
 * Used to verify prompt construction, context budgets and citation handling deterministically.
 */
export async function stubOllama(respond: (system: string, user: string) => string, contextLength = 4096) {
  const calls: { system: string; user: string; numCtx: number }[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "stub-llm:latest", model: "stub-llm:latest" }] }));
      if (req.url === "/api/show") return res.end(JSON.stringify({ model_info: { "stub.context_length": contextLength } }));
      if (req.url === "/api/chat") {
        const body = JSON.parse(b) as { messages: { role: string; content: string }[]; options: { num_ctx: number } };
        const system = body.messages.find((m) => m.role === "system")?.content ?? "";
        const user = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        calls.push({ system, user, numCtx: body.options.num_ctx });
        return res.end(JSON.stringify({ message: { role: "assistant", content: respond(system, user) } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    calls,
    url,
    use() { Object.assign(process.env, { LLM_PROVIDER: "ollama", LLM_BASE_URL: url, LLM_MODEL: "stub-llm" }); },
    off() { delete process.env.LLM_PROVIDER; delete process.env.LLM_MODEL; delete process.env.LLM_BASE_URL; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
