"use client";
// TELEMETRY (owner, 24 Oct 2026): starts the app's movement and timing collector once (lib/telemetry.mjs) and tells it
// about every committed route. Renders nothing.
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { startTelemetry, telemetryRoute } from "./lib/telemetry.mjs";

export function TelemetryHost({ release, sample, enabled }: { release: string; sample: number; enabled: boolean }) {
  const path = usePathname();
  useEffect(() => { startTelemetry({ release, sample, enabled }); }, [release, sample, enabled]);
  useEffect(() => { telemetryRoute(); }, [path]);
  return null;
}
