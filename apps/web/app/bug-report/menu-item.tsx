"use client";
// BUG-REPORT: the account menu's "Report a bug" (on a phone the only way in besides a shake), and beside it (staff seats)
// MEETING-CAPTURE's "Narrate a problem".
import { useRouter } from "next/navigation";
import { Bug, Megaphone } from "lucide-react";
import { openBugReport } from "./open";

export function ReportBugMenuItem({ narrate = false }: { narrate?: boolean }) {
  const router = useRouter();
  // The menu closes on the click; the reporter opens a moment later, after the menu has left the screen's picture.
  return <>
    <button type="button" role="menuitem" onClick={() => window.setTimeout(() => openBugReport(), 180)}><Bug size={16} aria-hidden="true" />Report a bug</button>
    {/* MEETING-CAPTURE: the same problem in your own words (typed, pasted from Wispr Flow, or recorded); Pulse drafts the report. */}
    {narrate ? <button type="button" role="menuitem" data-narrate-menu=""
      onClick={() => router.push(`/meetings/new?mode=problem&from=${encodeURIComponent(window.location.pathname)}`)}><Megaphone size={16} aria-hidden="true" />Narrate a problem</button> : null}
  </>;
}
