"use client";
// RELEASE-COMMS: opening /whats-new counts as seeing the newest release: the "was updated" note does not show for it
// again on this browser (platform-notices.tsx), and closes now if it is open.
import { useEffect } from "react";
import { rememberRelease } from "../release-seen";

export function SeenRelease({ newest }: { newest: number }) {
  useEffect(() => { rememberRelease(newest); }, [newest]);
  return null;
}
