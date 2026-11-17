// PULSE-HQ: small pieces shared by the server and browser pages (no hooks).
import { createElement, type CSSProperties } from "react";
import { CATEGORY, FEATURE_STATUS, iconFor, valueShare, type Category, type Feature, type FeatureStatus } from "./model";
import css from "./hq.module.css";

export const hue = (category: Category) => ({ "--hue": CATEGORY[category]?.hue ?? 262 }) as CSSProperties;

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const word = label ?? FEATURE_STATUS.find((s) => s.key === status)?.label ?? status.replace(/^\w/, (c) => c.toUpperCase());
  return <span className={css.status} data-tone={status}><i aria-hidden="true" />{word}</span>;
}

/** The share of features in each status as one bar, live first. */
export function StatusBars({ features }: { features: Pick<Feature, "status">[] }) {
  const counts = FEATURE_STATUS.map((s) => ({ ...s, n: features.filter((f) => f.status === s.key).length })).filter((s) => s.n > 0);
  return <span className={css.bars} role="img" aria-label={counts.map((s) => `${s.n} ${s.label.toLowerCase()}`).join(", ")}>
    {counts.map((s, j) => <i key={s.key} data-tone={s.key} style={{ flexGrow: s.n, "--j": j } as CSSProperties} />)}
  </span>;
}

export function Legend() {
  return <span className={css.legend}>{FEATURE_STATUS.map((s) => <span key={s.key} style={{ "--tone": `var(--tone-${s.key})` } as CSSProperties}><i />{s.label}</span>)}</span>;
}

/** The value score as a ring: a log scale from 1 (break-even) to 100 (the equation's ceiling). */
export function ValueRing({ value, accent, size = 64 }: { value: number; accent?: string; size?: number }) {
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - valueShare(value));
  return <span className={css.ring} style={{ width: size, height: size, ...(accent ? { "--offer": accent } : {}) } as CSSProperties} role="img" aria-label={`Value score ${value}`}>
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true"><circle className={css.track} cx="32" cy="32" r={r} /><circle className={css.fill} cx="32" cy="32" r={r} style={{ "--c": c, "--off": off } as CSSProperties} /></svg>
    <b>{value >= 10 ? Math.round(value) : value.toFixed(1)}</b>
  </span>;
}

export const statusCount = (features: Pick<Feature, "status">[], s: FeatureStatus) => features.filter((f) => f.status === s).length;

/** A catalogue feature's icon by its stored name. */
export function FeatureIcon({ name, size }: { name: string; size: number }) {
  return createElement(iconFor(name), { size, "aria-hidden": true });
}
