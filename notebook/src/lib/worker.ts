import "server-only";
import { buildConcepts } from "./concepts";
import { registerIndexingJobs } from "./ingest";
import { startWorker } from "./jobs";
import { summarizeLecture } from "./rag";

/** Registers job handlers (idempotent). Call before draining or starting the worker. */
export function registerJobs() {
  registerIndexingJobs({ buildConcepts, summarizeLecture: async (id) => { await summarizeLecture(id); } });
}

export async function bootWorker() {
  registerJobs();
  await startWorker();
}
