// AGENT-CHANNELS: the pure parts of the listening room (apps/web/app/listen), tested in listen-model.test.mjs.
// LISTEN-FAST (owner, 14 Nov 2026: "I'm waiting fifteen seconds... not snappy"): live words (the sound as 16 kHz PCM to
// the speech service, its messages read here), pieces cut at a pause for the server's Whisper when live words are not
// available, the level meter, the one line that says what the helper will do, the helper's actions as cards, and the
// after-call summary.

/** The longest audio piece for the server's Whisper (the fallback). A piece ends at the first pause after
 *  PIECE_MIN_MS, so words are not cut in half and the first words arrive sooner than with fixed 10-second pieces. */
export const PIECE_MS = 8000;
export const PIECE_MIN_MS = 3500;
export const PIECE_GAP_MS = 400;
/** SPEED-2 (owner, 15 Nov 2026: "show the first words fast"): the session's first piece ends at the first pause after
 *  1.5 s and is never longer than 4 s, so the first words show about 4 s sooner on the server's Whisper. */
export const FIRST_PIECE_MIN_MS = 1500;
export const FIRST_PIECE_MS = 4000;

/** The first recording format this browser can make that the server's Whisper reads (Safari only makes mp4). */
export function pickMime(isTypeSupported) {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    try { if (isTypeSupported(m)) return m; } catch { /* an old browser: try the next one */ }
  }
  return "";
}

/** The transcript so far plus what the server sent now: one entry per (piece, part), in order. */
export function mergeSegments(have, incoming) {
  const key = (s) => `${s.seq}:${s.part}`;
  const seen = new Map(have.map((s) => [key(s), s]));
  for (const s of incoming ?? []) if (s && typeof s.text === "string") seen.set(key(s), s);
  return [...seen.values()].sort((a, b) => a.seq - b.seq || a.part - b.part);
}

/** The last piece number the room has text for (the server sends only newer ones), -1 before any. */
export const lastSeq = (segments) => segments.reduce((m, s) => Math.max(m, s.seq), -1);

/** 75000 -> "1:15", 3725000 -> "1:02:05". */
export function clock(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Bytes as base64 (the audio piece's JSON body), in slices so a long piece never overflows the call stack. */
export function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

export const PURPOSES = [
  { value: "general", label: "Any conversation", hint: "It reacts only if something needs doing." },
  { value: "quotation", label: "Client call for a quotation", hint: "It drafts the quotation as the client speaks." },
  { value: "requirements", label: "Requirements", hint: "It flags each requirement and anything unclear." },
  { value: "meeting", label: "Team meeting", hint: "It keeps decisions and makes tasks for action items." },
];

/** The one line before Start: what this session will do, for the chosen purpose and helper. */
export function promiseLine(purpose, helper, instant) {
  const words = instant ? "Pulse writes down every word as it is said." : "Pulse writes down every word, a few seconds after it is said.";
  if (!helper) return `${words} Pick an AI helper to act on it too.`;
  const does = {
    quotation: "draft the quotation as the client speaks, list what is unclear, and make tasks for promises",
    requirements: "note each requirement (what, for whom, by when) and flag anything unclear",
    meeting: "note decisions and create tasks for follow-ups",
  }[purpose] ?? "step in when something needs doing: a task, a reminder or a quick answer";
  return `${helper} will ${does}.`;
}

/** Quiet or speaking: a pause detector over the microphone's loudness (RMS, 0..1) every few milliseconds. It follows the
 *  room's noise floor, so a fan or traffic is "quiet" too. step() is true when a piece should end here. */
export function pauseCutter({ minMs = PIECE_MIN_MS, maxMs = PIECE_MS, gapMs = PIECE_GAP_MS, firstMinMs = FIRST_PIECE_MIN_MS, firstMaxMs = FIRST_PIECE_MS } = {}) {
  // SPEED-2: the first piece is shorter (reset() starts each new piece, so only the first cut ends "first").
  let length = 0, quiet = 0, floor = 0.004, first = true;
  return {
    step(rms, dtMs) {
      const r = Math.max(0, Number(rms) || 0);
      if (r < floor * 3) floor = Math.min(Math.max(floor * 0.98 + r * 0.02, 0.002), 0.03);
      quiet = r < Math.max(floor * 2.5, 0.01) ? quiet + dtMs : 0;
      length += dtMs;
      const lo = first ? Math.min(firstMinMs, minMs) : minMs, hi = first ? Math.min(firstMaxMs, maxMs) : maxMs;
      if ((length >= lo && quiet >= gapMs) || length >= hi) { length = 0; quiet = 0; first = false; return true; }
      return false;
    },
    reset() { length = 0; quiet = 0; },
  };
}

/** The level meter's height (0..1) for a loudness (RMS): a log scale, so speaking fills most of it and silence none. */
export function meterLevel(rms) {
  const r = Number(rms) || 0;
  if (r <= 0.003) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(r) + 50) / 40));
}

/** RMS of a block of samples. */
export function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Microphone samples (Float32, any rate) as 16-bit little-endian PCM at 16 kHz, the speech service's format. Each
 *  output sample is the average of the input samples it covers (a cheap low-pass before dropping the rate). */
export function toPcm16(samples, inRate) {
  const ratio = inRate / 16000, n = Math.floor(samples.length / ratio), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, sum / (b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** The setup message for a live-words stream: text only, the language found by itself (Hindi, Marathi and English mixed). */
export function liveSetup(model) {
  return { setup: { model: `models/${model}`, generationConfig: { responseModalities: ["TEXT"] }, inputAudioTranscription: { languageCodes: [] } } };
}

/** One message from the live speech service, as the room needs it: ready, words still changing (interim), a finished
 *  sentence (final), "reconnect soon" (goAway), or nothing it uses. */
export function liveEvent(raw) {
  let m = raw;
  if (typeof raw === "string") { try { m = JSON.parse(raw); } catch { return null; } }
  if (!m || typeof m !== "object") return null;
  if (m.setupComplete) return { type: "ready" };
  if (m.goAway) return { type: "goAway" };
  if (m.error) return { type: "error", message: String(m.error.message ?? m.error).slice(0, 200) };
  const c = m.serverContent;
  if (!c) return null;
  const final = c.inputTranscription?.text, interim = c.interimInputTranscription?.text;
  if (typeof final === "string" && final.trim()) return { type: "final", text: final.trim() };
  if (typeof interim === "string") return { type: "interim", text: interim.trim() };
  return null;
}

const KINDS = [
  { re: /^tasks$/, kind: "task", label: "Task made" },
  { re: /^quotes$|^quotations$|^finance\/quotes$/, kind: "quote", label: "Quote drafted" },
  { re: /^docs$/, kind: "doc", label: "Doc written" },
  { re: /^contracts$/, kind: "contract", label: "Contract drafted" },
  { re: /^projects$|^tasks\/projects$/, kind: "project", label: "Project made" },
  { re: /^clients$/, kind: "client", label: "Client added" },
  { re: /^meetings$/, kind: "meeting", label: "Meeting saved" },
  { re: /^invoices$|^finance\/invoices$/, kind: "invoice", label: "Invoice drafted" },
];

/** What the AI helper did, as cards: every link to a record in its replies (a task, a quote, a doc …), newest first, one
 *  card per record. The card's name is the link's own words ("[Q-0042 for 40 signboards](/quotes/…)") or the words
 *  before it on its line. Only this app's own paths are kept (the card opens here, never another site). */
export function actionsIn(replies) {
  const out = new Map();
  const link = /(?:\[([^\]]{1,120})\]\()?(?:https?:\/\/[^\s/)]+)?\/((?:finance\/|tasks\/)?[a-z-]+)\/([A-Za-z0-9-]{6,64})(?=[)\s.,;!?]|$)\)?/g;
  for (const r of [...(replies ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    const body = String(r?.body ?? "");
    for (const m of body.matchAll(link)) {
      const k = KINDS.find((x) => x.re.test(m[2]));
      if (!k) continue;
      const href = `/${m[2]}/${m[3]}`;
      if (out.has(href)) continue;
      const line = body.slice(0, m.index).split("\n").pop()?.split(/[.!?)]\s+/).pop() ?? "";
      const named = (m[1] ?? line.replace(/[*_`#>•]+/g, " ").replace(/[\s:–-]+$/, "").trim().split(/\s+/).slice(-8).join(" ")).trim();
      out.set(href, { key: href, kind: k.kind, label: k.label, title: named.length > 2 ? named.slice(0, 80) : k.label, href, at: r.at, reply: r.id ?? null });
    }
  }
  return [...out.values()];
}

// Words that mark a decision, in English, Hindi and Marathi as the transcript writes them.
const DECIDED = /\b(agreed|decided|decision|final(?:ised|ized)?|confirmed|let's go with|we will go with|done deal|approved)\b|तय|फाइनल|फ़ाइनल|पक्का|निर्णय|ठरल[ंे]|मंजूर|मान लिया/i;

/** Up to five lines of the transcript that read as decisions. */
export function decisionsIn(segments, max = 5) {
  const out = [];
  for (const s of segments ?? []) {
    const t = String(s?.text ?? "").trim();
    if (t && DECIDED.test(t) && !out.includes(t)) out.push(t.length > 160 ? `${t.slice(0, 157).replace(/\s+\S*$/, "")}…` : t);
    if (out.length >= max) break;
  }
  return out;
}

/** The short summary: the summary's sentences, at most `max` lines. */
export function summaryLines(summary, max = 5) {
  return String(summary ?? "").split(/(?<=[.!?।])\s+/).map((x) => x.trim()).filter(Boolean).slice(0, max);
}

/** A helper's reply as plain words: a markdown link shows as its own words (the card beside it opens the record). */
export const plainReply = (body) => String(body ?? "").replace(/\[([^\]]{1,120})\]\((?:https?:\/\/[^\s)]+)?\/[^\s)]*\)/g, "$1");
