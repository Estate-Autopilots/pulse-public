// RELEASE-COMMS: the newest release this person has seen, on this browser (per person: body[data-viewer]). Storage may be
// blocked (private mode, a locked-down browser): then nothing is remembered and nothing breaks.
import { SEEN_KEY } from "./lib/release-notes.mjs";

export const SEEN_EVENT = "pulse:release-seen";
const key = () => `${SEEN_KEY}.${(typeof document !== "undefined" && document.body?.dataset.viewer) || "me"}`;

export function seenRelease(): string | null {
  try { return localStorage.getItem(key()); } catch { return null; }
}

export function rememberRelease(id: number | string) {
  try {
    const prev = Number(localStorage.getItem(key()));
    if (!Number.isFinite(prev) || Number(id) > prev) localStorage.setItem(key(), String(id));
  } catch { /* storage blocked */ }
  try { window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: Number(id) })); } catch { /* old browser */ }
}

// DOREVE-FIX (17 Nov 2026): when the "updated" card last showed on this browser, so it shows at most once a day.
const shownKey = () => `${key()}.shown`;
export function updateShownAt(): string | null {
  try { return localStorage.getItem(shownKey()); } catch { return null; }
}
export function rememberUpdateShown(now = Date.now()) {
  try { localStorage.setItem(shownKey(), String(now)); } catch { /* storage blocked */ }
}
