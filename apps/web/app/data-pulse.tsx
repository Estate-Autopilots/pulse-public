"use client";

import { useEffect } from "react";

/**
 * One light poll per open tab: every minute while the tab is visible it asks the API for its data version (a few bytes:
 * the last index run and a write counter). Only when that version moves does it tell the page — `pulse:data-changed`,
 * which the dashboard's Freshness button turns into a reload and the intelligence rail into a recompute. Before this,
 * every tab re-rendered its whole page and recomputed its insights every minute whether anything had changed or not.
 */
export function DataPulse() {
  useEffect(() => {
    let seen: string | null = null; let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/v0/freshness", { cache: "no-store" }); if (!r.ok || stopped) return;
        const { version } = await r.json() as { version?: string }; if (typeof version !== "string") return;
        if (seen !== null && version !== seen) window.dispatchEvent(new CustomEvent("pulse:data-changed", { detail: { version } }));
        seen = version;
      } catch { /* offline or signed out: the next minute tries again */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60000);
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return null;
}
