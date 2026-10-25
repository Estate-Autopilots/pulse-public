"use client";

import { Moon, Sun } from "lucide-react";
import styles from "./theme-toggle.module.css";
import { useTheme } from "./theme-provider";

export function ThemeToggle() {
  const { resolved, setPreference } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => setPreference(next)}
    >
      {resolved === "dark" ? <Sun size={17} className={styles.icon} aria-hidden="true" /> : <Moon size={17} className={styles.icon} aria-hidden="true" />}
    </button>
  );
}
