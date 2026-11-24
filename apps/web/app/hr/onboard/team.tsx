"use client";
// HR → Onboard team: everyone in the roster and how far they are (invited, signed in, profile, apps, first check-in),
// with one-click in-app nudges and the existing invitation flow, which sends only when HR or the owner presses Send.
// UI-SWEEP (owner, 10 Nov 2026: "HR's list is just too long"; Codex concept "Funnel then list", reports/ui-sweep/concepts/
// hr-people): one row per person with their one next step and its one action; the dates, profile and apps open in the
// person's panel; ten rows, then "Show all"; the bulk bar appears once someone is ticked.
import { Bell, Landmark, Mail, ShieldAlert, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { day } from "../../lib/format";
import { Modal, post } from "../../records";
import { Avatar, Badge, styles } from "../../ui";
import { Select } from "../../kit";
import { OnboardPersonView } from "./person";
import { stage, type Onboard, type OnboardPerson } from "./types";
import css from "./onboard.module.css";

const FILTERS = [
  { key: "all", label: "Everyone" }, { key: "invite", label: "Not signed in" }, { key: "profile", label: "Profile gaps" },
  { key: "app", label: "No app" }, { key: "checkin", label: "Never checked in" }, { key: "bank", label: "Bank details due" }, { key: "ready", label: "Ready" },
] as const;
type Filter = typeof FILTERS[number]["key"];
const MISSING: Record<string, string> = { dob: "Birth date", phone: "Phone", email: "Email", address: "Address", emergency: "Emergency", bank: "Bank", photo: "Photo",
  legalName: "Legal name", preferredName: "Preferred name", city: "City", work: "Role confirmed", skills: "Skills" };

/** `bar` (GATE-FINISH): the HR desk's view row (Onboard team · People moves · Team heads, and the Team view pick); it opens this
 *  list's own toolbar row, so the list starts right under the group tabs (owner, EA #2/#12: "the people list must start
 *  in the top 20%"). */
export function OnboardTeam({ data, bar }: { data: Onboard; bar?: ReactNode }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<OnboardPerson | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const rows = useMemo(() => data.people.map((p) => ({ p, s: stage(p) })), [data.people]);
  // PEOPLE-CONTACTS: "Bank details" lists everyone without them or with a change HR has not checked yet.
  const bankDue = (p: OnboardPerson) => (p.bank ?? "missing") !== "confirmed";
  const match = (k: Filter, r: { p: OnboardPerson; s: ReturnType<typeof stage> }) => k === "all" || (k === "bank" ? bankDue(r.p) : k === "invite" ? ["invite", "invited"].includes(r.s.key) : r.s.key === k);
  const count = (k: Filter) => rows.filter((r) => match(k, r)).length;
  const matching = rows.filter((r) => match(filter, r));
  const uninvited = data.people.filter((p) => !p.signedInAt && p.canSignIn !== false && (!p.invite || p.invite.status !== "sent"));
  const TOP = 10;
  const shown = all ? matching : matching.slice(0, TOP);
  const label = (k: string) => k.startsWith("doc:") ? data.kinds.find((x) => x.kind === k.slice(4))?.label ?? k.slice(4) : MISSING[k] ?? k;
  /** The one line under a person's next step: what is missing, or when it last moved. */
  const detail = (p: OnboardPerson, key: string): string => {
    const nudged = p.nudged?.checkin ?? p.nudged?.profile ?? p.nudged?.bank, when = nudged ? ` · nudged ${day(nudged)}` : "";
    if (key === "invite" || key === "invited") return p.invite?.status === "blocked" ? p.invite.blocked ?? "Can't be invited yet" : p.invite?.status === "sent" ? `Invited ${day(p.invite.at)}` : "Not invited yet";
    // GATE-FINISH (judge: "Missing: Legal name, Preferred name +11" is hard to read): the first gap and how many more.
    if (key === "profile") return `${label(p.missing[0] ?? "")}${p.missing.length > 1 ? ` and ${p.missing.length - 1} more` : ""} to add${when}`;
    if (key === "app") return p.signedInAt ? `Signed in ${day(p.signedInAt)}` : "";
    if (key === "checkin") return p.outcome ? "Outcome-based" : `Signed in ${p.signedInAt ? day(p.signedInAt) : ""}${when}`;
    return p.firstCheckIn ? `First check-in ${day(p.firstCheckIn)}` : "All set";
  };
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
  return (
    <div className={css.team} data-grow="">
      {data.filesReady === false ? <p className={styles.banner} role="status"><ShieldAlert size={14} aria-hidden="true" /><span><b>ID files and bank details are paused.</b> This Pulse server’s document encryption key isn’t installed, so nobody can upload ID files, save bank details or open stored files. Ask the Pulse administrator to install it; everything else in onboarding works.</span></p> : null}
      <div className={css.toolbar} data-bar={bar ? "" : undefined}>
        {bar}
        <div className={css.filters} role="group" aria-label="Show">{FILTERS.map((f) => <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => { setFilter(f.key); setAll(false); }}>{f.label}<span>{count(f.key)}</span></button>)}</div>
        {/* UI-SWEEP: on a phone the seven filters are one dropdown (a row of chips ran off the screen). */}
        <div className={css.filterPick}><Select label="Show" value={filter} onChange={(v) => { setFilter((v ?? "all") as Filter); setAll(false); }}
          options={FILTERS.map((f) => ({ value: f.key, label: `${f.label} · ${count(f.key)}` }))} /></div>
        {/* GATE-FINISH: the hint "Tick people to nudge or invite several at once" is the select-all box's tooltip (its own line
            pushed the list down). */}
        {/* The view's one main action: invite everyone who has not signed in (the dialog shows each address and sends only on Send). */}
        {data.canEdit && !picked.size && uninvited.length ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.inviteAll}`} aria-label={`Invite ${uninvited.length} ${uninvited.length === 1 ? "person" : "people"} who are not invited yet`}
          onClick={() => { setPicked(new Set(uninvited.map((p) => p.id))); setInviting(true); }}><Mail size={14} aria-hidden="true" />Invite {uninvited.length}<span className={css.inviteMore}> {uninvited.length === 1 ? "person" : "people"}</span></button> : null}
        {data.canEdit && picked.size ? <div className={css.bulk} aria-live="polite">
          <span><b>{picked.size}</b> selected</span>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!picked.size || busy} onClick={() => void nudge("checkin", [...picked])}><Bell size={13} aria-hidden="true" />Nudge to check in</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!picked.size || busy} onClick={() => void nudge("profile", [...picked])}><UserRoundCheck size={13} aria-hidden="true" />Nudge to finish profile</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!picked.size || busy} onClick={() => void nudge("bank", [...picked].filter((id) => data.people.find((x) => x.id === id)?.bank === "missing"))}><Landmark size={13} aria-hidden="true" />Nudge to add bank details</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={!picked.size || busy} onClick={() => setInviting(true)}><Mail size={13} aria-hidden="true" />Invite…</button>
        </div> : null}
      </div>
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr>
            {data.canEdit ? <th className={css.pick}><input type="checkbox" aria-label="Select everyone shown" title="Tick people to nudge or invite several at once" checked={allShown} onChange={() => setPicked((s) => { const n = new Set(s); for (const r of shown) { if (allShown) n.delete(r.p.id); else n.add(r.p.id); } return n; })} /></th> : null}
            <th>Person</th><th>Next step</th><th><span className={css.srOnly}>Actions</span></th>
          </tr></thead>
          <tbody>{shown.map(({ p, s }) => (
            <tr key={p.id} data-stage={s.key}>
              {data.canEdit ? <td className={css.pick}><input type="checkbox" aria-label={`Select ${p.name}`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} /></td> : null}
              <td data-label="Person"><button type="button" className={css.who} onClick={() => setOpen(p)}><Avatar name={p.name} id={p.id} size={28} /><span><b>{p.name}</b><small>{[p.role, p.pod].filter(Boolean).join(" · ") || "Team"}</small></span></button></td>
              <td data-label="Next step"><Badge tone={s.key === "ready" ? "success" : s.key === "invite" || s.key === "checkin" ? "warning" : "neutral"}>{s.label}</Badge>
                {detail(p, s.key) ? <small className={css.sub}>{detail(p, s.key)}</small> : null}
                {p.bank !== "confirmed" && s.key !== "invite" && s.key !== "invited" ? <small className={css.bank} data-state={p.bank ?? "missing"}><Landmark size={11} aria-hidden="true" />{p.bank === "pending" ? <Link href={`/people/${p.id}?tab=info#info-bank`}>Bank: check the change</Link> : "No bank details"}</small> : null}
                {p.changes ? <small className={css.sub}><Link href={`/people/${p.id}?tab=info#info-requests`}>{p.changes === 1 ? "1 change to approve" : `${p.changes} changes to approve`}</Link></small> : null}</td>
              <td className={css.rowActions}>
                {/* One action per person, from their next step. An in-app nudge reaches only someone who has signed in; the
                    others need an invitation. A kind already nudged today waits until tomorrow. */}
                {(() => {
                  if (!data.canEdit) return null;
                  const today = new Date().toISOString().slice(0, 10), sent = (k: "checkin" | "profile" | "bank") => p.nudged?.[k]?.slice(0, 10) === today;
                  const btn = (text: string, kind: "checkin" | "profile" | "bank", title: string) => <button type="button" className={`${styles.btn} ${styles.btnSmall}`} title={title}
                    disabled={busy || sent(kind)} onClick={() => void nudge(kind, [p.id])}>{sent(kind) ? "Nudged today" : text}</button>;
                  if (!p.signedInAt) return !p.invite || p.invite.status !== "sent" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => { setPicked(new Set([p.id])); setInviting(true); }}>Invite</button> : null;
                  if (filter === "bank" && (p.bank ?? "missing") === "missing") return btn("Nudge for bank", "bank", "Ask them in Pulse to add their bank details");
                  if (s.key === "profile") return btn("Nudge", "profile", "Ask them in Pulse to finish their profile");
                  if (s.key === "checkin") return btn("Nudge", "checkin", "Ask them in Pulse to check in");
                  return null;
                })()}
                <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setOpen(p)}>Open</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!shown.length ? <p className={css.empty}>Nobody here. {filter === "ready" ? "When people finish their profile and check in once, they show here." : ""}</p> : null}
        {matching.length > TOP ? <button type="button" className={css.showAll} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${matching.length}`}</button> : null}
      </div>
      <p className={css.foot}>Nudges show in Pulse (Inbox and the phone app), once a day per person. Invitations go out only when you press Send. Bank details are seen only by the person and HR.</p>
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
