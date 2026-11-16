"use client";
// NEW-DOTS: "Mark all as seen" on /whats-new: every red dot goes (on the server, so on every device), the list empties.
import { CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NEW_DOTS_REFRESH } from "../lib/new-dots.mjs";
import css from "./whats-new.module.css";

export function MarkAllSeen() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const markAll = async () => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/v0/whats-new/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
      if (!r.ok) throw new Error(String(r.status));
      window.dispatchEvent(new CustomEvent(NEW_DOTS_REFRESH, { detail: await r.json() }));
      router.refresh();
    } catch { setError("That did not save. Please try again."); } finally { setBusy(false); }
  };
  return <div className={css.markRow}>
    <button type="button" className={css.markAll} onClick={() => void markAll()} disabled={busy}><CheckCheck size={16} aria-hidden="true" />{busy ? "Marking…" : "Mark all as seen"}</button>
    {error ? <span className={css.markError} role="alert">{error}</span> : null}
  </div>;
}
