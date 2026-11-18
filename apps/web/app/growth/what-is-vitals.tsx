"use client";
// GROWTH-LOOP slice 2 (owner, 8 Nov 2026): "Powered by <company> · Vitals" and the small "What is Vitals?" card for
// client-side people and guests who meet Vitals through another company (Codex funnel concept 1: pinned under the
// header, the explainer on the left, one sentence, one button, ×). The explainer slot plays the owner's 60-second video
// when PULSE_EXPLAINER_VIDEO_URL is set; until then it shows Codex's poster and says the video is coming.
// What they do with it is reported once (viewed, clicked, dismissed) under the company that brought them.
import { useEffect, useRef, useState } from "react";
import { Play, X } from "lucide-react";
import { DISMISS_KEY, REF_KEY, VISITOR_KEY, explainer, newVisitorId, pitch, poweredBy, startHref, stillDismissed, type GrowthSource } from "../lib/growth.mjs";
import css from "./growth.module.css";

type Props = {
  /** The company whose chat, quotation or agreement this is (shown first). */
  company: string;
  source: GrowthSource;
  /** Signed in (a client seat): reports go to /api/v0/growth/seen and Start free opens /start/space. */
  signedIn: boolean;
  /** Signed out on a quotation link: its token (reports go to that link's own /seen route). */
  linkToken?: string;
  /** The company's @handle when the page knows it (otherwise the first report answers it). */
  via?: string | null;
  /** The owner's explainer video (https), from the server's PULSE_EXPLAINER_VIDEO_URL. */
  video?: string | null;
  /** Their own company's name, if the page knows it (pre-fills Start free). */
  prefillName?: string | null;
  /** A one-line strip (chats): the card opens from "What is Vitals?". */
  compact?: boolean;
};

const read = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* private window */ } };

async function report(p: Props, event: "viewed" | "clicked" | "dismissed"): Promise<string | null> {
  try {
    let r: Response;
    if (p.linkToken) {
      let visitor = read(VISITOR_KEY);
      if (!visitor || !/^[a-z0-9]{32}$/.test(visitor)) { visitor = newVisitorId(); write(VISITOR_KEY, visitor); }
      r = await fetch(`/api/accept/${p.linkToken}/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, visitor }), cache: "no-store", keepalive: true });
    } else {
      r = await fetch("/api/v0/growth/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, source: p.source }), cache: "no-store", keepalive: true });
    }
    const data = r.ok ? await r.json() as { via?: string | null } : null;
    return data?.via ?? null;
  } catch { return null; }
}

export function WhatIsVitals(p: Props) {
  const [shown, setShown] = useState<"unknown" | "card" | "closed">("unknown");
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [via, setVia] = useState<string | null>(p.via ?? null);
  const [going, setGoing] = useState(false);
  const told = useRef(false);
  const slot = explainer(p.video);

  useEffect(() => {
    const t = setTimeout(() => setShown(stillDismissed(read(DISMISS_KEY)) ? "closed" : "card"), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (shown !== "card" || told.current || (p.compact && !open)) return;
    told.current = true;
    void report(p, "viewed").then((v) => { if (v) setVia((x) => x ?? v); });
  }, [shown, open, p]);

  const close = () => { write(DISMISS_KEY, String(Date.now())); setShown("closed"); setOpen(false); void report(p, "dismissed"); };
  const start = async () => {
    setGoing(true);
    const v = via ?? await report(p, "clicked");
    if (via) void report(p, "clicked");
    if (v) write(REF_KEY, JSON.stringify({ via: v, source: p.source, at: Date.now() }));
    window.location.assign(startHref({ signedIn: p.signedIn, via: v, source: p.source, name: p.prefillName }));
  };

  const line = <p className={css.powered}><span>{poweredBy(p.company)}</span>
    {p.compact && shown === "card" && !open ? <button type="button" className={css.ask} onClick={() => setOpen(true)}>What is Vitals?</button> : null}</p>;
  if (shown !== "card" || (p.compact && !open)) return <div className={css.wrap} data-compact={p.compact ? "" : undefined}>{line}</div>;

  return <div className={css.wrap} data-compact={p.compact ? "" : undefined}>
    {line}
    <section className={css.card} aria-labelledby="wiv-title">
      <button type="button" className={css.close} onClick={close} aria-label="Close “What is Vitals?”"><X size={18} aria-hidden="true" /></button>
      <h2 id="wiv-title" className={css.title}>What is Vitals?</h2>
      <div className={css.body}>
        <div className={css.media}>
          {playing && slot.kind === "file" ? <video className={css.video} src={slot.url!} poster="/growth/what-is-vitals-poster.webp" controls autoPlay playsInline />
            : playing && slot.kind === "embed" ? <iframe className={css.video} src={slot.url!} title="What is Vitals, in 60 seconds" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
            : <button type="button" className={css.poster} onClick={() => { if (slot.kind === "link") window.open(slot.url!, "_blank", "noopener"); else setPlaying(true); }}
                aria-label={slot.kind === "none" ? "The 60-second video is coming soon" : "Play “What is Vitals?”, 60 seconds"}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a small static poster; next/image would add a server round trip for nothing */}
                <img src="/growth/what-is-vitals-poster.webp" alt="" width={960} height={540} />
                <span className={css.play} aria-hidden="true"><Play size={22} fill="currentColor" /></span>
                <span className={css.length} aria-hidden="true">1:00</span>
              </button>}
          {playing && slot.kind === "none" ? <p className={css.soon} role="status">The 60-second video is coming soon.</p> : null}
        </div>
        <div className={css.text}>
          <p>{pitch(p.company)}</p>
          <button type="button" className={css.primary} onClick={() => void start()} disabled={going}>{going ? "Opening…" : "Start free for your business"}</button>
        </div>
      </div>
    </section>
  </div>;
}
