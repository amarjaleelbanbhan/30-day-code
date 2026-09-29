// Developer/admin: re-extract / re-chunk / re-embed without deleting anything the student uploaded or wrote.
//   npm run reindex -- --course "<name or id>" [--embeddings-only]
//   npm run reindex -- --stale          # re-embed every course whose vectors came from another embedding model
import { q, pool } from "../src/lib/db";
import { embeddingHealth, reindex } from "../src/lib/ingest";
import { enqueue } from "../src/lib/jobs";
import { drainAll } from "./drain";

async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const val = (f: string) => args[args.indexOf(f) + 1];
  if (flag("--stale")) {
    const courses = await q<{ id: string; name: string }>("SELECT id, name FROM courses");
    for (const c of courses) {
      const h = await embeddingHealth(c.id);
      if (h.current && h.missing > 0) { console.log(`${c.name}: ${h.missing} chunks need embeddings for ${h.current}`); await enqueue("embed_course", c.id, c.id); }
    }
  } else if (flag("--course")) {
    const key = val("--course");
    const c = await q<{ id: string; name: string }>("SELECT id, name FROM courses WHERE id::text = $1 OR name = $1", [key]);
    if (!c.length) throw new Error(`No course ${key}`);
    for (const x of c) console.log(x.name, await reindex({ kind: "course", id: x.id }, { embeddingsOnly: flag("--embeddings-only") }));
  } else {
    console.log('usage: reindex --course "<name|id>" [--embeddings-only] | --stale');
    return pool().end();
  }
  console.log(`processed ${await drainAll()} jobs`);
  await pool().end();
}
main();
