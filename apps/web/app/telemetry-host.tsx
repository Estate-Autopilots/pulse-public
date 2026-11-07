"use client";
// TELEMETRY (owner, 24 Oct 2026): starts the app's movement and timing collector once (lib/telemetry.mjs) and tells it
// about every committed route. Renders nothing.
// BUGKIT-TELEMETRY (6 Nov 2026): the company decides (Settings → Privacy, GET /api/v0/telemetry/settings, read once a
// tab session): usage recording on or off (default on), its sampled share, and session replay (lib/replay.ts) with its
// own share. The server's PULSE_TELEMETRY=0 still switches everything off.
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { startTelemetry, telemetryRoute } from "./lib/telemetry.mjs";
import { startReplay } from "./lib/replay";

type Settings = { enabled: boolean; replay: boolean; sample: number; replaySample: number; prompts: boolean };
const KEY = "pulse.telemetry.settings";
const FRESH_MS = 10 * 60_000;

/** The company's settings for this device: from this tab's session for 10 minutes, else asked once. */
export async function deviceSettings(): Promise<Settings | null> {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") as { at: number; s: Settings } | null;
    if (saved && Date.now() - saved.at < FRESH_MS) return saved.s;
  } catch { /* storage off */ }
  try {
    const r = await fetch("/api/v0/telemetry/settings", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) return null;
    const s = await r.json() as Settings;
    try { window.sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), s })); } catch { /* storage off */ }
    return s;
  } catch { return null; }
}

export function TelemetryHost({ release, sample, enabled }: { release: string; sample: number; enabled: boolean }) {
  const path = usePathname();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void deviceSettings().then((s) => {
      if (!alive) return;
      // Settings unreadable (an older API): the server's own switch and share, as before.
      if (!s) { startTelemetry({ release, sample, enabled }); return; }
      if (!s.enabled) return;
      startTelemetry({ release, sample: Math.min(sample, s.sample), enabled: true });
      if (s.replay) startReplay({ sample: s.replaySample });
    });
    return () => { alive = false; };
  }, [release, sample, enabled]);
  useEffect(() => { telemetryRoute(); }, [path]);
  return null;
}
