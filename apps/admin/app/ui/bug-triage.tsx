"use client";
// PULSE-ADMIN: triage one bug report from the admin site (status, severity, a note), through app/api/platform.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import css from "./console.module.css";
import { kitStyles } from "./kit";

export function BugTriage({ org, id, status, severity }: { org: string; id: string; status: string; severity: string | null }) {
  const router = useRouter();
  const [v, setV] = useState({ status, severity: severity ?? "", note: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setDone("");
    const body: Record<string, string> = {};
    if (v.status !== status) body.status = v.status;
    if (v.severity !== (severity ?? "")) body.severity = v.severity;
    if (v.note.trim()) body.note = v.note.trim();
    try {
      const r = await fetch(`/api/platform/orgs/${org}/bugs/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Not saved");
      setV({ ...v, note: "" }); setDone("Saved"); router.refresh();
    } catch (x) { setError(x instanceof Error ? x.message : "Not saved"); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => { setV({ ...v, [k]: e.target.value }); setDone(""); };
  return <form className={css.form} onSubmit={save}>
    <div className={css.grid}>
      <label className={kitStyles.field}>Status<select value={v.status} onChange={set("status")}>
        <option value="new">New</option><option value="triaged">Triaged</option><option value="fixing">Being fixed</option><option value="fixed">Fixed</option><option value="wontfix">Won’t fix</option></select></label>
      <label className={kitStyles.field}>Severity<select value={v.severity} onChange={set("severity")}>
        <option value="">Not set</option><option value="blocker">Blocker</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
    </div>
    <label className={kitStyles.field}>Note<textarea rows={3} value={v.note} onChange={set("note")} maxLength={2000} placeholder="What you found, or what happens next" /></label>
    <div className={css.row}><button className={kitStyles.button} data-variant="primary" disabled={busy}>{busy ? "Saving…" : "Save triage"}</button></div>
    {error ? <p role="alert" className={css.error}>{error}</p> : done ? <p role="status" className={css.done}>{done}</p> : null}
  </form>;
}
