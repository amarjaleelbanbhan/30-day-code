"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCommands } from "./commands";

export function CommandPalette() {
  const commands = useCommands();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("nb:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("nb:palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return commands;
    const words = t.split(/\s+/);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.group ?? ""}`.toLowerCase().includes(w)));
  }, [commands, query]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    restoreFocus.current?.focus?.();
  };
  const run = (i: number) => {
    const c = results[i];
    if (!c) return;
    setOpen(false);
    c.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-[12vh]" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}>
        <input ref={inputRef} autoFocus value={query} placeholder="Type a command…" aria-label="Command"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[15px] outline-none"
          onChange={(e) => { setQuery(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); close(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(idx); }
          }} />
        <ul role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && <li className="px-4 py-3 text-sm text-fg-2">No matching commands</li>}
          {results.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === idx}
              className={`flex cursor-pointer items-center justify-between px-4 py-2 text-sm ${i === idx ? "bg-muted" : ""}`}
              onMouseEnter={() => setIdx(i)} onClick={() => run(i)}>
              <span>{c.label}{c.group && <span className="ml-2 text-fg-2">{c.group}</span>}</span>
              {c.shortcut && <span className="kbd">{c.shortcut}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
