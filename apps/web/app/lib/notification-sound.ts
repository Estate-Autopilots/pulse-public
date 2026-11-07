// A short, warm two-note chime for browser arrivals. Native apps and calls own their sounds.
const KEY = "pulse.notify.sound", CHANGED = "pulse:notification-sound";
let context: AudioContext | null = null, lastPlayed = -Infinity, fallbackEnabled = true;

function enabled() {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return fallbackEnabled; }
}

async function unlock(): Promise<boolean> {
  try {
    if (typeof AudioContext === "undefined") return false;
    if (!context || context.state === "closed") { context = new AudioContext(); lastPlayed = -Infinity; }
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch { return false; }
}

async function play(preview = false): Promise<boolean> {
  if (!preview && !enabled()) return false;
  // Never queue an alert behind the browser's autoplay gate. A click/key unlocks future arrivals.
  if (preview ? !await unlock() : context?.state !== "running") return false;
  const c = context!;
  if (!preview && c.currentTime - lastPlayed < 1.5) return false;
  lastPlayed = c.currentTime;
  try {
    for (const [frequency, delay] of [[659.25, 0], [987.77, 0.16]]) {
      const at = c.currentTime + 0.01 + delay, gain = c.createGain(), note = c.createOscillator();
      note.type = "sine"; note.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.2, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.45);
      gain.gain.linearRampToValueAtTime(0, at + 0.48);
      gain.connect(c.destination); note.connect(gain);
      note.onended = () => { note.disconnect(); gain.disconnect(); };
      note.start(at); note.stop(at + 0.5);
    }
    return true;
  } catch { return false; }
}

export const notificationSound = {
  enabled, unlock, play,
  setEnabled(on: boolean) {
    fallbackEnabled = on;
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
    window.dispatchEvent(new Event(CHANGED));
    if (on) void unlock();
  },
  subscribe(listener: () => void) {
    window.addEventListener("storage", listener); window.addEventListener(CHANGED, listener);
    return () => { window.removeEventListener("storage", listener); window.removeEventListener(CHANGED, listener); };
  },
};
