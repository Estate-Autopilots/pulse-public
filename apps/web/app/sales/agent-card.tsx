"use client";

// KAZUK-V2 G14: the Sales Agent in the home's rail. With one: what it does and its two settings (days before a no-reply
// reminder, days before a renewal). Without one: the Sales Head, leadership or an admin sets it up in one press; anyone
// else is told who can. POST /api/v0/sales-agent, /api/v0/sales-agent/settings.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import css from "./home.module.css";

export function AgentCard({ person, self, agent, canMake, noReplyDays, renewalDays }: { person: string; self: boolean; agent: boolean; canMake: boolean; noReplyDays: number; renewalDays: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [noReply, setNoReply] = useState(String(noReplyDays));
  const [renewal, setRenewal] = useState(String(renewalDays));
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    try { await post(path, body); notify({ id: "sales-agent", tone: "success", title: done, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "sales-agent", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "Could not save" }); }
    finally { setBusy(false); }
  };
  if (!agent) return <>
    <p className={css.sync}>A Sales Agent reminds about quotations with no reply, late invoices and renewals, and drafts the messages. It never sends anything.</p>
    {canMake ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => void run("sales-agent", { salesperson: person }, "Sales Agent is ready")}>Set up a Sales Agent</button>
      : <p className={css.sync}>{self ? "Ask your Sales Head to set up your Sales Agent." : "The Sales Head sets it up."}</p>}
  </>;
  return <form className={css.agentForm} onSubmit={(e) => { e.preventDefault(); void run("sales-agent/settings", { salesperson: person, noReplyDays: Number(noReply), renewalDays: Number(renewal) }, "Reminders updated"); }}>
    <p className={css.sync}>It drafts follow-ups, payment reminders and renewal messages, and suggests what to offer before a discount. You send.</p>
    <label className={styles.field}>Remind me when there is no reply for<span className={css.days}><input inputMode="numeric" value={noReply} onChange={(e) => setNoReply(e.target.value.replace(/\D/g, "").slice(0, 2))} aria-label="Days with no reply" /> days</span></label>
    <label className={styles.field}>Remind me before a renewal<span className={css.days}><input inputMode="numeric" value={renewal} onChange={(e) => setRenewal(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="Days before a renewal" /> days</span></label>
    {noReply !== String(noReplyDays) || renewal !== String(renewalDays) ? <button type="submit" className={styles.btn} disabled={busy}>Save</button> : null}
  </form>;
}
