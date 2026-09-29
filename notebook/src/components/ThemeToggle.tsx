"use client";
import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("nb-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);
  const cycle = () => {
    const t = next[theme];
    setTheme(t);
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem("nb-theme");
      else localStorage.setItem("nb-theme", t);
    } catch {}
  };
  return (
    <button className="btn btn-ghost h-8 px-2 text-xs text-fg-2" onClick={cycle} title="Theme" aria-label={`Theme: ${theme}`}>
      {theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}
    </button>
  );
}
