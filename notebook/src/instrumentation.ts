// Starts the in-process background worker (document extraction, note indexing, embeddings, concept index).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NB_DISABLE_WORKER !== "1" && process.env.DATABASE_URL) {
    const { bootWorker } = await import("./lib/worker");
    await bootWorker();
  }
}
