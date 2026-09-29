"use client";
import { useEffect, useSyncExternalStore } from "react";

export type Command = { id: string; label: string; group?: string; shortcut?: string; run: () => void };

// Tiny registry so any screen can contribute commands to the global Ctrl/Cmd+K palette.
const sources = new Map<string, Command[]>();
const listeners = new Set<() => void>();
let snapshot: Command[] = [];
const emit = () => {
  snapshot = [...sources.values()].flat();
  listeners.forEach((l) => l());
};

export function useRegisterCommands(key: string, commands: Command[]) {
  useEffect(() => {
    sources.set(key, commands);
    emit();
    return () => {
      sources.delete(key);
      emit();
    };
  }, [key, commands]);
}

export const useCommands = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
    () => snapshot,
  );

export const openPalette = () => window.dispatchEvent(new Event("nb:palette"));
