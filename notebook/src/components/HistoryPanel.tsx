"use client";
import { useEffect, useMemo, useState } from "react";
import { api, timeAgo } from "@/lib/client";
import { diffLines } from "@/lib/diff";

type Version = { id: string; reason: string; created_at: string; plain_text: string };

export function HistoryPanel({ lectureId, currentText, onRestored }: { lectureId: string; currentText: () => string; onRestored: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [sel, setSel] = useState<Version | null>(null);
  const [mode, setMode] = useState<"view" | "compare">("compare");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ versions: Version[] }>(`/api/lectures/${lectureId}/versions`).then((r) => setVersions(r.versions)).catch(() => setVersions([]));
  }, [lectureId]);

  const diff = useMemo(() => (sel && mode === "compare" ? diffLines(sel.plain_text, currentText()) : null), [sel, mode, currentText]);

  async function restore() {
    if (!sel || !confirm("Restore this version? Your current notes are kept in history.")) return;
    setBusy(true);
    await api(`/api/lectures/${lectureId}/versions`, { method: "POST", json: { versionId: sel.id } });
    setBusy(false);
    onRestored();
  }

  return (
    <section aria-label="Version history" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="border-b border-border px-4 py-2.5 text-sm font-medium">Version history</div>
      {!sel ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {versions === null && <p className="p-4 text-sm text-fg-2">Loading…</p>}
          {versions?.length === 0 && <p className="p-4 text-sm text-fg-2">No earlier versions yet. Snapshots are kept every 10 minutes while you write, and before any AI insert or restore.</p>}
          <ul>
            {versions?.map((v) => (
              <li key={v.id}>
                <button className="w-full border-b border-border px-4 py-2.5 text-left hover:bg-muted" onClick={() => setSel(v)}>
                  <span className="block text-sm">{new Date(v.created_at).toLocaleString()}</span>
                  <span className="block text-xs text-fg-2">{timeAgo(v.created_at)} · {v.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs">
            <button className="btn btn-ghost h-7 px-2" onClick={() => setSel(null)}>← All versions</button>
            <span className="flex-1" />
            <button className={`btn h-7 px-2 ${mode === "compare" ? "" : "btn-ghost"}`} onClick={() => setMode("compare")}>Compare with now</button>
            <button className={`btn h-7 px-2 ${mode === "view" ? "" : "btn-ghost"}`} onClick={() => setMode("view")}>View</button>
            <button className="btn btn-primary h-7 px-2" onClick={restore} disabled={busy}>Restore</button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
            {mode === "view" ? <pre className="whitespace-pre-wrap">{sel.plain_text || "(empty)"}</pre> :
              diff?.map((d, i) => (
                <div key={i} className={`whitespace-pre-wrap px-1 ${d.op === "add" ? "bg-green-500/10 text-green-700 dark:text-green-400" : d.op === "del" ? "bg-red-500/10 text-red-700 line-through dark:text-red-400" : "text-fg-2"}`}>
                  {d.op === "add" ? "+ " : d.op === "del" ? "− " : "  "}{d.text || " "}
                </div>
              ))}
            {mode === "compare" && <p className="mt-4 font-sans text-fg-2">− only in this version · + only in current notes</p>}
          </div>
        </>
      )}
    </section>
  );
}
