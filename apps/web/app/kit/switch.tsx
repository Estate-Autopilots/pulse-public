"use client";
// UI-POLISH-3 (owner, 25 Oct 2026: "every settings tab tidy and usable"): the kit's yes/no setting. A real
// `<input type="checkbox" role="switch">`, so the keyboard, screen readers, `name` + FormData and `defaultChecked` work
// as for any checkbox. A row puts the words first and the switch at the end (a settings list); `inline` puts the switch
// first (a short option inside a form or a dialog); `hideLabel` draws the switch alone (its words live elsewhere).
// A switch that saves at once says so with a toast; a switch inside a form saves with the form's SaveBar.
import type { ReactNode } from "react";
import css from "./kit.module.css";

export type SwitchProps = {
  /** What the setting does, in a few words. */ label: ReactNode;
  /** One line on what on and off mean. */ hint?: ReactNode;
  checked?: boolean; defaultChecked?: boolean; onChange?: (on: boolean) => void; disabled?: boolean; name?: string; id?: string;
  /** The switch first, then its words (inside a form or a dialog). */ inline?: boolean;
  /** Only the switch shows; `aria-label` (or a string `label`) names it. */ hideLabel?: boolean;
  /** Words beside the switch for its two states, e.g. ["On", "Off"] or ["Shown", "Hidden"]. */ states?: [string, string];
  className?: string; "aria-label"?: string;
};

export function Switch({ label, hint, checked, defaultChecked, onChange, disabled, name, id, inline, hideLabel, states, className, "aria-label": ariaLabel }: SwitchProps) {
  const named = ariaLabel ?? (hideLabel && typeof label === "string" ? label : undefined);
  const input = <input type="checkbox" role="switch" className={css.switch} id={id} name={name} checked={checked} defaultChecked={defaultChecked} disabled={disabled}
    aria-label={named} onChange={onChange ? (e) => onChange(e.target.checked) : undefined} />;
  if (hideLabel) return <span className={`${css.switchBare} ${className ?? ""}`}>{input}{states && checked !== undefined ? <span className={css.switchWord} aria-hidden="true">{checked ? states[0] : states[1]}</span> : null}</span>;
  return <label className={`${css.switchRow} ${className ?? ""}`} data-inline={inline ? "" : undefined} data-disabled={disabled ? "" : undefined}>
    <span className={css.switchText}><b>{label}</b>{hint ? <small>{hint}</small> : null}</span>
    {states && checked !== undefined ? <span className={css.switchWord} aria-hidden="true">{checked ? states[0] : states[1]}</span> : null}
    {input}
  </label>;
}
