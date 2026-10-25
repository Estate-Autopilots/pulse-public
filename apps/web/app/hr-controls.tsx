"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./ui.module.css";
import { DateField } from "./kit/date-field";
import { SelectField } from "./kit/select-field";
async function post(path: string, body: unknown = {}) {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "Could not save"); return data;
}
export function AttendanceActions({ checkedIn, enabled, attendanceEnabled }: { checkedIn: boolean; enabled: boolean; attendanceEnabled?: boolean }) {
  const router = useRouter(); const [status,setStatus] = useState(""); const [busy,setBusy] = useState(false);
  if (attendanceEnabled !== true) return null;
  async function submit() { setBusy(true); try { await post(`attendance/${checkedIn ? "check-out" : "check-in"}`); setStatus(checkedIn ? "Checked out" : "Checked in"); router.refresh(); } catch(e) { setStatus(e instanceof Error ? e.message : "Could not save"); } finally {setBusy(false);} }
  return <div className={styles.inline}><button className={`${styles.btn}${checkedIn ? "" : ` ${styles.btnPrimary}`}`} disabled={busy || !enabled} onClick={submit}>{checkedIn ? "Check out" : "Check in"}</button><p role="status" className={styles.status}>{!enabled ? "Use a verified personal account to check in." : status}</p></div>;
}
export function LeaveForm() {
  const router = useRouter(); const [status,setStatus] = useState(""); const [busy,setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setBusy(true); try { await post("leave",{fromDate:f.get("fromDate"),toDate:f.get("toDate"),kind:f.get("kind")}); setStatus("Leave request sent for approval"); form.reset(); router.refresh(); } catch(e) {setStatus(e instanceof Error ? e.message : "Could not save");} finally {setBusy(false);} }
  return <form onSubmit={submit} className={styles.form}><label className={styles.field}>From<DateField name="fromDate" required /></label><label className={styles.field}>To<DateField name="toDate" required /></label><label className={styles.field}>Leave type<SelectField name="kind"><option value="annual">Annual</option><option value="personal">Personal</option><option value="sick">Sick</option></SelectField></label><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Apply for leave</button><p role="status" className={styles.status}>{status}</p></form>;
}
export function LeaveDecision({ id }: { id: string }) {
  const router = useRouter(); const [status,setStatus] = useState(""); const [busy,setBusy] = useState(false);
  async function decide(decision: string) {setBusy(true);try{await post(`leave/${id}/decision`,{decision});setStatus(decision);router.refresh();}catch(e){setStatus(e instanceof Error ? e.message : "Could not save");}finally{setBusy(false);}}
  return <div className={styles.inline}><button className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={()=>decide("approved")}>Approve</button><button className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={()=>decide("rejected")}>Reject</button><span role="status" className={styles.status}>{status}</span></div>;
}
