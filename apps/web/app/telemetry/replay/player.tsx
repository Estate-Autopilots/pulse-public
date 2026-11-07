"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): plays one session's replay (rrweb, MIT) in a sandboxed frame inside the page:
// play, pause, a time slider, speed, and ?t=<time> to start near a moment (a rage click, an error). Every typed value,
// password and data-private area was masked on the recording device; nothing here can show what someone typed.
import "rrweb/dist/style.css";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { duration, fit, seekOffset, type RrEvent } from "../../lib/friction-dashboard.mjs";
import { styles as ui } from "../../ui";
import { replayEvents, type ReplayMeta } from "./load";
import css from "./player.module.css";

type Replayer = InstanceType<typeof import("rrweb").Replayer>;
const SPEEDS = [1, 2, 4];

export function ReplayPlayer({ meta, at }: { meta: ReplayMeta; at?: string }) {
  const box = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const player = useRef<Replayer | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "empty">("loading");
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [size, setSize] = useState({ w: 1440, h: 900, scale: 1 });

  useEffect(() => {
    const ctl = new AbortController();
    let r: Replayer | null = null;
    void (async () => {
      try {
        const events = await replayEvents(meta.sid, meta.chunks.map((c) => c.seq), ctl.signal);
        if (ctl.signal.aborted) return;
        if (!events.some((e) => e.type === 2)) { setState("empty"); return; }
        const { Replayer } = await import("rrweb");
        if (ctl.signal.aborted || !stage.current) return;
        r = new Replayer(events as unknown as ConstructorParameters<typeof Replayer>[0], { root: stage.current, mouseTail: true, UNSAFE_replayCanvas: false, skipInactive: true, showWarning: false });
        player.current = r;
        const first = (events as RrEvent[]).find((e) => e.type === 4)?.data as { width?: number; height?: number } | undefined;
        const resize = (w: number, h: number) => setSize({ w, h, scale: fit(w, h, box.current?.clientWidth ?? w, Math.max(320, window.innerHeight * 0.7)) });
        resize(first?.width ?? 1440, first?.height ?? 900);
        r.on("resize", (d) => { const x = d as { width: number; height: number }; resize(x.width, x.height); });
        r.on("finish", () => setPlaying(false));
        setTotal(r.getMetaData().totalTime);
        const start = seekOffset(at, events[0].timestamp, events[events.length - 1].timestamp);
        r.pause(start);
        setNow(start);
        setState("ready");
      } catch { if (!ctl.signal.aborted) setState("failed"); }
    })();
    return () => { ctl.abort(); try { r?.destroy(); } catch { /* already gone */ } player.current = null; };
  }, [meta, at]);

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => { const r = player.current; if (r) setNow(r.getCurrentTime()); }, 250);
    return () => window.clearInterval(t);
  }, [playing]);

  const toggle = () => {
    const r = player.current;
    if (!r) return;
    if (playing) { r.pause(); setPlaying(false); return; }
    r.play(r.getCurrentTime() >= total ? 0 : r.getCurrentTime());
    setPlaying(true);
  };
  const seek = (ms: number) => { const r = player.current; if (!r) return; setNow(ms); if (playing) r.play(ms); else r.pause(ms); };
  const pace = (s: number) => { setSpeed(s); player.current?.setConfig({ speed: s }); };

  return <div className={css.player}>
    <div ref={box} className={css.box} style={{ height: Math.round(size.h * size.scale) }} aria-label="Session replay" role="region">
      <div ref={stage} className={css.stage} style={{ width: size.w, height: size.h, transform: `scale(${size.scale})` }} />
      {state !== "ready" ? <p className={css.note} role="status">{state === "loading" ? "Loading the replay…" : state === "empty" ? "This replay has no full picture of the screen yet." : "The replay could not play in this browser."}</p> : null}
    </div>
    <div className={css.controls}>
      <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={toggle} disabled={state !== "ready"} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{playing ? "Pause" : "Play"}</button>
      <input className={css.slider} type="range" min={0} max={Math.max(1, total)} step={100} value={Math.min(now, total)} disabled={state !== "ready"} aria-label="Time in the replay" onChange={(e) => seek(Number(e.target.value))} />
      <span className={css.time}>{duration(now)} / {duration(total)}</span>
      <span className={css.speeds} role="group" aria-label="Speed">{SPEEDS.map((s) => <button key={s} type="button" className={`${ui.btn} ${ui.btnSmall}`} aria-pressed={speed === s} onClick={() => pace(s)}>{s}×</button>)}</span>
    </div>
    <p className={css.fine}>Typed values, passwords and private areas were hidden on the device before anything was recorded.</p>
  </div>;
}
