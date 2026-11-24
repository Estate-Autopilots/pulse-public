// SOUNDS-5 (owner, 19 Nov 2026: "the notification sounds are boring, the Pulse ringing sound is terrible"): which sound
// plays for each cue. "classic", the default, is what plays today: the chime in lib/notification-sound.ts (the same for
// every notification) and the ring in calls/tones.ts. Any other set plays a mastered file, public/sounds/<set>/<cue>.webm
// (Opus), or .mp3 where the browser cannot decode Opus: notifications at -16 LUFS, the ringtone a seamless loop at
// -14 LUFS, true peak under -1 dBTP (made and measured in the SOUNDS lanes, ~/ea-research/flow/reports/SOUNDS.md).
// The owner picks on the preview page (flow/to-mac/sounds-preview), which hands back one line:
//   PULSE_SOUNDS ringtone=glass-v3 message=A mention=A reminder=glass-v2 success=A error=A
// Switching is pasting that line into PICKS; sound-set.test.mjs fails if a picked file is not in public/sounds. Before
// the pick, one browser can try a line: localStorage "pulse.sounds" (only that browser hears it; "classic" undoes it).
export type Cue = "ringtone" | "message" | "mention" | "reminder" | "success" | "error";
export type NoticeCue = Exclude<Cue, "ringtone">;
export const CUES: readonly Cue[] = ["ringtone", "message", "mention", "reminder", "success", "error"];
export const NOTICE_CUES: readonly NoticeCue[] = ["message", "mention", "reminder", "success", "error"];
/** The owner's pick. Empty: the classic sounds everywhere (production stays on them until the owner picks). */
export const PICKS = "";
const TRY = "pulse.sounds";

/** "PULSE_SOUNDS ringtone=glass-v3 message=A …" → {ringtone: "glass-v3", message: "A"}. "classic", an unpicked "?",
 *  unknown cues and anything that is not a plain set name are left out (they play the classic sound). */
export function parsePicks(line: string): Partial<Record<Cue, string>> {
  const picks: Partial<Record<Cue, string>> = {};
  for (const [, cue, set] of line.matchAll(/(?:^|\s)([a-z]+)=(\S*)/g))
    if ((CUES as readonly string[]).includes(cue) && /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/.test(set) && set !== "classic") picks[cue as Cue] = set;
  return picks;
}

/** The set that plays a cue in this browser, or null for the classic sound. */
export function soundSet(cue: Cue): string | null {
  let line = PICKS;
  try { line = localStorage.getItem(TRY) ?? PICKS; } catch { /* storage blocked: the default */ }
  return parsePicks(line)[cue] ?? null;
}

/** The cue for a notification, from its event type ("chat.mention", "task.due_soon", "flow.alert"). */
export function cueFor(eventType?: string | null): NoticeCue {
  const [area = "", action = ""] = (eventType ?? "").split(".", 2);
  const done = /(^|_)(done|approved|completed|processed|ready)$/.test(action);
  // The attendance pings (check in, take a break, the day's digest) are reminders, "attendance.ask" included.
  if (area === "attendance") return done ? "success" : "reminder";
  if (/^(mention|reply|ask|help)$/.test(action)) return "mention";
  if (/(^|_)(failed|error|alert|rejected|blocked)$/.test(action)) return "error";
  if (done) return "success";
  if (/(^|_)(due|due_soon|reminder|nudge|late|overdue|missed_call)$/.test(action)) return "reminder";
  return "message";
}

let formats: string[] | null = null;
/** Opus first where the browser plays it (smaller, and gapless when looped); mp3 everywhere else. */
const extensions = () => formats ??= (() => {
  try { return new Audio().canPlayType('audio/webm; codecs="opus"') ? ["webm", "mp3"] : ["mp3"]; } catch { return ["mp3"]; }
})();
const decoded = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer | null>>>();

/** The cue's picked sound, decoded for this context (fetched once per page), or null when the cue is classic. The
 *  promise resolves to null when the file cannot be fetched or decoded, and the caller plays the classic sound. A file
 *  the server does not have stays classic until the page reloads; after a network error the next call tries again. */
export function soundFor(c: BaseAudioContext, cue: Cue): Promise<AudioBuffer | null> | null {
  const set = soundSet(cue); if (!set) return null;
  let cached = decoded.get(c); if (!cached) decoded.set(c, cached = new Map());
  const key = `${set}/${cue}`, ready = cached.get(key);
  if (ready) return ready;
  const loading = (async () => {
    let retry = false;
    for (const ext of extensions()) {
      try {
        const response = await fetch(`/sounds/${key}.${ext}`);
        if (response.ok) return await c.decodeAudioData(await response.arrayBuffer());
      } catch { retry = true; /* the next format */ }
    }
    if (retry) cached.delete(key);
    return null;
  })();
  cached.set(key, loading);
  return loading;
}

/** Plays a decoded sound at its mastered level. Its gain rises from 0 over 3 ms (a lossy file's first sample is not
 *  exactly 0) and falls over 20 ms when stopped. A looped sound plays until stop() is called. */
export function playSound(c: AudioContext, buffer: AudioBuffer, loop = false): () => void {
  const at = c.currentTime + 0.01, envelope = c.createGain(), source = c.createBufferSource();
  source.buffer = buffer; source.loop = loop;
  envelope.gain.setValueAtTime(0, at); envelope.gain.linearRampToValueAtTime(1, at + 0.003);
  source.connect(envelope); envelope.connect(c.destination);
  source.onended = () => { source.disconnect(); envelope.disconnect(); };
  source.start(at);
  let stopped = false;
  return () => {
    if (stopped) return; stopped = true;
    const from = Math.max(c.currentTime, at + 0.003);
    try {
      envelope.gain.cancelScheduledValues(from); envelope.gain.setValueAtTime(1, from); envelope.gain.linearRampToValueAtTime(0, from + 0.02);
      source.stop(from + 0.025);
    } catch { /* already ended, or the context is closed */ }
  };
}
