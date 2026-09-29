// Developer tool: print hybrid-search results for queries against a course.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/debug-search.ts "<course name>" "query 1" "query 2" ...
import { q1, pool } from "../src/lib/db";
import { search } from "../src/lib/search";

async function main() {
  const [name, ...queries] = process.argv.slice(2);
  const c = await q1<{ id: string; user_id: string }>("SELECT id, user_id FROM courses WHERE name = $1 ORDER BY created_at DESC LIMIT 1", [name]);
  if (!c) throw new Error(`No course named ${name}`);
  for (const query of queries) {
    const r = await search(c.user_id, c.id, query, { limit: 6 });
    console.log(`\n## ${query}\n   corrections=${JSON.stringify(r.analysis.corrections)} missing=${JSON.stringify(r.analysis.missing)} aliases=${JSON.stringify(r.analysis.aliases)} semanticTop=${r.analysis.semantic.top}`);
    for (const h of r.hits) console.log(`   ${h.score.toFixed(4)}  L${h.lecture_number ?? "-"} ${h.content_type.padEnd(13)} ${(h.section ?? "").slice(0, 40).padEnd(40)} ${h.methods.join(",")} ${JSON.stringify(h.method_scores)}`);
  }
  await pool().end();
}
main();
