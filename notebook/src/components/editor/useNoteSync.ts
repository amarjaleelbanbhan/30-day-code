"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Local-first autosave: every change is written to localStorage immediately (debounced by a few hundred ms),
// then synced to the server. Unsynced drafts survive reloads, crashes and offline periods.

export type SyncStatus = "saved" | "saving" | "unsaved" | "offline";
type Doc = { type: "doc"; content?: unknown[] };
type Draft = { content: Doc; dirty: boolean; ts: number };

const LOCAL_DELAY = 250;
const SERVER_DELAY = 900;
const key = (lectureId: string) => `nb:note:${lectureId}`;

export function readDraft(lectureId: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(lectureId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function writeDraft(lectureId: string, d: Draft) {
  try {
    localStorage.setItem(key(lectureId), JSON.stringify(d));
  } catch {
    // Storage full or blocked: server sync still runs.
  }
}

export function useNoteSync(lectureId: string, getContent: () => Doc | null) {
  const [status, setStatus] = useState<SyncStatus>("saved");
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const getRef = useRef(getContent);
  getRef.current = getContent;

  const saveLocal = useCallback(() => {
    const content = getRef.current();
    if (content) writeDraft(lectureId, { content, dirty: dirty.current, ts: Date.now() });
  }, [lectureId]);

  const flush = useCallback(async (reason?: "ai"): Promise<void> => {
    if (serverTimer.current) clearTimeout(serverTimer.current);
    if (inFlight.current) await inFlight.current;
    if (!dirty.current && !reason) return;
    const content = getRef.current();
    if (!content) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) { setStatus("offline"); return; }
    dirty.current = false;
    setStatus("saving");
    const run = (async () => {
      try {
        const res = await fetch(`/api/lectures/${lectureId}/note${reason ? `?reason=${reason}` : ""}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, plainText: "" }),
        });
        if (res.status === 401) { window.location.href = "/login"; return; }
        if (!res.ok) throw new Error(String(res.status));
        if (!dirty.current) {
          writeDraft(lectureId, { content, dirty: false, ts: Date.now() });
          setStatus("saved");
        }
      } catch {
        dirty.current = true;
        writeDraft(lectureId, { content, dirty: true, ts: Date.now() });
        setStatus(navigator.onLine ? "unsaved" : "offline");
        serverTimer.current = setTimeout(() => void flush(), 10_000); // retry
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  }, [lectureId]);

  const onChange = useCallback(() => {
    dirty.current = true;
    setStatus((s) => (s === "offline" ? s : "unsaved"));
    if (localTimer.current) clearTimeout(localTimer.current);
    localTimer.current = setTimeout(saveLocal, LOCAL_DELAY);
    if (serverTimer.current) clearTimeout(serverTimer.current);
    serverTimer.current = setTimeout(() => void flush(), SERVER_DELAY);
  }, [saveLocal, flush]);

  /** Marks the current content as needing sync (used when a newer local draft was restored on load). */
  const markDirty = useCallback(() => {
    dirty.current = true;
    void flush();
  }, [flush]);

  useEffect(() => {
    const online = () => { setStatus((s) => (s === "offline" ? "unsaved" : s)); void flush(); };
    const offline = () => setStatus("offline");
    const hide = () => {
      if (document.visibilityState === "hidden") { saveLocal(); void flush(); }
    };
    const unload = (e: BeforeUnloadEvent) => {
      saveLocal(); // the local draft is re-synced on next open even if this request is cut off
      if (dirty.current) {
        const content = getRef.current();
        const body = JSON.stringify({ content, plainText: "" });
        if (body.length < 60_000) fetch(`/api/lectures/${lectureId}/note`, { method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: true });
        else e.preventDefault();
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("beforeunload", unload);
    if (!navigator.onLine) setStatus("offline");
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("beforeunload", unload);
      // Navigating to another lecture inside the app: persist before unmount.
      if (localTimer.current) clearTimeout(localTimer.current);
      if (dirty.current) { saveLocal(); void flush(); }
    };
  }, [flush, saveLocal, lectureId]);

  return { status, onChange, flush, markDirty };
}
