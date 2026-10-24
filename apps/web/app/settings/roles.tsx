"use client";

import { Check, HeartHandshake, KeyRound, Lock, Minus, Plus, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { dayTime, dayYear, plural } from "../lib/format";
import { Modal, post } from "../records";
import { Avatar, Empty, Panel, styles, Workspace, Pager } from "../ui";
import css from "./settings.module.css";
import type { PermissionGrant, PermissionKey, RoleHolder, RoleKey, SettingsData } from "./types";

const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";
const ROLE: Record<RoleKey, { title: string; one: string; sees: string }> = {
  admin: { title: "Organisation admins", one: "organisation admin", sees: "everything in Pulse, including Leadership, Settings and editing records" },
  hr: { title: "HR", one: "HR", sees: "all people data, attendance and leave, payroll, employee invites and reset requests" },
  leadership: {title:"Leadership",one:"leadership",sees:"all people, company performance, salaries and money"},
  finance: {title:"Finance",one:"Finance",sees:"Billing: invoices, quotations, credit notes, payments, the catalogue and stock (not salaries or other Finance views)"},
  manager: {title:"Managers",one:"manager",sees:"their assigned pod’s work, performance, attendance and leave"},
  pgs: {title:"PGS",one:"PGS",sees:"their assigned pod’s work, performance, attendance and leave"},
  head_pgs: {title:"Pod leads",one:"pod lead",sees:"their assigned pod’s work, performance, attendance and leave"},
};
const PERMISSIONS: { key: PermissionKey; label: string; what: string }[] = [
  { key: "hr.salary.read", label: "Read salary", what: "see salary history and the payroll overview" },
  { key: "hr.salary.write", label: "Edit salary", what: "record a new salary figure for a person" },
  { key: "hr.contact.read", label: "Read personal contact", what: "see personal phone, personal e-mail and emergency contact" },
  { key: "hr.contact.write", label: "Edit personal contact", what: "change personal phone, personal e-mail and emergency contact" },
  { key: "hr.documents.read", label: "Read HR document names", what: "see which letters and identity documents are on file (names only, never the contents)" },
];

// What each kind of account can do, as the service enforces it. "perm" cells also need the named permission.
type Cell = "yes" | "no" | "perm" | string;
const COLUMNS = ["Employee", "Manager / PGS", "HR", "Leadership", "Admin"] as const;
const MATRIX: {group:string;rows:{what:string;note?:string;cells:Cell[]}[]}[]=[
 {group:"Personal workspace",rows:[
 {what:"Own profile, performance, attendance and leave",cells:["yes","yes","yes","yes","yes"]},
 {what:"Team directory without restricted fields",cells:["yes","yes","yes","yes","yes"]},
 {what:"Chats: member channels and direct messages",cells:["yes","yes","yes","yes","yes"]}]},
 {group:"People and work",rows:[
 {what:"Other people’s work and performance",cells:["no","Assigned pod / reports","People data only","yes","yes"]},
 {what:"Other people’s attendance and leave",cells:["no","Assigned pod / reports","yes","yes","yes"]},
 {what:"Edit people and historical HR months",cells:["no","no","yes","yes","yes"]},
 {what:"Payroll, salary, personal contact and HR documents",note:"Every restricted read is audited",cells:["no","no","yes","yes","perm"]},
 {what:"Company performance and Finance",cells:["no","no","no","yes","perm"]}]},
 {group:"HR requests",rows:[
 {what:"Leave, corrections, Sunday work and other request queue",cells:["Own requests","Confirmed pod","All requests","All requests","All requests"]},
 {what:"Approve within policy",note:"Nobody decides their own request",cells:["no","Confirmed pod","yes","yes","yes"]},
 {what:"Override with reason / forward to co-founder",cells:["no","no","yes","yes","yes"]},
 {what:"Assign pod heads, co-founders and working patterns",cells:["no","no","yes","yes","yes"]},
 {what:"Co-founder decision page",note:"Separately assigned by HR/admin; forwarded requests only",cells:["Assigned role","Assigned role","Assigned role","Assigned role","Assigned role"]}]},
 {group:"Administration",rows:[
 {what:"Invite staff and answer password resets",note:"HR cannot issue leadership or admin credentials",cells:["no","no","yes","no","yes"]},
 {what:"Manage group mappings and general access roles",cells:["no","no","no","no","yes"]},
 {what:"Moderate messages in joined conversations",cells:["Own messages","Own messages","Own messages","Own messages","yes"]}]}];
function MatrixCell({ value }: { value: Cell }) {
  if (value === "yes") return <span className={css.cell} data-kind="yes"><Check size={14} aria-hidden="true" /><span className={styles.srOnly}>Yes</span></span>;
  if (value === "no") return <span className={css.cell} data-kind="no"><Minus size={13} aria-hidden="true" /><span className={styles.srOnly}>No</span></span>;
  if (value === "perm") return <span className={css.cell} data-kind="perm"><KeyRound size={12} aria-hidden="true" />With permission</span>;
  return <span className={css.cell} data-kind="part">{value}</span>;
}

/** Who holds each restricted HR permission: one row per admin or HR person, one switch per permission. */
function Restricted({ grants, roles, canGrant, viewer }: { grants: PermissionGrant[]; roles: RoleHolder[]; canGrant: boolean; viewer: string | null }) {
  const router = useRouter(); const [busy, setBusy] = useState<string | null>(null);
  // Rows: everyone with the admin or HR role, then anyone who still holds a permission without the role.
  const rows = new Map<string, { id: string; name: string; roles: RoleKey[] }>();
  for (const r of roles.filter(r=>r.role==="admin")) rows.set(r.personId, { id: r.personId, name: r.name, roles: [...(rows.get(r.personId)?.roles ?? []), r.role] });
  for (const g of grants) if (!rows.has(g.personId)) rows.set(g.personId, { id: g.personId, name: g.name, roles: [] });
  const list = [...rows.values()].sort((a, b) => Number(!a.roles.length) - Number(!b.roles.length) || a.name.localeCompare(b.name));
  const held = (person: string, key: PermissionKey) => grants.find((g) => g.personId === person && g.permission === key);
  async function set(person: { id: string; name: string }, p: (typeof PERMISSIONS)[number], grant: boolean) {
    if (!window.confirm(grant ? `Let ${person.name} ${p.what}? It starts now and is recorded with your name.` : `Stop ${person.name} from being able to ${p.what}? It ends now.`)) return;
    setBusy(`${person.id}:${p.key}`);
    try {
      await post("settings/permissions", { personId: person.id, permission: p.key, action: grant ? "grant" : "revoke" });
      notify({ id: "permission", tone: "success", title: grant ? `${person.name} can now ${p.label.toLowerCase()}` : `${person.name} can no longer ${p.label.toLowerCase()}`, timeout: 3000 }); router.refresh();
    } catch (e) { notify({ id: "permission", tone: "error", title: "The permission was not changed", message: message(e) }); } finally { setBusy(null); }
  }
  return (
    <Panel fill title="Restricted HR permissions" sub="HR and leadership include people data; admins use named grants">
      <p className={css.note} data-tone="neutral" style={{ marginTop: 4 }}><Lock size={15} aria-hidden="true" /><span>HR and leadership roles include payroll, personal contact and document access. Operational admins use the named grants below. <b>Every salary read is logged</b> with who read it and when; the log is on the person’s HR tab and on the payroll page of the HR desk.{canGrant ? "" : " Only an organisation admin who holds “Read salary” can change these, so they are read-only for you."}</span></p>
      {list.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${css.permTable}`}>
        <thead><tr><th>Person</th>{PERMISSIONS.map((p) => <th key={p.key} title={`Can ${p.what}`}>{p.label}</th>)}</tr></thead>
        <tbody>{list.map((person) => (
          <tr key={person.id}>
            <td><Link href={`/people/${person.id}`} className={styles.person}><Avatar name={person.name} id={person.id} size={28} /><span><span className={styles.cellLink}>{person.name}{person.id === viewer ? <span className={styles.muted}> · you</span> : null}</span>
              <span className={styles.cellSub}>{person.roles.length ? person.roles.map((r) => r === "admin" ? "Admin" : "HR").join(" and ") : "No admin or HR role, so these have no effect"}</span></span></Link></td>
            {PERMISSIONS.map((p) => {
              const grant = held(person.id, p.key); const own = person.id === viewer && p.key === "hr.salary.read" && !!grant; const noRole = !person.roles.length && !grant;
              const why = !canGrant ? "Only an admin who holds “Read salary” can change this" : own ? "You cannot revoke your own salary access; ask another admin who holds it" : noRole ? "Give the admin or HR role first" : grant ? `Granted by ${grant.grantedBy}, ${dayTime(grant.grantedAt)}` : `Let ${person.name} ${p.what}`;
              return <td key={p.key}><label className={css.switch} title={why}>
                <input type="checkbox" checked={!!grant} disabled={!canGrant || own || noRole || busy !== null} onChange={() => set(person, p, !grant)} aria-label={`${p.label}: ${person.name}`} />
                <span aria-hidden="true" /><small>{grant ? "On" : "Off"}</small>
              </label></td>;
            })}
          </tr>
        ))}</tbody>
      </table></div> : <Empty icon={KeyRound} compact title="Nobody holds a restricted permission" text="Give someone the admin or HR role above first; then switch on what they need here." />}
    </Panel>
  );
}

/** Pick a person, read what the role lets them see, then confirm. */
function Grant({ role, people, holders, onClose }: { role: RoleKey; people: SettingsData["people"]; holders: Set<string>; onClose: () => void }) {
  const router = useRouter(); const [query, setQuery] = useState(""); const [picked, setPicked] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const q = query.trim().toLowerCase(); const shown = people.filter((p) => !q || `${p.name} ${p.role} ${p.pod ?? ""}`.toLowerCase().includes(q));
  const person = people.find((p) => p.id === picked);
  async function grant() {
    if (!person) return;
    setBusy(true); setError("");
    try { await post("settings/roles", { personId: person.id, role, action: "grant" }); notify({ id: "role", tone: "success", title: `${person.name} is now ${ROLE[role].one}`, timeout: 3000 }); onClose(); router.refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Make someone ${ROLE[role].one}`} onClose={onClose} foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!person || busy} onClick={grant}>{busy ? "Saving…" : person ? `Give ${person.name.split(/\s+/)[0]} the role` : "Choose a person"}</button></div>}>
      <div className={styles.modalBody}>
        <label className={`${styles.field} ${styles.wide}`}>Person<span className={styles.search} style={{ width: "100%" }}><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search current staff…" autoComplete="off" /></span></label>
        <Pager className={`${css.pickerPager} ${styles.wide}`} label="People"><ul className={css.picker}>
          {shown.length ? shown.map((p) => { const has = holders.has(p.id); return (
            <li key={p.id}><button type="button" className={css.pick} aria-pressed={picked === p.id} disabled={has} onClick={() => setPicked(p.id)}>
              <Avatar name={p.name} size={26} /><span className={css.pickText}><b style={{ fontWeight: 550 }}>{p.name}</b><small>{has ? `Already ${ROLE[role].one}` : [p.role, p.pod].filter(Boolean).join(" · ")}</small></span>
              {picked === p.id ? <Check size={15} aria-hidden="true" /> : null}
            </button></li>
          ); }) : <li className={styles.muted} style={{ padding: "12px 10px", fontSize: 14 }}>Nobody matches.</li>}
        </ul></Pager>
        <p className={css.confirmLine}>{person ? <><b>{person.name}</b> will see {ROLE[role].sees}. </> : `The ${ROLE[role].one} role lets a person see ${ROLE[role].sees}. `}It starts today, is recorded with your name, and can be ended here at any time.</p>
      </div>
    </Modal>
  );
}

/** Who holds the admin and HR roles, with grant and revoke, and what each role opens. */
export function Roles({ roles, people, permissions, canGrant, canEdit, viewer }: { roles: RoleHolder[]; people: SettingsData["people"]; permissions: PermissionGrant[]; canGrant: boolean; canEdit: boolean; viewer: string | null }) {
  const router = useRouter(); const [granting, setGranting] = useState<RoleKey | null>(null); const [busy, setBusy] = useState(false);
  async function revoke(h: RoleHolder) {
    if (!window.confirm(`End the ${ROLE[h.role].one} role for ${h.name}? From now on they no longer see ${ROLE[h.role].sees}.`)) return;
    setBusy(true);
    try { await post("settings/roles", { personId: h.personId, role: h.role, action: "revoke" }); notify({ id: "role", tone: "success", title: `${h.name} is no longer ${ROLE[h.role].one}`, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "role", tone: "error", title: "The role was not changed", message: message(e) }); } finally { setBusy(false); }
  }
  return <>
    <Workspace>
    <div className={css.roleGrid}>
      {(["admin","hr","leadership","finance","manager","pgs","head_pgs"] as const).map((key) => {
        const holders = roles.filter((r) => r.role === key);
        return (
          <Panel key={key} title={ROLE[key].title} sub={plural(holders.length, "person", "people")} tools={canEdit ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setGranting(key)}><Plus size={13} aria-hidden="true" />Add</button> : undefined}>
            {holders.length ? <ul className={styles.list}>{holders.map((h) => {
              const self = key === "admin" && h.personId === viewer;
              return (
                <li key={h.personId} className={css.holder}>
                  <Avatar name={h.name} id={h.personId} size={30} />
                  <span className={css.memberText}><Link href={`/people/${h.personId}`}>{h.name}{h.personId === viewer ? <span className={styles.muted}> · you</span> : null}</Link><small title={h.accounts.join(", ")}>Since {dayYear(h.since)}{h.accounts.length ? ` · ${h.accounts.join(", ")}` : " · no company account linked"}</small></span>
                  {canEdit ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}${self ? "" : ` ${styles.btnDanger}`}`} disabled={busy || self} title={self ? "You cannot end your own admin role; ask another admin" : undefined} onClick={() => revoke(h)}>Revoke</button> : null}
                </li>
              );
            })}</ul> : <Empty icon={key === "admin" ? ShieldCheck : HeartHandshake} compact title={`Nobody is ${ROLE[key].one}`} text={key === "hr" ? "Until someone holds this role, only admins can open the HR records." : undefined} />}
          </Panel>
        );
      })}
    </div>
    <Restricted grants={permissions} roles={roles} canGrant={canGrant} viewer={viewer} />
    <Panel title="What each role can do" sub="How Pulse decides, for every account">
      <div className={styles.tableWrap}><table className={`${styles.table} ${css.matrix}`}>
        <thead><tr><th>In Pulse, a person can…</th>{COLUMNS.map((c) => <th key={c}>{c}{c === "Manager / PGS" ? <small> of their reports</small> : null}</th>)}</tr></thead>
        {MATRIX.map((g) => (
          <tbody key={g.group}>
            <tr className={css.matrixGroup}><th colSpan={6} scope="colgroup">{g.group}</th></tr>
            {g.rows.map((r) => <tr key={r.what}><th scope="row">{r.what}{r.note ? <small>{r.note}</small> : null}</th>{r.cells.map((c, i) => <td key={i}><MatrixCell value={c} /></td>)}</tr>)}
          </tbody>
        ))}
      </table></div>
      <p className={styles.panelFoot}>“Everyone” is any signed-in member of staff. Managers and PGS use explicit pod role assignments and confirmed reporting lines. Operational admins need the named grants for restricted data. Admin moderation does not open other people’s direct messages.</p>
    </Panel>
    </Workspace>
    {granting ? <Grant role={granting} people={people} holders={new Set(roles.filter((r) => r.role === granting).map((r) => r.personId))} onClose={() => setGranting(null)} /> : null}
  </>;
}
