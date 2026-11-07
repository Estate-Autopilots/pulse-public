"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ago, dayTime } from "./lib/format";
import { freshnessState } from "./lib/freshness.mjs";
import styles from "./ui.module.css";

type Sync = { everyMinutes?: number; upstreamAt?: string | null; lastRun?: { ok: boolean | null; error: string | null; startedAt: string } | null };

/** "Synced 4 min ago": when the last refresh finished without error. Click to reload; reloads itself when the shell's
 *  DataPulse reports that the data changed (an index run or a write), so an idle tab costs the server nothing. */
export function Freshness({ at, now, detail, sync }: { at: string | null; now: string; detail?: string; sync?: Sync }) {
  const router = useRouter(); const [clock, setClock] = useState(() => Date.parse(now)); const [pending, start] = useTransition();
  useEffect(() => {
    const tick = window.setInterval(() => setClock(Date.now()), 60000);
    const changed = () => { if (document.visibilityState === "visible") start(() => router.refresh()); };
    window.addEventListener("pulse:data-changed", changed);
    return () => { window.clearInterval(tick); window.removeEventListener("pulse:data-changed", changed); };
  }, [router, start]);
  const every = sync?.everyMinutes ?? 10; const failed = sync?.lastRun?.ok === false;
  const freshness = freshnessState(at, sync?.upstreamAt, clock);
  // Late: more than two and a half refresh cycles without a successful one.
  const stale = !at || failed || freshness.stale || clock - Date.parse(at) > every * 2.5 * 60000;
  const title = [at ? `Last successful sync ${dayTime(at)} IST` : "The first sync has not finished yet", `runs every ${every} minutes`,
    sync?.upstreamAt ? `Drive itself was last read ${dayTime(sync.upstreamAt)} IST` : null, failed ? `the latest run failed (${sync?.lastRun?.error ?? "error"})` : null, detail,
    `figures computed ${dayTime(now)} IST`, "click to reload"].filter(Boolean).join(" · ");
  return (
    <button type="button" className={styles.freshness} onClick={() => start(() => router.refresh())} title={title}>
      <span className={`${styles.dot}${stale ? ` ${styles.dotStale}` : ""}`} aria-hidden="true" />
      <span>{at ? `Synced ${ago(at, clock)}${failed ? " · last run failed" : ""}` : "First sync pending"}{freshness.warning ? ` · ${freshness.warning}` : ""}</span>
      <RefreshCw size={12} className={pending ? styles.spin : undefined} aria-hidden="true" />
    </button>
  );
}
