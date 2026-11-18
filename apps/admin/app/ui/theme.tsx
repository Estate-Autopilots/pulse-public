"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { THEME_KEY } from "./theme-script";
import { kitStyles as styles } from "./kit";

type Choice = "system" | "light" | "dark";
const NEXT: Record<Choice, Choice> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const LABEL: Record<Choice, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};
const CHANGED = "pulse:admin-theme-changed";

function apply(choice: Choice) {
  const dark =
    choice === "dark" ||
    (choice === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme-choice", choice);
  window.dispatchEvent(new Event(CHANGED));
}

function readChoice(): Choice {
  const value = document.documentElement.getAttribute("data-theme-choice");
  return value === "light" || value === "dark" ? value : "system";
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGED, callback);
  return () => window.removeEventListener(CHANGED, callback);
}

/** One button: System, then Light, then Dark. On System it follows the device. */
export function ThemeToggle() {
  // The server can't know the choice; the button is neutral until hydrated.
  const choice = useSyncExternalStore<Choice | null>(
    subscribe,
    readChoice,
    () => null,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      if (readChoice() === "system") apply("system");
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);
  const Icon = choice === "dark" ? Moon : choice === "light" ? Sun : Monitor;
  return (
    <button
      type="button"
      className={styles.button}
      data-variant="icon"
      aria-label={choice ? `${LABEL[choice]}. Change theme` : "Change theme"}
      title={choice ? LABEL[choice] : "Theme"}
      onClick={() => {
        const next = NEXT[choice ?? "system"];
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // A private window keeps the choice for this page only.
        }
        apply(next);
      }}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
