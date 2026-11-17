"use client";
// UX-GAMIFY (owner, 9 Nov 2026: "Focus is private to one organisation, so other orgs must never show a dead page"): an
// organisation-only page opened in the wrong organisation moves to the one that has it, at once, and stays on the same
// page there. One plain line while it moves; if the move fails, one button to try again.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { arrive, openInTab } from "./orgs/client";
import { EmptyState, GamePage, SkeletonRows } from "./kit/game";

export function OpenElsewhere({ org, name, what }: { org: string; name: string; what: string }) {
  const path = usePathname() ?? "/";
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name } }));
    openInTab(org).then((moved) => { if (live) arrive(moved, path); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "That did not work."); });
    return () => { live = false; };
  }, [org, name, path, round]);
  return <GamePage label={what}>
    {error ? <EmptyState art="connect" title={`${what} lives in ${name}`} text={`We could not open ${name}. ${error}`}
      action={{ label: `Open ${what} in ${name}`, onClick: () => { setError(null); setRound((n) => n + 1); } }} />
      : <><p role="status" style={{ margin: 0, fontSize: 15, color: "var(--theme-text-muted)" }}>Opening {what} in {name}…</p><SkeletonRows rows={3} label={`Opening ${what}`} /></>}
  </GamePage>;
}
