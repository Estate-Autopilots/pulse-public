"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@pulse/ui-shell";
import { Panel } from "../ui";
import css from "./settings.module.css";

const CHOICES: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor }, { value: "light", label: "Light", Icon: Sun }, { value: "dark", label: "Dark", Icon: Moon },
];

/** Theme choice for this browser; the same preference the sun/moon button in the top bar switches. */
export function Appearance() {
  const { preference, setPreference } = useTheme();
  return (
    <Panel title="Appearance" sub="On this device">
      <fieldset className={css.themes}>
        <legend className={css.srOnly}>Theme</legend>
        {CHOICES.map(({ value, label, Icon }) => (
          <label key={value} className={css.theme} data-selected={preference === value}>
            <input type="radio" name="pulse-theme" value={value} checked={preference === value} onChange={() => setPreference(value)} />
            <Icon size={15} aria-hidden="true" />{label}
          </label>
        ))}
      </fieldset>
      <p className={css.hint}>“System” follows your device’s light or dark setting. The choice is saved in this browser only, not for the whole organisation.</p>
    </Panel>
  );
}
