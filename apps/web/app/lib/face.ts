import type { CSSProperties } from "react";

/** A colour (0–359) that stays the same for the same name. */
export const hue = (text: string) => { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
/** Up to two initials; a note in parentheses and a title (Mr, Dr …) are not part of the name. */
export const initials = (name: string) => name.replace(/\([^)]*\)/g, " ").trim().replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase() || "?";
export const hueStyle = (name: string) => ({ "--hue": hue(name) }) as CSSProperties;
