"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): where people click, rage-click and dead-click on one screen, drawn over the
// newest replay frame of that screen (rrweb, paused just after its last full snapshot: what the screen looked like, with
// typed values and private areas masked), or over a plain grid when there is no frame yet.
import "rrweb/dist/style.css";
import { useEffect, useRef, useState } from "react";
import { fit, HEAT, lastFrame } from "../lib/friction-dashboard.mjs";
import { replayEvents, replayMeta } from "../telemetry/replay/load";
import css from "../telemetry/replay/player.module.css";

type Heat = { route: string; days: number; points: { fx: number; fy: number; kind: "click" | "rage" | "dead" }[]; frame: { sid: string; seq: number } | null; viewport: { width: number; height: number } };
type Replayer = InstanceType<typeof import("rrweb").Replayer>;

export function Heatmap({ route, days }: { route: string; days: number }) {
  const box = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [heat, setHeat] = useState<Heat | null>(null);
  const [state, setState] = useState<"loading" | "frame" | "grid" | "failed">("loading");
  const [size, setSize] = useState({ w: 1440, h: 900, scale: 0.5 });

  useEffect(() => {
    const ctl = new AbortController();
    let r: Replayer | null = null;
    const place = (w: number, h: number) => setSize({ w, h, scale: fit(w, h, box.current?.clientWidth ?? 720) });
    void (async () => {
      try {
        const res = await fetch(`/api/v0/telemetry/heat?${new URLSearchParams({ route, days: String(days) })}`, { cache: "no-store", signal: ctl.signal });
        if (!res.ok) throw new Error("heat");
        const h = await res.json() as Heat;
        setHeat(h);
        place(h.viewport.width, h.viewport.height);
        if (!h.frame) { setState("grid"); return; }
        const meta = await replayMeta(h.frame.sid, ctl.signal);
        const upTo = meta.chunks.filter((c) => c.seq <= h.frame!.seq).slice(-6).map((c) => c.seq);
        const frame = lastFrame(await replayEvents(h.frame.sid, upTo, ctl.signal));
        if (!frame || ctl.signal.aborted || !stage.current) { setState("grid"); return; }
        const { Replayer } = await import("rrweb");
        r = new Replayer(frame.events as unknown as ConstructorParameters<typeof Replayer>[0], { root: stage.current, UNSAFE_replayCanvas: false, showWarning: false, mouseTail: false });
        const m = frame.events.find((e) => e.type === 4)?.data as { width?: number; height?: number } | undefined;
        if (m?.width && m.height) place(m.width, m.height);
        r.pause(frame.offset);
        setState("frame");
      } catch { if (!ctl.signal.aborted) setState("failed"); }
    })();
    return () => { ctl.abort(); try { r?.destroy(); } catch { /* already gone */ } };
  }, [route, days]);

  // The points, drawn at the frame's displayed size.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !heat) return;
    const w = Math.round(size.w * size.scale), h = Math.round(size.h * size.scale), dpr = window.devicePixelRatio || 1;
    el.width = w * dpr; el.height = h * dpr; el.style.width = `${w}px`; el.style.height = `${h}px`;
    const g = el.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    // Clicks first, then dead, then rage on top.
    for (const kind of ["click", "dead", "rage"] as const) {
      g.fillStyle = HEAT[kind].colour;
      g.globalAlpha = kind === "click" ? 0.28 : 0.55;
      const radius = kind === "click" ? 7 : 10;
      for (const p of heat.points) if (p.kind === kind) { g.beginPath(); g.arc(p.fx * w, p.fy * h, radius, 0, Math.PI * 2); g.fill(); }
    }
  }, [heat, size, state]);

  const counts = { click: 0, rage: 0, dead: 0 };
  for (const p of heat?.points ?? []) counts[p.kind]++;
  return <div className={css.player}>
    <ul className={css.legend} aria-label="Heatmap legend">
      {(["rage", "dead", "click"] as const).map((k) => <li key={k}><span className={css.dot} style={{ background: HEAT[k].colour }} aria-hidden="true" />{HEAT[k].label}: {counts[k]}</li>)}
    </ul>
    <div ref={box} className={css.box} style={{ height: Math.round(size.h * size.scale) }} role="img"
      aria-label={`Heatmap of ${route}: ${counts.rage} rage clicks, ${counts.dead} dead clicks, ${counts.click} clicks`}>
      <div ref={stage} className={css.stage} style={{ width: size.w, height: size.h, transform: `scale(${size.scale})`, visibility: state === "frame" ? "visible" : "hidden" }} />
      {state === "grid" || state === "failed" ? <div className={css.grid} /> : null}
      <canvas ref={canvas} className={css.overlay} aria-hidden="true" />
      {state === "loading" ? <p className={css.note} role="status">Loading the screen…</p> : null}
    </div>
    <p className={css.fine}>{state === "frame" ? "Drawn over the newest replay of this screen; typed values and private areas are hidden." : state === "failed" ? "The heatmap could not load. Try again in a moment." : "No replay of this screen yet, so the points are drawn on a grid of the screen's size."}</p>
  </div>;
}
