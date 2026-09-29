// Retrieval latency benchmark on a synthetic large course (60 lectures × 80 slides + a 1,500-page book).
//   DATABASE_URL=… npm run -s bench
import { performance } from "node:perf_hooks";
import { q, q1, pool } from "../src/lib/db";
import { rebuildLexicon } from "../src/lib/ingest";
import { ask } from "../src/lib/rag";
import { search } from "../src/lib/search";
import { buildConcepts } from "../src/lib/concepts";

const TOPICS = ["process", "thread", "scheduling", "deadlock", "semaphore", "paging", "segmentation", "virtual memory", "file system", "disk scheduling",
  "interrupt", "system call", "kernel", "mutex", "monitor", "context switch", "cache", "TLB", "page fault", "inode"];

async function main() {
  const dims = 256;
  const u = (await q1<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('bench-' || gen_random_uuid() || '@x', 'x') RETURNING id"))!;
  const c = (await q1<{ id: string }>("INSERT INTO courses (user_id, name) VALUES ($1, 'Bench course') RETURNING id", [u.id]))!;
  let t = performance.now();
  await q(`INSERT INTO lectures (course_id, number, title, position) SELECT $1, g, 'Lecture topic ' || g, g FROM generate_series(1, 60) g`, [c.id]);
  await q(`INSERT INTO materials (course_id, lecture_id, kind, filename, mime, size_bytes, storage_key, status, embed_status)
           SELECT l.course_id, l.id, 'slides', 'lecture' || l.number || '.pptx', 'x', 1, l.course_id || '/' || gen_random_uuid() || '.pptx', 'ready', 'ready' FROM lectures l WHERE l.course_id = $1`, [c.id]);
  await q(`INSERT INTO materials (course_id, kind, filename, mime, size_bytes, storage_key, status, embed_status) VALUES ($1::uuid, 'book', 'book.pdf', 'x', 1, $1::text || '/' || gen_random_uuid() || '.pdf', 'ready', 'ready')`, [c.id]);
  await q(
    `INSERT INTO chunks (course_id, lecture_id, material_id, source_type, source_kind, content_type, page_no, section, ord, text, content_hash, embedding, embedding_model)
     SELECT m.course_id, m.lecture_id, m.id, 'material', m.kind, CASE WHEN m.kind = 'book' THEN 'page' ELSE 'slide' END, g,
       initcap(($2::text[])[1 + (g + coalesce(l.number, 0)) % 20]) || ' part ' || g,
       g, repeat('The ' || ($2::text[])[1 + (g + coalesce(l.number, 0)) % 20] || ' is discussed with examples of ' || ($2::text[])[1 + (g * 7) % 20] || ' and ' || ($2::text[])[1 + (g * 3) % 20] || '. ', 6),
       md5(random()::text),
       (SELECT array_agg(random() - 0.5)::vector FROM generate_series(1, ${dims}) WHERE g > 0), 'bench:model'
     FROM materials m LEFT JOIN lectures l ON l.id = m.lecture_id, generate_series(1, CASE WHEN m.kind = 'book' THEN 1500 ELSE 80 END) g
     WHERE m.course_id = $1`, [c.id, TOPICS]);
  await rebuildLexicon(c.id);
  await q("ANALYZE chunks; ANALYZE course_terms; ANALYZE lectures; ANALYZE materials");
  const n = (await q1<{ n: number }>("SELECT count(*)::int AS n FROM chunks WHERE course_id = $1", [c.id]))!.n;
  console.log(`seeded ${n} chunks in ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  await buildConcepts(c.id);
  console.log(`concept index built in ${Math.round(performance.now() - t)} ms (${(await q1<{ n: number }>("SELECT count(*)::int AS n FROM concepts WHERE course_id = $1", [c.id]))!.n} concepts)`);

  // Semantic path: fake a same-dimension query embedder via env is not possible without a server, so time the SQL directly.
  const vec = `[${Array.from({ length: dims }, () => Math.random() - 0.5).join(",")}]`;
  const timeIt = async (label: string, fn: () => Promise<unknown>, runs = 5) => {
    await fn();
    const ts: number[] = [];
    for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); ts.push(performance.now() - s); }
    ts.sort((a, b) => a - b);
    console.log(`${label.padEnd(48)} median ${ts[Math.floor(ts.length / 2)]!.toFixed(1)} ms   max ${ts[ts.length - 1]!.toFixed(1)} ms`);
  };
  await timeIt("hybrid search 'deadlock semaphore'", () => search(u.id, c.id, "deadlock semaphore", { limit: 20 }));
  await timeIt("hybrid search 'memory used during function calls'", () => search(u.id, c.id, "memory used during function calls", { limit: 20 }));
  await timeIt("hybrid search typo 'segmantation'", () => search(u.id, c.id, "segmantation", { limit: 20 }));
  await timeIt("vector top-60 within course (exact scan)", () => q(`SELECT id FROM chunks WHERE course_id = $1 AND embedding_model = 'bench:model' ORDER BY embedding <=> $2::vector LIMIT 60`, [c.id, vec]));
  await timeIt("ask: source lookup 'where did we study TLB'", () => ask(u.id, c.id, "Where did we study TLB?"), 3);
  await timeIt("ask: topic 'everything about paging'", () => ask(u.id, c.id, "Recall everything about paging"), 3);
  await timeIt("ask: recall lecture 42", () => ask(u.id, c.id, "Recall lecture 42"), 3);
  await timeIt("ask: recall course (60 lectures, no LLM)", () => ask(u.id, c.id, "Recall the whole course"), 3);
  const plan = await q<{ "QUERY PLAN": string }>(`EXPLAIN ANALYZE SELECT ch.id FROM chunks ch WHERE ch.course_id = $1 AND ch.tsv @@ to_tsquery('english', 'deadlock | semaphor') LIMIT 60`, [c.id]);
  console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"));
  await q("DELETE FROM users WHERE id = $1", [u.id]);
  await pool().end();
}
main();
