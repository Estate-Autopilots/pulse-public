"use client";
// SETTINGS-APPLE (T1.3.4): the hand-off is made in the browser once this page is open (never by a prefetch of /admin):
// Pulse makes a one-time token for this person's platform-admin seat; the admin site trades it for its own session.
import { useEffect, useState } from "react";
import { EmptyState, GamePage, SkeletonRows } from "../kit/game";

export function OpenConsole({ site }: { site: string }) {
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/auth/admin-handoff", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store" })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
        if (!live) return;
        if (r.ok && d.token) window.location.replace(`${site}/handoff#${d.token}`);
        else setError(d.error ?? "Pulse could not open the admin console just now.");
      })
      .catch(() => { if (live) setError("Pulse did not answer. Try again in a moment."); });
    return () => { live = false; };
  }, [site, round]);
  return <GamePage label="Admin console">
    {error ? <EmptyState art="connect" title="The admin console did not open" text={error} action={{ label: "Try again", onClick: () => { setError(""); setRound((n) => n + 1); } }} />
      : <><p role="status" style={{ margin: 0, fontSize: 15, color: "var(--theme-text-muted)" }}>Opening the admin console…</p><SkeletonRows rows={3} label="Opening the admin console" /></>}
  </GamePage>;
}
