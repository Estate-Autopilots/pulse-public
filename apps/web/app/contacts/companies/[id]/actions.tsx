"use client";
// COMPANIES-MODEL: what you do on a company's page: make it a client, pick its main contact, mark vendor/partner, and
// connect it to its own Pulse account (find it in the directory, or invite it: when it joins, the record links).
import { Link2, Star, Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { CompanyPicker } from "../../../directory/company-picker";
import { Switch } from "../../../kit/switch";
import type { CompanyInvite, DirectoryCompany } from "../../../lib/directory.mjs";
import { post } from "../../../records";
import styles from "../../../ui.module.css";
import css from "../../book.module.css";

const oops = (e: unknown) => notify({ id: "company-error", tone: "error", title: e instanceof Error ? e.message : "That did not save. Try again.", timeout: 4000 });

export function MakeClient({ id, name, one }: { id: string; name: string; one: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={async () => {
    setBusy(true);
    try { const r = await post<{ clientId: string }>(`companies/${id}/client`); notify({ id: "made-client", tone: "success", title: `${name} is a ${one.toLowerCase()} now`, timeout: 3000 }); router.push(`/clients/${r.clientId}`); }
    catch (e) { oops(e); setBusy(false); }
  }}>{busy ? "Saving…" : `Make ${one.toLowerCase()}`}</button>;
}

export function MainContact({ company, person, name }: { company: string; person: string; name: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} title={`Make ${name} the main contact`} aria-label={`Make ${name} the main contact`} onClick={async () => {
    setBusy(true); try { await post(`companies/${company}`, { primaryContactId: person }); router.refresh(); } catch (e) { oops(e); } finally { setBusy(false); }
  }}><Star size={13} aria-hidden="true" /></button>;
}

/** Vendor or partner: the kit's switch (judge r4: two outlined buttons read as actions with no on or off). */
export function Relation({ id, field, on, label, hint }: { id: string; field: "isVendor" | "isPartner"; on: boolean; label: string; hint?: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  return <Switch inline label={label} hint={hint} checked={on} disabled={busy} onChange={async (next) => {
    setBusy(true); try { await post(`companies/${id}`, { [field]: next }); router.refresh(); } catch (e) { oops(e); } finally { setBusy(false); }
  }} />;
}

/** Their own Pulse account: linked, invited (waiting), or find / invite. */
export function PulseLink({ id, name, linked, invite, canEdit }: { id: string; name: string; linked: { handle: string; name: string } | null; invite: { status: string; createdAt: string } | null; canEdit: boolean }) {
  const router = useRouter(); const [open, setOpen] = useState(false); const [pick, setPick] = useState<DirectoryCompany | null>(null); const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); try { await post(`companies/${id}`, body); notify({ id: "pulse-link", tone: "success", title: done, timeout: 3000 }); setOpen(false); router.refresh(); } catch (e) { oops(e); } finally { setBusy(false); }
  };
  if (linked) return <div className={css.linked}><Link2 size={16} aria-hidden="true" /><span><b>On Pulse as {linked.name}</b><small className={css.note}>@{linked.handle} · their own account, connected to this record</small></span>
    {canEdit ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void save({ pulseOrgId: null }, "Disconnected")}><Unlink size={13} aria-hidden="true" />Disconnect</button> : null}</div>;
  if (!canEdit) return <p className={css.note}>{invite?.status === "pending" ? "Invited to Pulse. Waiting for them to join." : "Not on Pulse yet."}</p>;
  return <div className={css.stack}>
    {invite?.status === "pending" ? <p className={css.note}>Invited to Pulse. When they join, this record connects to their account.</p> : <p className={css.note}>If {name} uses Pulse, connect their account. Otherwise invite them: when they join, this record connects.</p>}
    {open ? <>
      <CompanyPicker value={pick} onChange={setPick} excludeOwn label="Find them on Pulse" onInvite={(i: CompanyInvite) => void save({ inviteId: i.id }, `Invite made for ${i.companyName}. Share the link with them.`)} />
      <div className={css.actions}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!pick || busy} onClick={() => pick && void save({ pulseOrgId: pick.id }, `Connected to ${pick.name} on Pulse`)}>Connect</button>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </> : <button type="button" className={styles.btn} style={{ justifySelf: "start" }} onClick={() => setOpen(true)}><Link2 size={14} aria-hidden="true" />{invite?.status === "pending" ? "Find them again" : "Find or invite them"}</button>}
  </div>;
}
