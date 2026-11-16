"use client";
// WA-AUDIO (1112): one clip at a time: listen, correct the machine draft so it says exactly what was said, mark the
// languages, speakers and how clear the audio is, save and go to the next. What is saved scores the speech engines.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Rewind, SkipForward } from "lucide-react";
import { send } from "../../net";
import css from "./review.module.css";

type Mine = { text: string; languages: string[]; speakers: number | null; audio: string | null; note: string | null; status: "done" | "skipped"; updatedAt: string };
export type ReviewItem = { sha256: string; label: string; kind: "voice" | "audio" | "video"; durationS: number | null; draft: string; draftSource: string;
  alternatives: { label: string; text: string }[]; mine: Mine | null; others: number };
export type ReviewSet = { set: string; clips: number; seconds: number; mine: number; reviewed: number };

const LANGS: [string, string][] = [["en", "English"], ["hi", "Hindi"], ["mr", "Marathi"], ["other", "Other"]];
const AUDIO: [string, string][] = [["clear", "Clear"], ["noisy", "Noisy"], ["partly_unclear", "Some words unclear"], ["no_speech", "No speech"]];
const KIND = { voice: "Voice note", audio: "Audio file", video: "Video sound" } as const;
const mmss = (s: number | null) => s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function ReviewApp({ set, items: initial }: { set: string; items: ReviewItem[] }) {
  const [items, setItems] = useState(initial);
  const [at, setAt] = useState(() => Math.max(0, initial.findIndex((i) => !i.mine)));
  const [todoOnly, setTodoOnly] = useState(false);
  const item = items[at];
  const [text, setText] = useState(""), [langs, setLangs] = useState<string[]>([]), [speakers, setSpeakers] = useState(""), [audio, setAudio] = useState(""), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const started = useRef(0), player = useRef<HTMLAudioElement>(null), box = useRef<HTMLTextAreaElement>(null);
  // Another clip on screen: the editor starts from its saved review, else the machine draft (reset while rendering).
  const [open, setOpen] = useState<string | null>(null);
  if (item && item.sha256 !== open) {
    setOpen(item.sha256);
    setText(item.mine?.text ?? item.draft); setLangs(item.mine?.languages ?? []); setSpeakers(item.mine?.speakers != null ? String(item.mine.speakers) : "");
    setAudio(item.mine?.audio ?? ""); setNote(item.mine?.note ?? ""); setError("");
  }
  // The time spent on a clip counts from when it opened.
  useEffect(() => { started.current = Date.now(); }, [open]);
  const shown = useMemo(() => items.map((it, i) => ({ it, i })).filter(({ it }) => !todoOnly || !it.mine), [items, todoOnly]);
  const done = items.filter((i) => i.mine?.status === "done").length;
  const back = (s: number) => { const a = player.current; if (a) a.currentTime = Math.max(0, a.currentTime - s); };
  const rate = (r: number) => { const a = player.current; if (a) a.playbackRate = r; };
  // Alt+Space plays or pauses, Alt+← goes back 3 s, even while typing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.code === "Space") { e.preventDefault(); const a = player.current; if (a) void (a.paused ? a.play() : a.pause()); }
      if (e.code === "ArrowLeft") { e.preventDefault(); const a = player.current; if (a) a.currentTime = Math.max(0, a.currentTime - 3); }
    };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  }, []);
  if (!item) return null;
  const save = async (status: "done" | "skipped") => {
    setBusy(true); setError("");
    try {
      const body = { text, status, languages: langs, speakers: speakers === "" ? null : Number(speakers), audio: audio || null, note, seconds: Math.round((Date.now() - started.current) / 1000) };
      await send(`chats/whatsapp/review/${set}/${item.sha256}`, body);
      const mine: Mine = { text, languages: langs, speakers: body.speakers, audio: body.audio, note, status, updatedAt: new Date().toISOString() };
      const next = items.map((it, i) => i === at ? { ...it, mine } : it);
      setItems(next);
      const after = next.findIndex((it, i) => i > at && !it.mine);
      const first = next.findIndex((it) => !it.mine);
      setAt(after >= 0 ? after : first >= 0 ? first : Math.min(at + 1, next.length - 1));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const toggle = (k: string) => setLangs((l) => l.includes(k) ? l.filter((x) => x !== k) : [...l, k]);
  return <div className={css.wrap}>
    <aside className={css.list} aria-label="Clips">
      <div className={css.listHead}>
        <span>{done} of {items.length} checked</span>
        <label className={css.todo}><input type="checkbox" checked={todoOnly} onChange={(e) => setTodoOnly(e.target.checked)} /> Not checked yet</label>
      </div>
      <div className={css.meter} aria-hidden="true"><i style={{ width: `${Math.round(done / Math.max(1, items.length) * 100)}%` }} /></div>
      <ol>
        {shown.map(({ it, i }) => <li key={it.sha256}>
          <button type="button" className={css.row} data-on={i === at || undefined} data-state={it.mine?.status ?? "todo"} onClick={() => setAt(i)}>
            <span className={css.state} aria-hidden="true">{it.mine?.status === "done" ? <Check size={13} /> : it.mine?.status === "skipped" ? <SkipForward size={12} /> : null}</span>
            <span className={css.label}>{it.label}</span><span className={css.meta}>{KIND[it.kind]} · {mmss(it.durationS)}</span>
          </button>
        </li>)}
      </ol>
    </aside>
    <section className={css.editor} aria-label={`Clip ${item.label}`}>
      <header className={css.head}>
        <button type="button" className={css.nav} onClick={() => setAt(Math.max(0, at - 1))} disabled={at === 0} aria-label="Previous clip"><ChevronLeft size={18} /></button>
        <h2>{item.label} <span>{KIND[item.kind]} · {mmss(item.durationS)}{item.others ? ` · checked by ${item.others} other${item.others === 1 ? "" : "s"}` : ""}</span></h2>
        <button type="button" className={css.nav} onClick={() => setAt(Math.min(items.length - 1, at + 1))} disabled={at === items.length - 1} aria-label="Next clip"><ChevronRight size={18} /></button>
      </header>
      <div className={css.player}>
        <audio ref={player} key={item.sha256} controls preload="metadata" src={`/api/v0/chats/whatsapp/review/${set}/${item.sha256}/audio`} />
        <button type="button" onClick={() => back(3)} title="Back 3 seconds (Alt+←)"><Rewind size={14} /> 3 s</button>
        {[0.75, 1, 1.25].map((r) => <button key={r} type="button" onClick={() => rate(r)}>{r}×</button>)}
      </div>
      <p className={css.how}>Write <b>exactly</b> what is said, every word, also repeated words and “haan”, “hmm”. Hindi and Marathi words in Devanagari, English words in English letters, names as usually written. Numbers as digits or words. A word you cannot make out: <b>[unclear]</b>. Nothing said: leave it empty and choose “No speech”. Alt+Space plays or pauses.</p>
      <textarea ref={box} className={css.text} value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} aria-label="What is said" />
      <div className={css.tools}>
        <button type="button" onClick={() => setText(item.draft)}>Start again from the draft</button>
        <button type="button" onClick={() => { setText(""); box.current?.focus(); }}>Clear</button>
      </div>
      {item.alternatives.length ? <details className={css.alts}>
        <summary>Other machine versions ({item.alternatives.length})</summary>
        {item.alternatives.map((a, k) => <div key={k} className={css.alt}><p>{a.text || "(nothing)"}</p><button type="button" onClick={() => setText(a.text)}>Use version {k + 1}</button></div>)}
      </details> : null}
      <div className={css.fields}>
        <fieldset><legend>Languages heard</legend>{LANGS.map(([k, l]) => <label key={k}><input type="checkbox" checked={langs.includes(k)} onChange={() => toggle(k)} /> {l}</label>)}</fieldset>
        <fieldset><legend>Audio</legend>{AUDIO.map(([k, l]) => <label key={k}><input type="radio" name="audio" checked={audio === k} onChange={() => setAudio(k)} /> {l}</label>)}</fieldset>
        <label className={css.speakers}>Speakers <input type="number" min={0} max={20} value={speakers} onChange={(e) => setSpeakers(e.target.value)} /></label>
      </div>
      <input className={css.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="A note (optional): music, two people at once, a name you are unsure of…" aria-label="Note" />
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.actions}>
        <button type="button" className={css.primary} onClick={() => void save("done")} disabled={busy}>{busy ? "Saving…" : "Save and next"}</button>
        <button type="button" onClick={() => void save("skipped")} disabled={busy}>Skip this clip</button>
        {item.mine ? <span className={css.saved}>{item.mine.status === "done" ? "Saved" : "Skipped"} {new Date(item.mine.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span> : null}
      </div>
    </section>
  </div>;
}
