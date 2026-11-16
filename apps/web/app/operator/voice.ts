"use client";
// AGENT-OPERATOR (owner, 13 Nov 2026, T4.2.4: "live conversations ... with the thinking layer separately done ... as the
// conversation starts everything is just being there ... it does everything just live talking to that"). The smallest
// live demo of the two layers, with no key and nothing new on the server:
//   * the talking layer is the browser's own speech: it hears the person (SpeechRecognition, en-IN / hi-IN / mr-IN) and
//     speaks (speechSynthesis), and stops talking the moment the person speaks again (barge-in);
//   * the thinking layer is the AI employee itself: what the person says goes into the chat as their message, and the
//     talking layer reads out its replies and the steps it takes on the page while it works, so they talk while it works.
// Only after a tap (a browser asks for the microphone), and only in browsers that have speech recognition (Chrome,
// Edge, Safari). Chrome's recognition is Google's speech service: the button says so before the first use.
import { useCallback, useEffect, useRef, useState } from "react";

type Rec = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onspeechstart: (() => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
type RecCtor = new () => Rec;
export type Lang = "en-IN" | "hi-IN" | "mr-IN";
export const LANGS: { key: Lang; label: string }[] = [{ key: "en-IN", label: "English" }, { key: "hi-IN", label: "हिन्दी" }, { key: "mr-IN", label: "मराठी" }];

const ctor = (): RecCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
/** Stops the AI talking now. */
const hush = () => { try { window.speechSynthesis.cancel(); } catch { /* none */ } };
/** Ends a recogniser without it starting itself again. */
function drop(r: Rec | null) { if (!r) return; r.onend = null; r.onresult = null; try { r.abort(); } catch { /* none */ } }
/** The one recogniser of this tab and whether voice is on (one operator view is open at a time). */
const box: { rec: Rec | null; want: boolean } = { rec: null, want: false };
export const voiceSupported = () => !!ctor() && typeof window !== "undefined" && "speechSynthesis" in window;

/** Plain words to say: no links, ids, markdown or long numbers read digit by digit. */
export function speakable(text: string, max = 280): string {
  const s = text.replace(/```[\s\S]*?```/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\/[\w/-]+/g, " ").replace(/[*_#>`|[\]()]/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, " ").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("। "), cut.lastIndexOf("? "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

/** The talking layer: on/off, what it heard (live), and say() for what the thinking layer did or answered. */
export function useVoiceLayer(onHeard: (text: string) => void) {
  const [on, setOn] = useState(false), [lang, setLang] = useState<Lang>("en-IN");
  const [heard, setHeard] = useState(""), [speaking, setSpeaking] = useState(false), [error, setError] = useState("");
  const heardCb = useRef(onHeard);
  useEffect(() => { heardCb.current = onHeard; });

  const stopTalking = useCallback(() => { hush(); setSpeaking(false); }, []);
  const say = useCallback((text: string) => {
    if (!box.want) return;
    const words = speakable(text); if (!words) return;
    const u = new SpeechSynthesisUtterance(words); u.lang = lang; u.rate = 1.05;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang === lang) ?? window.speechSynthesis.getVoices().find((v) => v.lang.startsWith(lang.slice(0, 2)));
    if (voice) u.voice = voice;
    u.onstart = () => setSpeaking(true); u.onend = () => setSpeaking(window.speechSynthesis.speaking);
    window.speechSynthesis.speak(u);
  }, [lang]);

  const start = useCallback(() => {
    const C = ctor(); if (!C) { setError("This browser cannot hear speech. Try Chrome or Edge."); return; }
    const r = new C(); r.lang = lang; r.continuous = true; r.interimResults = true;
    // Barge-in: the person speaks, the AI stops talking.
    r.onspeechstart = () => stopTalking();
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0]?.transcript ?? "";
        if (e.results[i].isFinal) { const said = t.trim(); if (said) { setHeard(""); heardCb.current(said); } } else live += t;
      }
      if (live) { stopTalking(); setHeard(live.trim()); }
    };
    r.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { box.want = false; setOn(false); setError("The microphone is blocked for Pulse in this browser."); } };
    // Recognition ends by itself after a silence: start it again while voice is on.
    r.onend = () => { if (box.want) { try { r.start(); } catch { /* already started */ } } };
    box.rec = r; box.want = true; setError("");
    try { r.start(); setOn(true); } catch { setError("The microphone did not start. Try again."); box.want = false; }
  }, [lang, stopTalking]);
  const stop = useCallback(() => { box.want = false; setOn(false); setHeard(""); drop(box.rec); box.rec = null; stopTalking(); }, [stopTalking]);
  useEffect(() => () => { box.want = false; drop(box.rec); box.rec = null; hush(); }, []);
  // A new language: listen again in it.
  useEffect(() => { if (!box.want) return; drop(box.rec); box.rec = null; queueMicrotask(start); }, [lang, start]);
  return { on, lang, setLang, heard, speaking, error, start, stop, say };
}
