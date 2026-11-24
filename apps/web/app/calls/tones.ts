// CHAT-VOICE: call sounds, made in the browser (no audio files): the ring for a call ringing me (a soft two-note
// chime every 2.6 s, with the phone vibrating), the ringback while I wait for an answer (the Indian double ring,
// 400 + 450 Hz), and three short notes when a call ends. Browsers play sound only after the page has been touched
// once; until then the ring is the card, the vibration and the tab title.
// SOUNDS-5: a ringtone picked in lib/sound-set.ts loops its file instead of the chime (classic by default); the phone
// still vibrates every 2.6 s. Ringback, hangup and the recording notice stay as they are.
import { playSound, soundFor } from "../lib/sound-set";
type Tone = "ring" | "ringback" | null;
let ctx: AudioContext | null = null, current: Tone = null, timer: ReturnType<typeof setInterval> | null = null, gain: GainNode | null = null;
let stopRing: (() => void) | null = null, turn = 0;
const context = () => {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  if (!ctx) { ctx = new AudioContext(); gain = ctx.createGain(); gain.gain.value = 0.18; gain.connect(ctx.destination); }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
};
function note(freqs: number[], at: number, length: number, level = 1) {
  const c = context(); if (!c || !gain) return;
  const g = c.createGain(); g.connect(gain);
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(level, at + 0.02); g.gain.setValueAtTime(level, at + length - 0.05); g.gain.linearRampToValueAtTime(0, at + length);
  for (const f of freqs) { const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(g); o.start(at); o.stop(at + length + 0.02); }
}
function ringOnce() {
  const c = context(); if (!c) return; const t = c.currentTime + 0.02;
  note([659.25, 1318.5], t, 0.32, 0.9); note([830.6, 1661.2], t + 0.36, 0.42, 0.9);
  note([659.25, 1318.5], t + 1.0, 0.32, 0.7); note([830.6, 1661.2], t + 1.36, 0.42, 0.7);
  navigator.vibrate?.([450, 200, 450]);
}
function ring() {
  const c = context(), file = c && soundFor(c, "ringtone"), mine = turn;
  const classic = () => { if (timer) clearInterval(timer); ringOnce(); timer = setInterval(ringOnce, 2600); };
  if (!c || !file) return classic();
  const buzz = () => navigator.vibrate?.([450, 200, 450]); buzz(); timer = setInterval(buzz, 2600);
  void file.then((buffer) => {
    if (mine !== turn) return; // answered, declined or over while the file loaded
    if (!buffer) return classic();
    try { stopRing = playSound(c, buffer, true); } catch { classic(); }
  });
}
function ringbackOnce() { const c = context(); if (!c) return; const t = c.currentTime + 0.02; note([400, 450], t, 0.4, 0.55); note([400, 450], t + 0.6, 0.4, 0.55); }
export const tones = {
  /** Called from a click (start, answer): lets the page play sound from then on. */
  unlock() { context(); },
  set(tone: Tone) {
    if (tone === current) return;
    current = tone; turn++; if (timer) { clearInterval(timer); timer = null; }
    stopRing?.(); stopRing = null;
    if (typeof navigator !== "undefined") navigator.vibrate?.(0);
    if (tone === "ring") ring();
    else if (tone === "ringback") { ringbackOnce(); timer = setInterval(ringbackOnce, 3000); }
  },
  hangup() { const c = context(); if (!c) return; const t = c.currentTime + 0.02; [0, 0.22, 0.44].forEach((d) => note([480, 620], t + d, 0.16, 0.5)); },
  /** CALLS-V2: the call is now being recorded (everyone in it hears two rising notes, as well as seeing it). */
  notice() { const c = context(); if (!c) return; const t = c.currentTime + 0.02; note([660], t, 0.18, 0.45); note([880], t + 0.24, 0.24, 0.45); },
};
