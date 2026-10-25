"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
type ThemeContextValue = Readonly<{
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (next: ThemePreference) => void;
}>;
const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "pulse.theme";

function parsePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch {}
  };

  useEffect(() => {
    try { setPreferenceState(parsePreference(window.localStorage.getItem(STORAGE_KEY))); } catch {}
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next = preference === "system" ? (media.matches ? "dark" : "light") : preference;
      setResolved(next);
      document.documentElement.dataset.theme = next;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
