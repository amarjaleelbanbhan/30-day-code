"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { AskResult } from "@/lib/rag";

// Developer-only retrieval inspector (hidden in production unless NB_DEBUG=1).
type Row = { chunk_id: string; label: string; score: number };

export function DebugView({ course }: { course: { id: string; name: string } }) {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"course" | "explain">("course");
  const [r, setR] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api<Record<string, unknown>>(`/api/courses/${course.id}/debug`).then(setInfo).catch((e) => setMsg(String(e)));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setBusy(true);
    try { setR(await api<AskResult>(`/api/courses/${course.id}/ask?debug=1`, { method: "POST", json: { question: q, mode } })); }
    catch (e) { setMsg(String(e)); }
    setBusy(false);
  }
  async function reindex(embeddingsOnly: boolean) {
    const out = await api(`/api/courses/${course.id}/reindex`, { method: "POST", json: { scope: "course", embeddingsOnly } });
    setMsg(`Queued: ${JSON.stringify(out)}`);
    setTimeout(load, 1500);
  }
  const t = r?.trace;
  const List = ({ title, rows }: { title: string; rows: Row[] }) => (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-medium">{title} ({rows.length})</h4>
      <ol className="space-y-0.5 font-mono text-[11px]">{rows.map((x) => <li key={x.chunk_id} className="truncate">{x.score.toFixed(3)} {x.label}</li>)}</ol>
    </div>
  );

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 text-sm">
      <nav className="mb-4 text-fg-2"><Link href={`/c/${course.id}`}>← {course.name}</Link> · retrieval debug (developer only)</nav>
      {msg && <p className="mb-3 rounded bg-muted p-2 text-xs">{msg}</p>}
      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <pre className="max-h-80 overflow-auto rounded-lg border border-border p-3 text-[11px]">{JSON.stringify(info && { capabilities: info.capabilities, embeddings: info.embeddings, concepts: info.concepts }, null, 2)}</pre>
        <div className="space-y-2">
          <pre className="max-h-44 overflow-auto rounded-lg border border-border p-3 text-[11px]">{JSON.stringify(info?.chunks, null, 1)}</pre>
          <pre className="max-h-28 overflow-auto rounded-lg border border-border p-3 text-[11px]">jobs: {JSON.stringify(info?.jobs, null, 1)}</pre>
          <div className="flex gap-2">
            <button className="btn h-8 text-xs" onClick={() => reindex(false)}>Reindex course</button>
            <button className="btn h-8 text-xs" onClick={() => reindex(true)}>Re-embed course</button>
            <button className="btn btn-ghost h-8 text-xs" onClick={load}>Refresh</button>
          </div>
        </div>
      </section>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Query…" aria-label="Debug query" />
        <select className="input w-auto" value={mode} onChange={(e) => setMode(e.target.value as "course" | "explain")} aria-label="Mode">
          <option value="course">course only</option><option value="explain">course + explanation</option>
        </select>
        <button className="btn" disabled={busy}>{busy ? "…" : "Run"}</button>
      </form>
      {t && (
        <div className="mt-6 space-y-5">
          <p><b>intent</b> {JSON.stringify(t.route.intent)} · <b>hint</b> {String(t.route.hint)} · <b>mode</b> {r!.mode} · {t.ms} ms</p>
          {t.notes.length > 0 && <ul className="list-disc pl-5 text-xs">{t.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {t.searches.map((s, i) => (
            <section key={i} className="rounded-lg border border-border p-3">
              <p className="mb-2 text-xs"><b>search</b> “{s.query}” · terms {JSON.stringify(s.analysis.terms)} · df {JSON.stringify(s.analysis.df)} · corrections {JSON.stringify(s.analysis.corrections)} · aliases {JSON.stringify(s.analysis.aliases)} · missing {JSON.stringify(s.analysis.missing)} · cohesive {String(s.analysis.cohesive)} · semantic {JSON.stringify(s.analysis.semantic)}</p>
              <div className="grid gap-3 md:grid-cols-4">
                <List title="keyword" rows={s.trace.keyword} /><List title="semantic" rows={s.trace.semantic} />
                <List title="fuzzy" rows={s.trace.fuzzy} /><List title="fused" rows={s.trace.fused} />
              </div>
            </section>
          ))}
          <section>
            <h3 className="mb-1 font-medium">Selected context ({t.selected.length})</h3>
            <ol className="font-mono text-[11px]">{t.selected.map((s) => <li key={s.n}>[{s.n}] {s.role} {s.score.toFixed(3)} {s.label} · {s.methods.join(",")}</li>)}</ol>
          </section>
          <p className="text-xs"><b>citations</b> cited {JSON.stringify(t.citations.cited)} · removed invalid {JSON.stringify(t.citations.invalid)}</p>
          {t.prompts.map((p, i) => (
            <details key={i} className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-xs">LLM call {i + 1} — {p.user.length.toLocaleString()} chars</summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-[11px]">{`SYSTEM:\n${p.system}\n\nUSER:\n${p.user}\n\nOUTPUT:\n${p.output}`}</pre>
            </details>
          ))}
          <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-xs">Answer JSON</summary>
            <pre className="mt-2 max-h-96 overflow-auto text-[11px]">{JSON.stringify({ ...r, trace: undefined }, null, 2)}</pre></details>
        </div>
      )}
    </main>
  );
}
