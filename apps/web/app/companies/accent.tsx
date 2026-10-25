"use client";
// UX-TENANT: a company's accent colour. It becomes Pulse's action colour on that company's address (buttons, links,
// focus), so it must carry white text: 4.5:1 against white, the bar Pulse's own iris meets. The swatches all pass.
import { Check } from "lucide-react";
import { useState } from "react";
import { BRAND } from "@pulse/design-system/brand";
import { styles } from "../ui";
import css from "./companies.module.css";

export const SWATCHES = [
  { hex: BRAND.iris, name: "Pulse iris" }, { hex: "#1d4ed8", name: "Blue" }, { hex: "#0e7490", name: "Teal" }, { hex: "#15803d", name: "Green" },
  { hex: "#b45309", name: "Amber" }, { hex: "#c2410c", name: "Orange" }, { hex: "#be123c", name: "Rose" }, { hex: "#7c3aed", name: "Violet" }, { hex: "#334155", name: "Slate" },
];

const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
/** WCAG contrast of a #rrggbb colour against white. */
export function onWhite(hex: string) { return /^#[0-9a-f]{6}$/i.test(hex) ? Math.round(1.05 / (lum(hex.toLowerCase()) + 0.05) * 100) / 100 : 0; }

/** A square mark from the company's initials on the brand system's rounded tile (32-point grid, 8-point corners). */
export function initialsMark(name: string, accent: string): string {
  const letters = name.replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "") || "P";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="${letters}"><rect width="32" height="32" rx="8" fill="${accent}"/>`
    + `<text x="16" y="21.2" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="${letters.length > 1 ? 13 : 16}" font-weight="700" fill="#ffffff">${letters}</text></svg>`;
}

export function AccentPicker({ value, onSave, disabled }: { value: string | null; onSave: (hex: string | null) => Promise<void>; disabled?: boolean }) {
  const [custom, setCustom] = useState(value ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ratio = onWhite(custom);
  async function save(hex: string | null) {
    setError(""); setBusy(true);
    try { await onSave(hex); if (hex) setCustom(hex); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); }
  }
  return <div className={css.accent}>
    <ul className={css.swatches} aria-label="Accent colours">{SWATCHES.map((s) => <li key={s.hex}>
      <button type="button" className={css.swatch} style={{ background: s.hex }} disabled={disabled || busy} aria-pressed={value === s.hex} aria-label={`${s.name} ${s.hex}`} title={`${s.name} · ${onWhite(s.hex)}:1 on white`} onClick={() => void save(s.hex)}>
        {value === s.hex ? <Check size={14} aria-hidden="true" /> : null}</button></li>)}</ul>
    <div className={css.customRow}>
      <label className={styles.field}>Your own colour<input value={custom} onChange={(e) => setCustom(e.target.value.trim().toLowerCase())} placeholder="#5b45d6" maxLength={7} disabled={disabled || busy} spellCheck={false} /></label>
      <span className={css.ratio} data-state={!/^#[0-9a-f]{6}$/.test(custom) ? "idle" : ratio >= 4.5 ? "ok" : "bad"}>{/^#[0-9a-f]{6}$/.test(custom) ? `${ratio}:1 on white ${ratio >= 4.5 ? "· readable" : "· too light for white text"}` : "Six-digit hex, e.g. #1d4ed8"}</span>
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={disabled || busy || !/^#[0-9a-f]{6}$/.test(custom) || ratio < 4.5 || custom === value} onClick={() => void save(custom)}>Use colour</button>
      {value ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={disabled || busy} onClick={() => void save(null)}>Pulse default</button> : null}
    </div>
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
  </div>;
}
