"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { ConceptRow } from "@/lib/concepts";

export function ConceptIndex({ course, concepts }: { course: { id: string; name: string }; concepts: ConceptRow[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? concepts.filter((c) => c.name.toLowerCase().includes(t) || c.aliases.some((a) => a.includes(t))) : concepts;
  }, [q, concepts]);
  return (
    <main className="mx-auto max-w-3xl px-5 py-8 sm:py-12">
      <nav className="mb-6 text-sm text-fg-2"><Link href={`/c/${course.id}`} className="hover:text-fg">← {course.name}</Link></nav>
      <h1 className="text-2xl font-semibold tracking-tight">Concepts</h1>
      <p className="mt-1 text-sm text-fg-2">Found automatically in your slides, notes and books. Each links to where you learned it.</p>
      <input className="input mt-6" placeholder="Find a concept…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a concept" autoFocus />
      {concepts.length === 0 && <p className="mt-6 text-sm text-fg-2">No concepts yet — they appear once material has been processed.</p>}
      <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface empty:hidden">
        {shown.map((c) => (
          <li key={c.id}>
            <Link href={`/c/${course.id}/concepts/${c.id}`} className="flex items-baseline justify-between gap-3 px-4 py-2.5 hover:bg-muted">
              <span className="text-[15px]">{c.name}{c.aliases.length > 0 && <span className="ml-2 text-xs uppercase text-fg-2">{c.aliases.join(", ")}</span>}</span>
              <span className="shrink-0 text-xs text-fg-2">
                {c.lecture_count > 0 ? `${c.lecture_count} lecture${c.lecture_count === 1 ? "" : "s"}` : "course material"}{c.first_lecture != null && ` · from L${String(c.first_lecture).padStart(2, "0")}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
