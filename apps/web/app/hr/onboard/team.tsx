"use client";
// HR → Onboard team: everyone in the roster and how far they are (invited, signed in, profile, apps, first check-in),
// with one-click in-app nudges and the existing invitation flow, which sends only when HR or the owner presses Send.
import { Bell, Chrome, Landmark, Laptop, Mail, ShieldAlert, Smartphone, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { day } from "../../lib/format";
import { Modal, post } from "../../records";
import { Avatar, Badge, styles } from "../../ui";
import { OnboardPersonView } from "./person";
import { stage, type Onboard, type OnboardPerson } from "./types";
import css from "./onboard.module.css";

const FILTERS = [
  { key: "all", label: "Everyone" }, { key: "invite", label: "Not signed in" }, { key: "profile", label: "Profile gaps" },
  { key: "app", label: "No app" }, { key: "checkin", label: "Never checked in" }, { key: "bank", label: "Bank details" }, { key: "ready", label: "Ready" },
] as const;
type Filter = typeof FILTERS[number]["key"];
const MISSING: Record<string, string> = { dob: "Birth date", phone: "Phone", email: "Email", address: "Address", emergency: "Emergency", bank: "Bank", photo: "Photo",
  legalName: "Legal name", preferredName: "Preferred name", city: "City", work: "Role confirmed", skills: "Skills" };

export function OnboardTeam({ data }: { data: Onboard }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<OnboardPerson | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => data.people.map((p) => ({ p, s: stage(p) })), [data.people]);
  // PEOPLE-CONTACTS: "Bank details" lists everyone without them or with a change HR has not checked yet.
  const bankDue = (p: OnboardPerson) => (p.bank ?? "missing") !== "confirmed";
  const match = (k: Filter, r: { p: OnboardPerson; s: ReturnType<typeof stage> }) => k === "all" || (k === "bank" ? bankDue(r.p) : k === "invite" ? ["invite", "invited"].includes(r.s.key) : r.s.key === k);
  const count = (k: Filter) => rows.filter((r) => match(k, r)).length;
  const shown = rows.filter((r) => match(filter, r));
  const label = (k: string) => k.startsWith("doc:") ? data.kinds.find((x) => x.kind === k.slice(4))?.label ?? k.slice(4) : MISSING[k] ?? k;
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShown = shown.length > 0 && shown.every((r) => picked.has(r.p.id));
  async function nudge(kind: "checkin" | "profile" | "bank", ids: string[]) {
    setBusy(true);
    try {
      const r = await post<{ sent: number; skipped: number }>("hr/onboard/nudge", { kind, personIds: ids });
      notify({ id: "nudge", tone: "success", title: r.sent ? `Nudged ${r.sent} ${r.sent === 1 ? "person" : "people"} in Pulse` : "Already nudged today",
        message: r.skipped ? `${r.skipped} already had today’s nudge.` : "They see it in their Inbox and on the phone app.", timeout: 3500 });
      setPicked(new Set()); router.refresh();
    } catch (e) { notify({ id: "nudge", tone: "error", title: "No nudge sent", message: (e as Error).message }); } finally { setBusy(false); }
  }
  const funnel = [
    { label: "In the roster", value: rows.length },
    { label: "Signed in", value: rows.filter((r) => r.p.signedInAt).length },
    { label: "Profile complete", value: rows.filter((r) => r.p.percent >= 100).length },
    { label: "App installed", value: rows.filter((r) => r.p.apps?.phone || r.p.apps?.desktop || r.p.apps?.chrome).length },
    { label: "Checked in once", value: rows.filter((r) => r.p.firstCheckIn).length },
  ];
  return (
    <div className={css.team} data-grow="">
      {data.filesReady === false ? <p className={styles.banner} role="status"><ShieldAlert size={14} aria-hidden="true" /><span><b>ID files and bank details are paused.</b> This Pulse server’s document encryption key isn’t installed, so nobody can upload ID files, save bank details or open stored files. Ask the Pulse administrator to install it; everything else in onboarding works.</span></p> : null}
      <ol className={css.funnel} aria-label="Rollout so far">{funnel.map((f) => <li key={f.label}><b>{f.value}</b><span>{f.label}</span><i style={{ width: `${rows.length ? Math.round((f.value / rows.length) * 100) : 0}%` }} aria-hidden="true" /></li>)}</ol>
      <div className={css.toolbar}>
        <div className={css.filters} role="group" aria-label="Show">{FILTERS.map((f) => <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}<span>{count(f.key)}</span></button>)}</div>
        {data.canEdit ? <div className={css.bulk} aria-live="polite">
          {picked.size ? <span>{picked.size} selected</span> : <span className={styles.muted}>Select people for bulk actions</span>}
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!picked.size || busy} onClick={() => void nudge("checkin", [...picked])}><Bell size={13} aria-hidden="true" />Nudge to check in</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!picked.size || busy} onClick={() => void nudge("profile", [...picked])}><UserRoundCheck size={13} aria-hidden="true" />Nudge to finish profile</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!picked.size || busy} onClick={() => void nudge("bank", [...picked].filter((id) => data.people.find((x) => x.id === id)?.bank === "missing"))}><Landmark size={13} aria-hidden="true" />Nudge to add bank details</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={!picked.size || busy} onClick={() => setInviting(true)}><Mail size={13} aria-hidden="true" />Invite…</button>
        </div> : null}
      </div>
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr>
            {data.canEdit ? <th className={css.pick}><input type="checkbox" aria-label="Select everyone shown" checked={allShown} onChange={() => setPicked((s) => { const n = new Set(s); for (const r of shown) { if (allShown) n.delete(r.p.id); else n.add(r.p.id); } return n; })} /></th> : null}
            <th>Person</th><th>Next step</th><th>Signed in</th><th>Profile</th><th>Apps</th><th>First check-in</th><th><span className={css.srOnly}>Actions</span></th>
          </tr></thead>
          <tbody>{shown.map(({ p, s }) => (
            <tr key={p.id} data-stage={s.key}>
              {data.canEdit ? <td className={css.pick}><input type="checkbox" aria-label={`Select ${p.name}`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} /></td> : null}
              <td data-label="Person"><button type="button" className={css.who} onClick={() => setOpen(p)}><Avatar name={p.name} id={p.id} size={28} /><span><b>{p.name}</b><small>{[p.role, p.pod].filter(Boolean).join(" · ") || "Team"}</small></span></button></td>
              <td data-label="Next step"><Badge tone={s.key === "ready" ? "success" : s.key === "invite" || s.key === "checkin" ? "warning" : "neutral"}>{s.label}</Badge>
                {p.nudged?.checkin || p.nudged?.profile || p.nudged?.bank ? <small className={css.sub}>Nudged {day((p.nudged.checkin ?? p.nudged.profile ?? p.nudged.bank)!)}</small> : p.invite?.status === "blocked" ? <small className={css.sub}>{p.invite.blocked}</small> : null}</td>
              <td data-label="Signed in">{p.signedInAt ? day(p.signedInAt) : p.invite?.status === "sent" ? <span className={styles.muted}>Invited {day(p.invite.at)}</span> : <span className={styles.muted}>Not yet</span>}</td>
              <td data-label="Profile"><span className={css.meter} title={p.missing.map(label).join(", ") || "Complete"}><i style={{ width: `${p.percent}%` }} data-done={p.percent >= 100 ? "" : undefined} /></span>
                <small className={css.sub}>{p.percent >= 100 ? "Complete" : `${p.percent}% · ${p.missing.slice(0, 3).map(label).join(", ")}${p.missing.length > 3 ? ` +${p.missing.length - 3}` : ""}`}</small>
                {p.proposals ? <small className={css.sub}>{p.proposals} suggestion{p.proposals === 1 ? "" : "s"} to confirm</small> : null}
                <small className={css.bank} data-state={p.bank ?? "missing"}><Landmark size={11} aria-hidden="true" />{p.bank === "confirmed" ? "Bank checked" : p.bank === "pending" ? <Link href={`/people/${p.id}?tab=info#info-bank`}>Bank: check the change</Link> : "No bank details"}</small>
                {p.changes ? <small className={css.sub}><Link href={`/people/${p.id}?tab=info#info-requests`}>{p.changes === 1 ? "1 change to approve" : `${p.changes} changes to approve`}</Link></small> : null}</td>
              <td data-label="Apps"><span className={css.apps}>
                <Smartphone size={15} aria-label={p.apps?.phone ? "Phone app installed" : "No phone app"} data-on={p.apps?.phone ? "" : undefined} />
                <Laptop size={15} aria-label={p.apps?.desktop ? "Desktop app installed" : "No desktop app"} data-on={p.apps?.desktop ? "" : undefined} />
                <Chrome size={15} aria-label={p.apps?.chrome ? "Chrome extension installed" : "No Chrome extension"} data-on={p.apps?.chrome ? "" : undefined} /></span></td>
              <td data-label="First check-in">{p.firstCheckIn ? day(p.firstCheckIn) : p.outcome ? <span className={styles.muted}>Outcome-based</span> : <span className={css.never}>Never</span>}</td>
              <td className={css.rowActions}>
                {/* An in-app nudge reaches only someone who has signed in; the others need an invitation. */}
                {data.canEdit && p.signedInAt && !p.firstCheckIn && !p.outcome ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !!p.nudged?.checkin && p.nudged.checkin.slice(0, 10) === new Date().toISOString().slice(0, 10)} onClick={() => void nudge("checkin", [p.id])}>Nudge</button> : null}
                {data.canEdit && p.signedInAt && filter === "bank" && (p.bank ?? "missing") === "missing" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !!p.nudged?.bank && p.nudged.bank.slice(0, 10) === new Date().toISOString().slice(0, 10)} onClick={() => void nudge("bank", [p.id])} title="Ask them in Pulse to add their bank details">Nudge for bank</button> : null}
                {data.canEdit && !p.signedInAt && (!p.invite || p.invite.status !== "sent") ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { setPicked(new Set([p.id])); setInviting(true); }}>Invite</button> : null}
                <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setOpen(p)}>Open</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!shown.length ? <p className={css.empty}>Nobody here. {filter === "ready" ? "When people finish their profile and check in once, they show here." : ""}</p> : null}
      </div>
      <p className={css.foot}>Bank details are added by each person (or by HR on their profile, under Personal) and checked by HR before payroll; only they and HR see them. Nudges are in-app (Inbox and the phone app), one per person per kind per day. Pulse never messages anyone outside Pulse from here; invitations send only when you press Send.</p>
      {open ? <OnboardPersonView person={open} kinds={data.kinds} canEdit={data.canEdit} onClose={() => setOpen(null)} onNudge={(kind) => void nudge(kind, [open.id])} /> : null}
      {inviting ? <InviteDialog ids={[...picked]} names={data.people.filter((p) => picked.has(p.id)).map((p) => p.name)} sendEnabled={data.sendEnabled} onClose={() => { setInviting(false); router.refresh(); }} /> : null}
    </div>
  );
}

type Prepared = { personId: string; name: string; username: string; recipient: string | null; status: string; reason: string | null; batchId: string };
/** The existing invitation flow: prepare (no email), review, and Send only on HR's or the owner's press. */
function InviteDialog({ ids, names, sendEnabled, onClose }: { ids: string[]; names: string[]; sendEnabled: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Prepared[] | null>(null);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  async function prepare() {
    setBusy(true); setNote("");
    try {
      await post("admin/invitations/prepare");
      const r = await fetch("/api/v0/admin/invitations", { cache: "no-store" }); const body = await r.json(); if (!r.ok) throw new Error(body.error);
      setRows((body.invitations as Prepared[]).filter((x) => ids.includes(x.personId)));
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }
  const ready = rows?.filter((r) => r.status === "prepared") ?? [];
  async function send() {
    if (!ready.length || !confirm) return;
    setBusy(true); setNote("");
    try { const r = await post<{ sent: number; failed: number }>("admin/invitations/send", { batchId: ready[0].batchId, personIds: ready.map((x) => x.personId) }); setNote(`${r.sent} sent${r.failed ? `; ${r.failed} could not be sent` : ""}.`); setRows(null); }
    catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Invite ${ids.length === 1 ? names[0] : `${ids.length} people`}`} sub="Each person gets their own one-time sign-in link by email when you press Send." onClose={onClose}
      foot={<div className={styles.modalFoot}><p role="status" className={styles.status}>{note}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Close</button>
        {rows ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !ready.length || !sendEnabled || !confirm} onClick={() => void send()}>Send {ready.length} invitation{ready.length === 1 ? "" : "s"}</button>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void prepare()}>{busy ? "Preparing…" : "Prepare and review"}</button>}</div>}>
      <div className={styles.modalBody}>
        {!rows ? <><p>Pulse prepares sign-in links (nothing is emailed yet), then shows exactly who would get one. You press Send.</p><p className={styles.muted}>Selected: {names.join(", ")}</p></>
          : <>
            {!sendEnabled ? <p role="status">Email sending is waiting for verified Google permissions, so Send stays off. The invitations stay prepared.</p> : null}
            <ul className={css.invites}>{rows.map((r) => <li key={r.personId}><b>{r.name}</b><span>{r.recipient ?? "No delivery email"} · {r.username}</span><Badge tone={r.status === "prepared" ? "success" : "warning"}>{r.status === "prepared" ? "Ready" : r.reason ?? r.status}</Badge></li>)}</ul>
            {ids.length > rows.length ? <p className={styles.muted}>{ids.length - rows.length} selected {ids.length - rows.length === 1 ? "person is" : "people are"} already signed in or not in the invitation list.</p> : null}
            <label className={css.confirm}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I checked these names and emails. Send only to the ones marked Ready.</label>
          </>}
        <p className={styles.modalNote}>Same flow as Settings → Who can sign in. <Link href="/settings?tab=sign-in">Open it there</Link>.</p>
      </div>
    </Modal>
  );
}
