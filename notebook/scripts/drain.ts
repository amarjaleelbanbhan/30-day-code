import { q } from "../src/lib/db";
import { drain } from "../src/lib/jobs";
import { registerJobs } from "../src/lib/worker";

/** Runs all queued jobs now, ignoring debounce delays. */
export async function drainAll(): Promise<number> {
  registerJobs();
  let total = 0;
  for (let i = 0; i < 50; i++) {
    await q("UPDATE jobs SET run_after = now() WHERE status = 'pending'");
    const n = await drain();
    total += n;
    if (!n) break;
  }
  return total;
}
