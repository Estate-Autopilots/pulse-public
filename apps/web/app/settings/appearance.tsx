"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "@pulse/ui-shell";
import { ChipFilter } from "../components/page-kit";
import { Segmented, Switch } from "../kit";
import { toast, useFunEffects } from "../kit/game";
import css from "./settings.module.css";

const CHOICES: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor }, { value: "light", label: "Light", Icon: Sun }, { value: "dark", label: "Dark", Icon: Moon },
];

/** Theme choice for this browser; the same preference the sun/moon button in the top bar switches.
 *  SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.2: "Look & system just consumes a lot of space"): two rows of one short
 *  list, each with its control on the right, and one line under it. */
export function Appearance() {
  const { preference, setPreference } = useTheme();
  const [fun, setFun] = useFunEffects();
  return <>
    <ul className={css.list} aria-label="Appearance">
      <li className={css.listRow} data-control=""><span>Theme</span>
        <Segmented label="Theme" size="sm" value={preference} onChange={setPreference} options={CHOICES.map(({ value, label, Icon }) => ({ value, label, icon: Icon }))} /></li>
      {/* UX-GAMIFY (owner, 9 Nov 2026: "everything optional per person"): confetti, counting numbers and filling rings. */}
      {/* SETTINGS-APPLE (judge): the switch stays on the right of its words on a phone too. */}
      <li className={css.listRow} data-control="" data-switch=""><span>Fun effects<small>Confetti, numbers that count up, rings that fill</small></span>
        <Switch hideLabel label="Fun effects" checked={fun} onChange={(v) => { setFun(v); toast(v ? "Fun effects are on." : "Fun effects are off."); }} /></li>
      <li className={css.listNote}>Saved in this browser only. “System” follows your device’s light or dark setting.</li>
    </ul>
  </>;
}

/** UX-SETTINGS-CHAT: the same choice as chips. */
export function ThemeChips() {
  const { preference, setPreference } = useTheme();
  return <ChipFilter wrap label="Theme" current={preference} items={CHOICES.map(({ value, label, Icon }) => ({ key: value, label: <><Icon size={15} aria-hidden="true" />{label}</>, onClick: () => setPreference(value) }))} />;
}
