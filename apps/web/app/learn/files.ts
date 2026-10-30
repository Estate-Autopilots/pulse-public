// XRAY-LINK (Learn): tutorial videos live outside git. tools/tutorials/learn.py writes lib/learn-media.json (what was
// made: files, length, chapters, YouTube links) and copies the web cuts into PULSE_LEARN_MEDIA (default: the web app's
// .learn-media folder, which git ignores). A video shows only where its file is really there; elsewhere the tutorial
// keeps its steps and screenshots (and the YouTube link once the videos are published).
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import manifest from "../lib/learn-media.json";

export type Chapter = { at: number; title: string };
export type TutorialMedia = { id: string; seconds?: number; chapters?: Chapter[]; voice?: boolean;
  video?: Record<string, string>; captions?: Record<string, string>; poster?: string; youtube?: Record<string, string | null> };
type Manifest = { made?: string; tutorials?: Record<string, TutorialMedia> };

export const CAPTION_LABELS: Record<string, string> = { en: "English", hi: "हिन्दी", "hi-Latn": "Hinglish", mr: "मराठी", "mr-Latn": "Marathi (Roman)" };
export const VIDEO_LABELS: Record<string, string> = { en: "English", hi: "Hinglish" };
const SAFE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

export function mediaRoot() {
  return process.env.PULSE_LEARN_MEDIA || path.join(process.cwd(), ".learn-media");
}

/** The file for /learn/media/<parts>, or null when the name is not a plain file name or the file is missing. */
export function mediaFile(parts: string[]) {
  if (!parts.length || parts.length > 2 || !parts.every((p) => SAFE.test(p) && !p.includes(".."))) return null;
  const file = path.join(mediaRoot(), ...parts);
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

/** What exists for one tutorial: only files present on this server are listed. */
export function mediaFor(id: string): TutorialMedia | null {
  const m = (manifest as Manifest).tutorials?.[id];
  if (!m) return null;
  const here = (rec?: Record<string, string>) => Object.fromEntries(Object.entries(rec ?? {}).filter(([, f]) => SAFE.test(f) && existsSync(path.join(mediaRoot(), id, f))));
  return { ...m, video: here(m.video), captions: here(m.captions), poster: m.poster && existsSync(path.join(mediaRoot(), id, m.poster)) ? m.poster : undefined };
}
