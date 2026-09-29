"use client";
import { useState } from "react";
import { api } from "@/lib/client";

/** Uploading… → Processing… → Indexing… → Ready, or "Processing failed · Retry". Never fails silently. */
export function MaterialStatus({ id, status, error, embedStatus, embedError, onRetried }: {
  id: string; status: string; error?: string | null; embedStatus?: string; embedError?: string | null; onRetried?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await api(`/api/materials/${id}`, { method: "POST" }).catch(() => {});
    setBusy(false);
    onRetried?.();
  };
  const Retry = () => <button className="ml-1 underline underline-offset-2" disabled={busy} onClick={retry}>{busy ? "Retrying…" : "Retry"}</button>;
  if (status === "failed") return <span className="text-danger" title={error ?? ""}>Processing failed · <Retry /></span>;
  if (status === "pending" || status === "processing") return <span>Processing…</span>;
  if (embedStatus === "failed") return <span className="text-danger" title={embedError ?? ""}>Indexing failed · <Retry /></span>;
  if (embedStatus === "pending" || embedStatus === "processing") return <span>Indexing…</span>;
  return <span>Ready</span>;
}

export const isBusy = (m: { status: string; embedStatus?: string }) =>
  m.status === "pending" || m.status === "processing" || m.embedStatus === "pending" || m.embedStatus === "processing";
