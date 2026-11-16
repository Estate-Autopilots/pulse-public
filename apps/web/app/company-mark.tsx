"use client";
// COMPANY-MARKS (owner, 4 Nov 2026): "the company logo should be used instead of a random colour; only when there is
// no icon do we use a plain colour." One mark for a company wherever Pulse names it beside other companies (My day's
// chips, its "Which company needs you" rail, the line under each task): the company's own square logo (Settings →
// Organisation) as a small rounded square, never stretched (object-fit: contain) and at a whole-pixel size so it stays
// crisp; with no logo, or one that fails to load, a solid tile with its initials on its set brand colour, or on one
// neutral colour when it has none. Never a hue made up from the name.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import css from "./company-mark.module.css";

const HEX = /^#[0-9a-f]{6}$/i;

/** Two letters for a company: the first letters of its first two words ("Estate Autopilots" → "EA"). */
export function companyInitials(name: string): string {
  const parts = name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (Array.from(parts[0])[0] + Array.from(parts[1])[0]).toUpperCase();
  return (Array.from(name.trim()).slice(0, 2).join("") || "·").toUpperCase();
}

/** Dark or light letters, whichever reads on the brand colour (relative luminance, WCAG). */
export function inkOn(hex: string): "#ffffff" | "#16181b" {
  const lin = (i: number) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? "#ffffff" : "#16181b";
}

export function CompanyMark({ name, mark, color, size = 18, className }: {
  name: string;
  /** The logo's address (same-origin, through the API), or null. */
  mark?: string | null;
  /** The company's set brand colour (#rrggbb), or null. */
  color?: string | null;
  /** Pixels: 16 to 20 beside text. */
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  // A logo that failed before the page came alive (its error fired before React listened) falls back too.
  useEffect(() => { const el = img.current; if (mark && el && el.complete && el.naturalWidth === 0) setFailed(mark); }, [mark]);
  const px = Math.round(Math.min(32, Math.max(12, size)));
  const cls = className ? `${css.mark} ${className}` : css.mark;
  if (mark && failed !== mark) {
    // eslint-disable-next-line @next/next/no-img-element -- the organisation's own logo, served by the app's API
    return <img ref={img} src={mark} alt={name} width={px} height={px} className={cls} data-company-mark="" decoding="async" draggable={false}
      style={{ width: px, height: px }} onError={() => setFailed(mark)} />;
  }
  const brand = color && HEX.test(color) ? color : null;
  const style = { width: px, height: px, fontSize: Math.max(7, Math.round(px * 0.42)), ...(brand ? { "--mark-bg": brand, "--mark-ink": inkOn(brand) } : {}) } as CSSProperties;
  return <span role="img" aria-label={name} className={`${cls} ${css.tile}`} data-company-mark="" data-brand={brand ? "" : undefined} style={style}>
    <span aria-hidden="true">{companyInitials(name)}</span>
  </span>;
}
