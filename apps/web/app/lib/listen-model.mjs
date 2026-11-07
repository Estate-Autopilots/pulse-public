// AGENT-CHANNELS: the pure parts of the listening room (apps/web/app/listen), tested in listen-model.test.mjs.

/** How long each audio piece is: short enough for a live transcript, long enough for Whisper to have context. */
export const PIECE_MS = 10000;

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
