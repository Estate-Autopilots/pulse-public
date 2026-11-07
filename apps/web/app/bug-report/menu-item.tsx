"use client";
// BUG-REPORT: the account menu's "Report a bug" (on a phone the only way in besides a shake).
import { Bug } from "lucide-react";
import { openBugReport } from "./open";

export function ReportBugMenuItem() {
  // The menu closes on the click; the reporter opens a moment later, after the menu has left the screen's picture.
  return <button type="button" role="menuitem" onClick={() => window.setTimeout(() => openBugReport(), 180)}><Bug size={16} aria-hidden="true" />Report a bug</button>;
}
