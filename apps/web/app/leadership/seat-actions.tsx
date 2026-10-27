"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import css from "./people.module.css";

/** Leadership adds a holder Pulse could not see (a predecessor in another pod, or before Pulse), with the dates. */
export function AddHolder({ seat, people }: { seat: string; people: { id: string; name: string; role: string; status: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [who, setWho] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} style={{ justifySelf: "start" }} onClick={() => setOpen(true)}>Add a past holder</button>;
  return <div className={css.add}>
    <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who held the seat"><option value="">Who…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === "active" ? "" : " (alumni)"} · {p.role}</option>)}</select>
    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
    <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" aria-label="Note" maxLength={300} />
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy || !who || !from} onClick={async () => {
      setBusy(true);
      try { await post(`seats/${seat}/holders`, { personId: who, from, to: to || null, note }); setOpen(false); router.refresh(); }
      catch (e) { notify({ id: "holder", tone: "error", title: "Not added", message: e instanceof Error ? e.message : "Not saved" }); } finally { setBusy(false); }
    }}>Add</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
  </div>;
}
