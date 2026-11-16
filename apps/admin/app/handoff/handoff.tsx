"use client";
import { useEffect, useState } from "react";

/** SETTINGS-APPLE (T1.3.4): reads the one-time token from the address's #fragment (never sent to a server log), trades
 *  it for this site's session, and opens the console. One plain line while it works; one way back if it can't. */
export function Handoff({ pulse }: { pulse: string | null }) {
  const [error, setError] = useState("");
  useEffect(() => {
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, "", window.location.pathname);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { window.location.replace("/"); return; }
    void fetch("/auth/handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store" })
      .then(async (r) => { if (r.ok) window.location.replace("/"); else setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Open the admin console from Pulse again."); })
      .catch(() => setError("Pulse did not answer. Try again in a moment."));
  }, []);
  return error ? <><p role="alert">{error}</p>{pulse ? <a href={`${pulse}/admin`}>Open it again from Pulse</a> : null}</> : <p role="status">Opening the admin console…</p>;
}
