"use client";
// GAP-FOUNDER-VIEW (PM-08): finish the Google Calendar sign-in (posts Google's one-time code and state once), then back to
// Settings → Your account. Google's "access_denied" (Cancel) is said plainly; nothing was connected.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { post } from "../../../records";
import { EmptyState, GamePage, SkeletonRows } from "../../../kit/game";
import { connectCalendar } from "../../calendar";

export function FinishCalendar({ code, state, error }: { code: string; state: string; error: string }) {
  const router = useRouter(), started = useRef(false);
  const [problem, setProblem] = useState(error ? (error === "access_denied" ? "Google sign-in was cancelled, so nothing was connected." : "Google did not connect your calendar.")
    : !code || !state ? "Google did not send Pulse back a sign-in. Press Connect again." : "");
  useEffect(() => {
    if (started.current || error || !code || !state) return;
    started.current = true;
    // The code is used once; take it out of the address bar and history straight away.
    window.history.replaceState(null, "", "/settings/calendar/google");
    post("calendar/google/finish", { code, state })
      .then(() => router.replace("/settings?tab=account&calendar=connected"))
      .catch((e) => setProblem(e instanceof Error ? e.message : "Your calendar was not connected."));
  }, [code, state, error, router]);
  return <GamePage label="Connecting your calendar">
    {problem ? <EmptyState art="connect" title="Your calendar was not connected" text={problem} action={{ label: "Connect again", icon: CalendarPlus, onClick: () => void connectCalendar().catch((e) => setProblem(e instanceof Error ? e.message : "Could not start")) }} />
      : <SkeletonRows rows={2} height={56} label="Connecting your Google Calendar" />}
  </GamePage>;
}
