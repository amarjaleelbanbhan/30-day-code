"use client";
import Link from "next/link";
import { useState } from "react";
import type { ConceptEvidence } from "@/lib/concepts";
import { AskPanel, sourceHref, type PanelTab } from "./AskPanel";

type Ev = ConceptEvidence & { label: string };
type Related = { id: string; name: string; kind: string; evidence: number; direction: string };

const pad = (n: number | null) => (n == null ? "—" : String(n).padStart(2, "0"));
const snippet = (s: string) => s.replace(/\s+/g, " ").slice(0, 240);

export function ConceptView({ course, concept, related, evidence }: { course: { id: string; name: string }; concept: { id: string; name: string; aliases: string[] }; related: Related[]; evidence: Ev[] }) {
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const href = (e: Ev) => sourceHref(course.id, { lectureId: e.lecture_id, materialId: e.material_id, pageNo: e.page_no, anchor: e.anchor, section: e.section });
  const lectures = new Map<string, { label: string; items: Ev[] }>();
  for (const e of evidence) {
    const key = e.lecture_id ?? `f:${e.filename}`;
    const g = lectures.get(key) ?? { label: e.lecture_id ? `Lecture ${pad(e.lecture_number)}${e.lecture_title ? ` — ${e.lecture_title}` : ""}` : e.filename ?? "Course material", items: [] };
    g.items.push(e);
    lectures.set(key, g);
  }
  const defs = evidence.filter((e) => e.role === "definition" && e.source_kind !== "student_notes");
  const diagrams = evidence.filter((e) => e.content_type === "drawing" || /\b(diagram|figure|draw|chart)\b/i.test(e.content));
  const mine = evidence.filter((e) => e.source_kind === "student_notes" && e.content_type !== "drawing");
  const Item = ({ e }: { e: Ev }) => (
    <li>
      <Link href={href(e)} className="block rounded-md border border-border px-3 py-2 hover:bg-muted">
        <span className="block text-xs font-medium">{e.label}{e.content_type === "speaker_notes" && <span className="font-normal text-fg-2"> · teacher</span>}</span>
        <span className="line-clamp-3 block text-sm text-fg-2">{snippet(e.content)}</span>
      </Link>
    </li>
  );
  const Section = ({ title, items }: { title: string; items: Ev[] }) => items.length ? (
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">{title}</h2>
      <ul className="space-y-2">{items.slice(0, 12).map((e) => <Item key={e.chunk_id + title} e={e} />)}</ul>
    </section>
  ) : null;

  return (
    <div className="flex min-h-dvh">
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:py-12">
        <nav className="mb-6 flex gap-2 text-sm text-fg-2">
          <Link href={`/c/${course.id}`} className="hover:text-fg">{course.name}</Link><span>/</span>
          <Link href={`/c/${course.id}/concepts`} className="hover:text-fg">Concepts</Link>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">{concept.name}</h1>
        {concept.aliases.length > 0 && <p className="mt-1 text-sm uppercase text-fg-2">{concept.aliases.join(" · ")}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={() => setPanel("ask")}>Reconstruct from course</button>
        </div>

        <section className="mt-8">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Appears in</h2>
          <ul className="flex flex-wrap gap-1.5">
            {[...lectures.values()].map((g) => (
              <li key={g.label}><a href={`#g-${g.label}`} className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted">{g.label.split(" — ")[0]} <span className="text-fg-2">{g.items.length}</span></a></li>
            ))}
          </ul>
        </section>

        {related.length > 0 && (
          <section className="mt-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Related</h2>
            <ul className="flex flex-wrap gap-1.5">
              {related.map((r) => (
                <li key={r.id + r.kind}>
                  <Link href={`/c/${course.id}/concepts/${r.id}`} className="rounded-md border border-border px-2 py-1 text-sm hover:bg-muted"
                    title={r.kind === "part_of" ? (r.direction === "narrower" ? "More specific concept" : "Broader concept") : `Mentioned together in ${r.evidence} passages`}>
                    {r.name}{r.kind === "cooccurs" && <span className="text-fg-2"> · {r.evidence}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Section title="Definitions" items={defs} />
        <Section title="Diagrams & visual explanations" items={diagrams} />
        <Section title="My notes" items={mine} />

        <section className="mt-8">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-2">Source material</h2>
          {[...lectures.entries()].map(([k, g]) => (
            <div key={k} id={`g-${g.label}`} className="mt-4">
              <h3 className="mb-1.5 text-sm font-medium">{g.label}</h3>
              <ul className="space-y-2">{g.items.map((e) => <Item key={e.chunk_id} e={e} />)}</ul>
            </div>
          ))}
        </section>
      </main>
      {panel && (
        <div className="fixed inset-y-0 right-0 z-40 w-full border-l border-border shadow-xl sm:w-[480px]">
          <AskPanel courseId={course.id} courseName={course.name} tab={panel} initialQuestion={`Recall everything about ${concept.name}`}
            onTab={setPanel} onClose={() => setPanel(null)} />
        </div>
      )}
    </div>
  );
}
