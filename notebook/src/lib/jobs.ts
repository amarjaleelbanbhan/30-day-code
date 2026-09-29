import "server-only";
// Postgres-backed background job queue. Extraction, note indexing, embeddings, concept index and lecture summaries
// run here — never in the request path — so writing notes is never blocked by AI or parsing.
// Jobs survive restarts, are de-duplicated per (kind, target), debounced via run_after, and retryable.
import { q, q1 } from "./db";

export type JobKind = "extract_material" | "index_note" | "embed_course" | "build_concepts" | "summarize_lecture";
type Job = { id: string; kind: JobKind; target_id: string; course_id: string | null; attempts: number };
type Handler = (job: Job) => Promise<void>;

const MAX_ATTEMPTS = 3;
// Shared across module instances: in a Next.js server build the instrumentation hook and route handlers can load
// separate copies of this module, so the registry and hook must live on globalThis.
const reg = globalThis as unknown as { __nbJobHandlers?: Map<JobKind, Handler>; __nbJobFailureHook?: (job: Job, msg: string) => Promise<void> };
const handlers = (reg.__nbJobHandlers ??= new Map<JobKind, Handler>());
export const registerHandler = (kind: JobKind, h: Handler) => handlers.set(kind, h);

/** Enqueue (or re-arm) a job. A pending/failed job for the same target is reset and its run time pushed out (debounce). */
export async function enqueue(kind: JobKind, targetId: string, courseId: string | null, delayMs = 0): Promise<void> {
  await q(
    `INSERT INTO jobs (kind, target_id, course_id, run_after) VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
     ON CONFLICT (kind, target_id) WHERE status IN ('pending','failed')
     DO UPDATE SET status = 'pending', error = NULL, attempts = 0, run_after = excluded.run_after`,
    [kind, targetId, courseId, String(delayMs)]);
  wake();
}

async function claim(): Promise<Job | null> {
  return q1<Job>(
    `UPDATE jobs SET status = 'processing', locked_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_after <= now() ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind, target_id, course_id, attempts`);
}

async function runOne(): Promise<boolean> {
  if (!handlers.size) return false; // not registered in this process yet — leave jobs pending instead of failing them
  const job = await claim();
  if (!job) return false;
  const h = handlers.get(job.kind);
  try {
    if (!h) throw new Error(`No handler for ${job.kind}`);
    await h(job);
    await q("DELETE FROM jobs WHERE id = $1", [job.id]);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
    console.error(`[jobs] ${job.kind} ${job.target_id} failed (attempt ${job.attempts})`, msg);
    const retry = job.attempts < MAX_ATTEMPTS;
    // If a newer pending job for the same target exists, drop this one instead of violating the unique index.
    await q(
      `UPDATE jobs SET status = CASE WHEN $3 THEN 'pending' ELSE 'failed' END, error = $2, locked_at = NULL,
         run_after = now() + (power(4, attempts) || ' seconds')::interval
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = jobs.kind AND j.target_id = jobs.target_id AND j.id <> jobs.id AND j.status IN ('pending','failed'))`,
      [job.id, msg, retry]);
    await q("DELETE FROM jobs WHERE id = $1 AND status = 'processing'", [job.id]);
    if (!retry) await onFinalFailure(job, msg);
  }
  return true;
}

export const setFinalFailureHook = (fn: (job: Job, msg: string) => Promise<void>) => { reg.__nbJobFailureHook = fn; };
const onFinalFailure = (job: Job, msg: string) => (reg.__nbJobFailureHook?.(job, msg) ?? Promise.resolve()).catch((e) => console.error(e));

/** Runs due jobs until none are left (used by tests and scripts). */
export async function drain(maxJobs = 10_000): Promise<number> {
  let n = 0;
  while (n < maxJobs && (await runOne())) n++;
  return n;
}

// ---------------- in-process worker ----------------
const g = globalThis as unknown as { __nbWorker?: { running: boolean; timer?: ReturnType<typeof setTimeout>; busy: boolean } };

export function wake(): void {
  const w = g.__nbWorker;
  if (!w?.running || w.busy) return;
  if (w.timer) clearTimeout(w.timer);
  w.timer = setTimeout(tick, 50);
}

async function tick(): Promise<void> {
  const w = g.__nbWorker!;
  w.busy = true;
  try {
    while (w.running && (await runOne()));
  } catch (e) {
    console.error("[jobs] worker error", e);
  } finally {
    w.busy = false;
    if (w.running) {
      // Wake up for the next debounced job (or poll every 5 s).
      const next = await q1<{ ms: number }>("SELECT greatest(0, extract(epoch FROM min(run_after) - now()) * 1000)::int AS ms FROM jobs WHERE status = 'pending'").catch(() => null);
      w.timer = setTimeout(tick, Math.min(5000, Math.max(100, next?.ms ?? 5000)));
    }
  }
}

export async function startWorker(): Promise<void> {
  if (g.__nbWorker?.running) return;
  g.__nbWorker = { running: true, busy: false };
  // Recover jobs left 'processing' by a crashed/restarted process.
  await q("UPDATE jobs SET status = 'pending', locked_at = NULL WHERE status = 'processing' AND locked_at < now() - interval '2 minutes'").catch(() => {});
  wake();
}

export function stopWorker(): void {
  const w = g.__nbWorker;
  if (!w) return;
  w.running = false;
  if (w.timer) clearTimeout(w.timer);
}
