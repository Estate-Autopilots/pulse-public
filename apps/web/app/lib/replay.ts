// BUGKIT-TELEMETRY (owner, 6 Nov 2026): session replay with rrweb (MIT), recorded on the device and stored only on
// Pulse's own server, per company (POST /api/v0/telemetry/replay, migration 1682). Started by telemetry-host.tsx when
// the company has usage recording and replay on (Settings → Privacy); loaded after the page is idle so it never slows the
// first screen.
//   Always on while replay is on: a rolling buffer of the last 30–60 s in memory, for a bug report the person chooses to
//   attach it to (attachReplay()). Only for the sampled share of sessions: chunks of events, gzip-compressed, sent every
//   10 s and when the page hides.
// Privacy, on the device (the API checks the masking again and refuses a chunk that carries typed text):
//   every input, text area and select is masked (passwords too) and keystrokes are never recorded, only that a field
//   changed; text inside data-private / data-redact is masked letter for letter; on money and people's personal screens
//   (lib/friction.mjs privateScreen) every word is masked; elsewhere e-mails, phone numbers, tokens and amounts are
//   masked; the bug reporter, video, frames and data-replay-block areas are left out entirely; no canvas, no fonts.
import { privateScreen, replayText } from "./friction.mjs";
import { randomId, screenOf, telemetrySession } from "./telemetry.mjs";

const ENDPOINT = "/api/v0/telemetry/replay";
const UPLOAD_MS = 10_000;
const CHECKOUT_MS = 30_000;
const MAX_PENDING = 5000;
const KEEPALIVE_MAX = 60_000;
const SEQ_KEY = "pulse.replay.seq", ON_KEY = "pulse.replay.on", SID_KEY = "pulse.replay.sid";

type ReplayEvent = { type: number; timestamp: number; data?: unknown };
type Recorder = { sid: string; segments: ReplayEvent[][]; pending: ReplayEvent[]; upload: boolean; stop: (() => void) | null };
let rec: Recorder | null = null;
let starting = false;

const session = () => { try { return window.sessionStorage; } catch { return null; } };
/** The tab's usage session (telemetry's, so replays line up with its events), else a replay-only one. */
function sessionId(): string {
  const t = telemetrySession();
  if (t) return t;
  const s = session();
  const saved = s?.getItem(SID_KEY);
  if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  const id = randomId(16);
  s?.setItem(SID_KEY, id);
  return id;
}
function nextSeq(sid: string): number {
  const s = session();
  let n = 0;
  try { const saved = JSON.parse(s?.getItem(SEQ_KEY) ?? "null") as { sid: string; n: number } | null; if (saved?.sid === sid) n = saved.n + 1; } catch { /* fresh */ }
  try { s?.setItem(SEQ_KEY, JSON.stringify({ sid, n })); } catch { /* storage off */ }
  return n;
}

/** rrweb's record options: the privacy rules above. */
export function replayOptions(href: () => string = () => window.location.href) {
  return {
    maskAllInputs: true,
    maskInputOptions: { color: true, date: true, "datetime-local": true, email: true, month: true, number: true, range: true, search: true, tel: true, text: true, time: true, url: true, week: true, textarea: true, select: true, password: true },
    maskInputFn: (text: string) => "*".repeat(Math.min(text.length, 12)),
    maskTextSelector: "*",
    maskTextFn: (text: string, el: HTMLElement | null) => replayText(text, { inPrivate: !!el?.closest?.("[data-private],[data-redact]"), screenPrivate: privateScreen(href()) }),
    blockSelector: "[data-bug-reporter],[data-bug-picker],[data-capture-skip],[data-replay-block],video,iframe,object,embed",
    recordCanvas: false, collectFonts: false, inlineImages: false, recordCrossOriginIframes: false,
    sampling: { mousemove: 100, scroll: 200, media: 800, input: "last" as const },
    slimDOMOptions: "all" as const,
    checkoutEveryNms: CHECKOUT_MS,
  };
}

async function gzip(text: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function sendChunk(r: Recorder, events: ReplayEvent[], reason: "sample" | "report", final = false): Promise<{ from: number; to: number } | null> {
  if (!events.length) return null;
  const gz = await gzip(JSON.stringify(events));
  if (!gz) return null;
  const from = events[0].timestamp, to = events[events.length - 1].timestamp;
  const body = JSON.stringify({ sid: r.sid, seq: nextSeq(r.sid), route: screenOf(window.location.href), from, to, n: events.length, reason, gz });
  if (final && body.length >= KEEPALIVE_MAX) return null;
  const res = await fetch(ENDPOINT, { method: "POST", body, keepalive: final, credentials: "same-origin", headers: { "content-type": "application/json" } });
  if ([400, 401, 403, 404, 413].includes(res.status)) { r.upload = false; return null; }
  const answer = await res.json().catch(() => ({})) as { accepted?: boolean };
  if (answer.accepted === false) r.upload = false;
  return res.ok && answer.accepted !== false ? { from, to } : null;
}

/** Starts the recorder once per page (after the page is idle). `sample` is the share of sessions whose replays are sent
 *  (decided once per tab session); the buffer for bug reports runs either way. */
export function startReplay({ sample = 1 }: { sample?: number } = {}) {
  if (typeof window === "undefined" || rec || starting) return;
  starting = true;
  const s = session();
  let upload = s?.getItem(ON_KEY);
  if (upload !== "1" && upload !== "0") { upload = Math.random() < sample ? "1" : "0"; s?.setItem(ON_KEY, upload); }
  const go = async () => {
    try {
      const { record } = await import("rrweb");
      const r: Recorder = { sid: sessionId(), segments: [[]], pending: [], upload: upload === "1", stop: null };
      const options = {
        ...replayOptions(),
        emit(event: ReplayEvent, isCheckout?: boolean) {
          // A fresh full snapshot every 30 s starts a segment; the buffer keeps the last two (30–60 s).
          if (isCheckout && event.type === 4) { r.segments.push([]); if (r.segments.length > 2) r.segments.shift(); }
          r.segments[r.segments.length - 1].push(event);
          if (r.upload) { r.pending.push(event); if (r.pending.length > MAX_PENDING) r.pending.splice(0, r.pending.length - MAX_PENDING); }
        },
      };
      const stop = record(options as unknown as Parameters<typeof record>[0]);
      r.stop = stop ?? null;
      rec = r;
      const flush = (final = false) => { if (r.upload && r.pending.length) void sendChunk(r, r.pending.splice(0), "sample", final).catch(() => {}); };
      window.setInterval(() => { if (document.visibilityState === "visible") flush(); }, UPLOAD_MS);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
      window.addEventListener("pagehide", () => flush(true));
    } catch { /* replay unavailable: the app goes on */ } finally { starting = false; }
  };
  const w = window as Window & { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(() => void go(), { timeout: 4000 }); else window.setTimeout(() => void go(), 1500);
}

/** True when a replay of the last moments can go with a bug report. */
export const replayReady = () => !!rec && rec.segments.some((s) => s.length > 1);

/** The last 30–60 s, sent as a 'report' chunk; the report then names the session and the window. Null when replay is
 *  off or the chunk could not go. */
export async function attachReplay(): Promise<{ sid: string; from: number; to: number } | null> {
  const r = rec;
  if (!r) return null;
  const events = r.segments.flat();
  if (events.length < 2) return null;
  try {
    const sent = await sendChunk({ ...r, upload: true }, events, "report");
    return sent ? { sid: r.sid, ...sent } : null;
  } catch { return null; }
}

/** For tests: the recorder's in-memory events. */
export const replayBuffer = (): readonly ReplayEvent[] => rec?.segments.flat() ?? [];
