"use client";
// UX-PEOPLE (owner, 5 Nov 2026: "I hate the per-role tabs that make me re-assign people"): ONE matrix of people ×
// what they can do. Each row is a person; the role templates they hold are chips; every column says what those roles
// give them, as the service enforces it. Choose people and give or take a role in one go; open a person to read
// "what can this person do" in plain words and switch their roles and named HR grants there. Every change still goes
// through POST settings/roles and settings/permissions, which make the same checks as before (nothing is widened).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, CircleSlash, History, KeyRound, ListChecks, Lock, Minus, Search, ShieldCheck, Sparkles, UserRoundCheck, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { EVERYONE, NAMED, accessWords, workRole, type Change, type PermissionKey, type Profile, type RoleKey } from "../../lib/access-matrix.mjs";
import { useWords } from "../../org-code";
import { Modal, post } from "../../records";
import { Avatar, styles } from "../../ui";
import { Card, ChipFilter, EmptyState, SectionHeader, StartWith, StripeCard, calm, type Pick } from "../../components";
import { dayTime } from "../../lib/format";
import { SCOPE, type RulesData } from "../../settings/work-rules";
import type { PermissionGrant, RoleHolder, SalaryList, StaffPerson } from "../../settings/types";
import css from "./matrix.module.css";
import { SelectField } from "../../kit/select-field";

export type AccessData = { roles: RoleHolder[]; people: StaffPerson[]; permissions: PermissionGrant[]; canGrant: boolean; canEdit: boolean; salaryList?: SalaryList };
const NO_ROLE = "none";
const message = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string) => name.split(/\s+/)[0];
/** DE-EA: the role templates and capabilities in the company's own words ("Pod leads" or "Team leads"). */
function useAccess() { const words = useWords(); return useMemo(() => accessWords(words), [words]); }

/** One matrix cell: a tick, a dash, a key (needs a grant) or a few words (their team). Always readable as text too. */
function Cell({ level, text, title }: { level: string; text: string; title?: string }) {
  const icon = level === "yes" ? <Check size={15} aria-hidden="true" /> : level === "no" ? <Minus size={14} aria-hidden="true" /> : level === "grant" || level === "idle" ? <KeyRound size={13} aria-hidden="true" /> : null;
  return <span className={css.cell} data-level={level} title={title ?? text}>{icon}{level === "yes" || level === "no" ? <span className={styles.srOnly}>{text}</span> : <span className={css.cellText}>{text}</span>}</span>;
}

function RoleChips({ roles }: { roles: RoleKey[] }) {
  const { TEMPLATE } = useAccess();
  if (!roles.length) return <span className={css.noRole}>Everyone’s access</span>;
  return <span className={css.roleChips}>{roles.map((r) => <span key={r} className={css.roleChip} style={{ "--hue": TEMPLATE[r].hue } as CSSProperties}>{TEMPLATE[r].short}</span>)}</span>;
}

export function AccessMatrix({ data, rules, viewer }: { data: AccessData; rules: RulesData | null; viewer: string | null }) {
  const router = useRouter();
  const { TEMPLATE, TEMPLATES, CAPABILITIES, profile, planBulk, teamWord } = useAccess();
  const salaryOn = !!data.salaryList?.on;
  const leads = useMemo(() => new Set(data.people.map((p) => p.managerId).filter((x): x is string => !!x)), [data.people]);
  const profiles = useMemo(() => new Map(data.people.map((p) => [p.id, profile(p, data.roles, data.permissions, salaryOn)])), [data.people, data.roles, data.permissions, salaryOn, profile]);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ action: "grant" | "revoke"; role: RoleKey } | null>(null);
  const [busy, setBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const rows = data.people.filter((p) => {
    const roles = profiles.get(p.id)!.roles;
    if (filter === NO_ROLE ? roles.length : filter !== "all" && !roles.includes(filter as RoleKey)) return false;
    return !q || `${p.name} ${p.role} ${p.pod ?? ""}`.toLowerCase().includes(q);
  });
  // Counts and picks come from the active people the table shows (settings lists every holder, active or not).
  const active = useMemo(() => new Set(data.people.map((p) => p.id)), [data.people]);
  const holdersOf = (role: RoleKey) => data.roles.filter((r) => r.role === role && active.has(r.personId)).length;
  const gone = lingering(data, active);
  const noRole = data.people.filter((p) => !profiles.get(p.id)!.roles.length).length;
  const chips = [{ key: "all", label: "Everyone", count: data.people.length }, ...TEMPLATES.map((t) => ({ key: t.key, label: t.title, count: holdersOf(t.key), hue: t.hue })), { key: NO_ROLE, label: "No role", count: noRole, tone: "quiet" as const }];
  const person = open ? data.people.find((p) => p.id === open) ?? null : null;
  const allShown = rows.length > 0 && rows.every((p) => chosen.has(p.id));
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Phone: the person comes first and the page scrolls to them. 1024-1599: a drawer on the right over the table.
  const openPerson = (id: string) => { setOpen(id); if (window.matchMedia("(max-width: 1023px)").matches) window.setTimeout(() => document.getElementById("person-view")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !bulk) setOpen(null); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [open, bulk]);

  // What to do first, in plain words (nothing when all is well).
  const picks: Pick[] = [];
  if (!holdersOf("hr")) picks.push({ key: "hr", title: "Nobody is HR yet", why: "Until someone holds HR, only admins open HR records. Choose a person and give them HR.", onClick: () => setFilter(NO_ROLE) });
  const idle = data.permissions.filter((g) => g.effective === false && active.has(g.personId));
  if (idle.length) picks.push({ key: "idle", title: `${idle[0].name} holds a grant that does nothing`, why: "Grants only work on top of the admin, HR or leadership role. Open them to give the role or end the grant.", onClick: () => openPerson(idle[0].personId), tone: "warn" });
  const byRoleOnly = (data.salaryList?.byRoleOnly ?? []).filter((x) => active.has(x.personId));
  if (gone.length) picks.push({ key: "gone", title: `${gone.length} no longer active ${gone.length === 1 ? "still holds" : "still hold"} access`, why: "They left or were paused but keep a role or grant. End it below the table.", onClick: () => document.getElementById("lingering")?.scrollIntoView({ behavior: "smooth", block: "start" }), tone: "warn" });
  if (salaryOn && byRoleOnly.length) picks.push({ key: "salary", title: `${byRoleOnly.length} with salary by role only`, why: "Salaries are by named list, so they see none until they are named.", onClick: () => setFilter("hr"), tone: "warn" });
  if (holdersOf("admin") === 1) picks.push({ key: "admin", title: "Only one organisation admin", why: "Name a second admin so access never depends on one person.", onClick: () => setFilter(NO_ROLE) });

  async function run(changes: Change[]) {
    setBusy(true);
    const failed: string[] = [];
    for (const c of changes) {
      try { await post("settings/roles", { personId: c.personId, role: c.role, action: c.action }); }
      catch (e) { failed.push(`${c.name}: ${message(e)}`); }
    }
    setBusy(false); setBulk(null);
    const done = changes.length - failed.length;
    if (done) notify({ id: "access-bulk", tone: failed.length ? "info" : "success", title: `${done} ${done === 1 ? "change" : "changes"} saved`, message: failed.length ? `${failed.length} not saved: ${failed.join("; ")}` : undefined, timeout: failed.length ? undefined : 3000 });
    else notify({ id: "access-bulk", tone: "error", title: "Nothing was changed", message: failed.join("; ") });
    setChosen(new Set()); router.refresh();
  }

  const chosenPeople = data.people.filter((p) => chosen.has(p.id));
  const planned = bulk ? planBulk(chosenPeople, data.roles, bulk.action, bulk.role, viewer) : null;

  return <>
    <div className={css.layout} data-open={person ? "" : undefined}>
      <div className={css.main}>
        <StartWith picks={picks.slice(0, 3)} icon={Sparkles} />
        <ChipFilter label="Filter by role" chips={chips} value={filter} onPick={setFilter} />
        <Card label="People and what they can do">
          <div className={css.tools}>
            <SectionHeader icon={Users} title={filter === "all" ? "Everyone" : filter === NO_ROLE ? "People with no role" : TEMPLATE[filter as RoleKey].title} count={`${rows.length} ${rows.length === 1 ? "person" : "people"}`} />
            <label className={css.search}><Search size={15} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a person" aria-label="Find a person" /></label>
          </div>
          {!rows.length ? q ? <EmptyState icon={UserRoundCheck} title="Nobody matches" text="Try another name, or show everyone.">
            <button type="button" className={calm.btn} onClick={() => { setQuery(""); setFilter("all"); }}>Show everyone</button>
          </EmptyState> : filter === "all" ? <EmptyState icon={UserRoundCheck} title="Nobody here yet" text="People show here once they are invited and active. Invite them from People, then give them roles here.">
            <Link href="/people" className={calm.btnPrimary}>Go to People</Link>
          </EmptyState> : <EmptyState icon={UserRoundCheck} title={filter === NO_ROLE ? "Everyone has a role" : "Nobody holds this role"} text={filter === NO_ROLE ? "Every active person holds at least one role." : "Choose people in Everyone, then give them this role with “Give a role”."}>
            <button type="button" className={calm.btn} onClick={() => { setQuery(""); setFilter("all"); }}>Show everyone</button>
          </EmptyState> : <>
            {/* Computer: the matrix. Phone: one card per person (no sideways scroll). */}
            <div className={css.tableWrap}>
              <table className={css.table}>
                <caption className={styles.srOnly}>People and what their roles let them do</caption>
                <thead><tr>
                  <th scope="col" className={css.pickCol}>{data.canEdit ? <input type="checkbox" className={css.box} checked={allShown} onChange={() => setChosen(allShown ? new Set() : new Set(rows.map((p) => p.id)))} aria-label="Choose everyone shown" /> : null}</th>
                  <th scope="col" className={css.personCol}>Person</th>
                  {CAPABILITIES.map((c) => <th key={c.key} scope="col" title={c.label}>{c.short}</th>)}
                  <th scope="col" title="Read salary · Edit salary">Salary</th>
                  <th scope="col" title="Personal contact and HR document names">HR data</th>
                </tr></thead>
                <tbody>{rows.map((p) => {
                  const pr = profiles.get(p.id)!;
                  const salary = pr.perms.filter((x) => x.key.startsWith("hr.salary."));
                  const data2 = pr.perms.filter((x) => !x.key.startsWith("hr.salary."));
                  const sum = (xs: Profile["perms"]) => xs.every((x) => x.level === "yes") ? { level: "yes", text: xs[0].text } : xs.some((x) => x.level === "yes") ? { level: "part", text: "Some" } : xs.some((x) => x.level === "idle") ? { level: "idle", text: "No effect" } : { level: "no", text: "No" };
                  return <tr key={p.id} data-open={open === p.id ? "" : undefined} data-chosen={chosen.has(p.id) ? "" : undefined}>
                    <td className={css.pickCol}>{data.canEdit ? <input type="checkbox" className={css.box} checked={chosen.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Choose ${p.name}`} /> : null}</td>
                    <th scope="row" className={css.personCol}>
                      <button type="button" className={css.personBtn} onClick={() => openPerson(p.id)} aria-label={`What can ${p.name} do?`}>
                        <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={30} />
                        <span className={css.personText}><b>{p.name}{p.id === viewer ? <span className={css.you}> · you</span> : null}</b><RoleChips roles={pr.roles} /></span>
                      </button>
                    </th>
                    {pr.caps.map((c) => <td key={c.key}><Cell level={c.level} text={c.text} title={`${c.label}: ${c.text}${c.from ? ` (from ${TEMPLATE[c.from].one})` : ""}`} /></td>)}
                    <td><Cell {...sum(salary)} title={salary.map((s) => `${s.label}: ${s.text}`).join(" · ")} /></td>
                    <td><Cell {...sum(data2)} title={data2.map((s) => `${s.label}: ${s.text}`).join(" · ")} /></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <ul className={css.cards}>{rows.map((p) => {
              const pr = profiles.get(p.id)!;
              const tone = pr.idle.length ? "warn" : pr.roles.includes("admin") ? undefined : pr.roles.length ? undefined : "quiet";
              return <li key={p.id} className={css.cardRow}>
                {data.canEdit ? <input type="checkbox" className={css.box} checked={chosen.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Choose ${p.name}`} /> : null}
                <StripeCard tone={tone} hue={pr.roles[0] ? TEMPLATE[pr.roles[0]].hue : undefined} onClick={() => openPerson(p.id)} pressed={open === p.id} label={`What can ${p.name} do?`}
                  title={<><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={26} /><span>{p.name}{p.id === viewer ? " · you" : ""}</span></>}
                  meta={<><RoleChips roles={pr.roles} /><span>{pr.can ? `Can do ${pr.can} of ${CAPABILITIES.length + NAMED.length}` : "Only their own things"}</span>{pr.idle.length ? <span className={css.warn}>A grant does nothing</span> : null}</>} />
              </li>;
            })}</ul>
          </>}
          <p className={css.legend}><span><Cell level="yes" text="Yes" /> Yes</span><span><Cell level="part" text={teamWord.charAt(0).toUpperCase() + teamWord.slice(1)} /> Part (their {teamWord})</span><span><Cell level="no" text="No" /> No</span></p>
        </Card>
        {gone.length ? <Lingering gone={gone} data={data} /> : null}
      </div>
      <aside className={css.rail} id="person-view" aria-label={person ? `What ${person.name} can do` : "Role templates"}>
        {person ? <PersonView key={person.id} person={person} pr={profiles.get(person.id)!} data={data} rules={rules} viewer={viewer} leads={leads.has(person.id)} onClose={() => setOpen(null)} />
          : <Templates counts={Object.fromEntries(TEMPLATES.map((t) => [t.key, holdersOf(t.key)]))} onPick={setFilter} salaryOn={salaryOn} />}
      </aside>
    </div>
    {data.canEdit && chosen.size ? <div className={css.bulkBar} role="region" aria-label="Change the people chosen">
      <b>{chosen.size} chosen</b>
      <label className={css.bulkPick}><span className={styles.srOnly}>Give a role</span>
        <SelectField value="" onChange={(e) => e.target.value && setBulk({ action: "grant", role: e.target.value as RoleKey })} aria-label="Give a role"><option value="">Give a role…</option>{TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}</SelectField></label>
      <label className={css.bulkPick}><span className={styles.srOnly}>Take a role away</span>
        <SelectField value="" onChange={(e) => e.target.value && setBulk({ action: "revoke", role: e.target.value as RoleKey })} aria-label="Take a role away"><option value="">Take a role away…</option>{TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}</SelectField></label>
      <button type="button" className={calm.btn} onClick={() => setChosen(new Set())}><X size={15} aria-hidden="true" />Clear</button>
    </div> : null}
    {bulk && planned ? <Modal title={`${bulk.action === "grant" ? "Give" : "Take away"} ${TEMPLATE[bulk.role].title}`} onClose={() => !busy && setBulk(null)}
      foot={<div className={styles.modalFoot}><span /><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setBulk(null)} disabled={busy}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !planned.plan.length} onClick={() => run(planned.plan)}>{busy ? "Saving…" : planned.plan.length ? `${bulk.action === "grant" ? "Give" : "Take away"} for ${planned.plan.length}` : "Nothing to change"}</button></div>}>
      <div className={styles.modalBody}>
        <p className={css.confirm}>{bulk.action === "grant" ? <>They will see {TEMPLATE[bulk.role].sees}.</> : <>From now on they no longer see {TEMPLATE[bulk.role].sees}.</>} It starts today and is recorded with your name.</p>
        {planned.plan.length ? <ul className={css.changeList}>{planned.plan.map((c) => <li key={c.personId}><Check size={14} aria-hidden="true" />{c.name}</li>)}</ul> : null}
        {planned.skipped.length ? <><p className={css.confirm}><b>Left as they are:</b></p><ul className={css.changeList} data-quiet="">{planned.skipped.map((s) => <li key={s.person.id}><CircleSlash size={14} aria-hidden="true" />{s.person.name}: {s.why}</li>)}</ul></> : null}
      </div>
    </Modal> : null}
  </>;
}

/** The rail with nobody open: the role templates in plain words, each one filtering the matrix. */
function Templates({ counts, onPick, salaryOn }: { counts: Record<string, number>; onPick: (k: string) => void; salaryOn: boolean }) {
  const { TEMPLATES } = useAccess();
  return <>
    <Card label="Role templates">
      <SectionHeader icon={ShieldCheck} title="Role templates" count="who holds each" />
      <p className={calm.quiet}>A person can hold several. What they can do is the widest of their roles. Open a person to change theirs.</p>
      <ul className={css.templateList}>{TEMPLATES.map((t) => <li key={t.key}>
        <StripeCard hue={t.hue} onClick={() => onPick(t.key)} label={`Show ${t.title}`} title={<><span>{t.title}</span><small className={css.count}>{counts[t.key]}</small></>} meta={<span className={css.sees}>Sees {t.sees}.</span>} />
      </li>)}</ul>
    </Card>
    <Card label="Everyone">
      <SectionHeader icon={ListChecks} title="Everyone can" />
      <ul className={css.plain}>{EVERYONE.map((x) => <li key={x}>{x}</li>)}</ul>
      <p className={calm.quiet}>{salaryOn ? "Salaries are by named list: only people named for “Read salary” see them." : "HR and leadership see salaries by their role."} Every restricted read is logged.</p>
    </Card>
  </>;
}

/** "What can this person do": their roles (switch on or off), what that lets them do, their named HR grants and how the
 *  work rules apply to them. */
function PersonView({ person, pr, data, rules, viewer, leads, onClose }: { person: StaffPerson; pr: Profile; data: AccessData; rules: RulesData | null; viewer: string | null; leads: boolean; onClose: () => void }) {
  const router = useRouter(); const [busy, setBusy] = useState<string | null>(null);
  const { TEMPLATE, TEMPLATES, teamWord } = useAccess();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);
  const salaryOn = !!data.salaryList?.on;
  async function role(r: RoleKey, on: boolean) {
    if (!window.confirm(on ? `Make ${person.name} ${TEMPLATE[r].one}? They will see ${TEMPLATE[r].sees}.` : `End the ${TEMPLATE[r].one} role for ${person.name}? They no longer see ${TEMPLATE[r].sees}.`)) return;
    setBusy(r);
    try { await post("settings/roles", { personId: person.id, role: r, action: on ? "grant" : "revoke" }); notify({ id: "role", tone: "success", title: on ? `${person.name} is now ${TEMPLATE[r].one}` : `${person.name} is no longer ${TEMPLATE[r].one}`, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "role", tone: "error", title: "The role was not changed", message: message(e) }); } finally { setBusy(null); }
  }
  async function grant(key: PermissionKey, label: string, what: string, on: boolean) {
    if (!window.confirm(on ? `Let ${person.name} ${what}? It starts now and is recorded with your name.` : `Stop ${person.name} from being able to ${what}? It ends now.`)) return;
    setBusy(key);
    try { await post("settings/permissions", { personId: person.id, permission: key, action: on ? "grant" : "revoke" }); notify({ id: "permission", tone: "success", title: on ? `${person.name} can now ${label.toLowerCase()}` : `${person.name} can no longer ${label.toLowerCase()}`, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "permission", tone: "error", title: "The permission was not changed", message: message(e) }); } finally { setBusy(null); }
  }
  const can = pr.caps.filter((c) => c.level !== "no"), cannot = pr.caps.filter((c) => c.level === "no");
  const wr = workRole(pr.roles, leads);
  const scope = (action: "task.assign" | "task.ask" | "project.create") => wr === "leadership" ? SCOPE[action].anyone : SCOPE[action][rules?.cells.find((c) => c.role === wr && c.action === action)?.scope ?? ""] ?? "As the work rules say";
  const canGrantHere = data.canGrant;
  return <>
    <Card label={`${person.name}: roles`}>
      <div className={css.personHead}>
        <Avatar name={person.name} id={person.id} photoAt={person.photoAt} size={40} />
        <div className={css.personHeadText}><b>{person.name}{person.id === viewer ? <span className={css.you}> · you</span> : null}</b><small>{[person.role, person.pod].filter(Boolean).join(" · ")}</small></div>
        <button ref={closeRef} type="button" className={css.close} onClick={onClose} aria-label="Close and show the role templates" title="Close (Esc)"><X size={18} aria-hidden="true" /></button>
      </div>
      <SectionHeader as="h3" icon={ShieldCheck} title="Roles" count={pr.roles.length ? `${pr.roles.length} held` : "none"} />
      <div className={css.toggles} role="group" aria-label={`${person.name}'s roles`}>
        {TEMPLATES.map((t) => {
          const on = pr.roles.includes(t.key);
          const self = on && t.key === "admin" && person.id === viewer;
          const why = !data.canEdit ? "Only organisation admins change roles" : self ? "You cannot end your own admin role; ask another admin" : t.pod && !on && !person.pod ? `Put them in a ${teamWord} first` : on ? `End ${t.one}` : `Make ${first(person.name)} ${t.one}`;
          return <button key={t.key} type="button" className={css.toggle} aria-pressed={on} style={{ "--hue": t.hue } as CSSProperties} disabled={!data.canEdit || self || busy !== null || (t.pod && !on && !person.pod)} title={why} onClick={() => role(t.key, !on)}>
            {on ? <Check size={14} aria-hidden="true" /> : null}{t.short}
          </button>;
        })}
      </div>
      <p className={calm.quiet}>{pr.roles.length ? `What ${first(person.name)} can do is the widest of these roles.` : `${first(person.name)} has everyone’s access: their own things and the team directory.`}</p>
    </Card>
    <Card label={`What ${person.name} can do`}>
      <SectionHeader as="h3" icon={Check} title={`What ${first(person.name)} can do`} count={`${can.length} of ${pr.caps.length}`} />
      {can.length ? <ul className={css.canList}>{can.map((c) => <li key={c.key} data-level={c.level}><Cell level={c.level} text={c.text} /><span><b>{c.label}</b><small>{c.level === "yes" ? "" : `${c.text}. `}{c.from ? `From ${TEMPLATE[c.from].one}.` : ""}{c.note ? ` ${c.note}.` : ""}</small></span></li>)}</ul>
        : <p className={calm.quiet}>Only their own profile, attendance, leave and chats. Give a role above to open more.</p>}
      {cannot.length ? <details className={css.more}><summary>Cannot ({cannot.length})</summary><ul className={css.plain}>{cannot.map((c) => <li key={c.key}>{c.label}</li>)}</ul></details> : null}
    </Card>
    <Card label="Restricted HR data">
      <SectionHeader as="h3" icon={Lock} title="Restricted HR data" count={salaryOn ? "salary by named list" : "salary by role"} />
      <ul className={css.grants}>{pr.perms.map((p) => {
        const own = person.id === viewer && p.key === "hr.salary.read" && !!p.grant;
        const roleOk = pr.roles.some((r) => r === "admin" || r === "hr" || r === "leadership");
        const held = !!p.grant;
        const why = !canGrantHere ? "Only an organisation admin who holds “Read salary” changes these" : own ? "You cannot revoke your own salary access; ask another admin who holds it" : !held && !roleOk ? "Give the admin, HR or leadership role first" : held ? `Granted by ${p.grant?.grantedBy ?? "an admin"}${p.grant?.grantedAt ? `, ${dayTime(p.grant.grantedAt)}` : ""}` : `Let ${first(person.name)} ${p.what}`;
        return <li key={p.key}>
          <span className={css.grantText}><b>{p.label}</b><small>{p.level === "idle" ? "Granted, but does nothing without the admin, HR or leadership role" : p.byRole && !held ? "By their role" : held ? why : "Not allowed"}</small></span>
          <label className={css.switch} title={why}>
            <input type="checkbox" role="switch" checked={held} disabled={!canGrantHere || own || (!held && !roleOk) || busy !== null} onChange={() => grant(p.key, p.label, p.what, !held)} aria-label={`${p.label}: ${person.name}`} />
            <span aria-hidden="true" />
          </label>
        </li>;
      })}</ul>
      <p className={calm.quiet}>{canGrantHere ? "Named grants sit on top of a role. Every restricted read is logged." : "Read-only for you: only an organisation admin who holds “Read salary” changes these."}</p>
    </Card>
    <Card label="In Work">
      <SectionHeader as="h3" icon={ListChecks} title="In Work" count={wr === "leadership" ? "leadership rules" : wr === "hr" ? "HR rules" : wr === "pod_head" ? `${teamWord} head rules` : "member rules"} />
      <dl className={css.facts}>
        <dt>Assign tasks to</dt><dd>{scope("task.assign")}</dd>
        <dt>Ask someone to take a task</dt><dd>{scope("task.ask")}</dd>
        <dt>Create projects</dt><dd>{scope("project.create")}</dd>
      </dl>
      <p className={calm.quiet}><Link href="/settings?tab=work-rules">Change the work rules</Link> for everyone in a column at once.</p>
    </Card>
  </>;
}

type Gone = { personId: string; name: string; roles: RoleHolder[]; grants: PermissionGrant[] };
/** Roles and named grants still held by people who are not active (left or paused): the table only shows active people,
 *  so these are listed on their own and can be ended. */
function lingering(data: AccessData, active: Set<string>): Gone[] {
  const by = new Map<string, Gone>();
  const at = (id: string, name: string) => { let g = by.get(id); if (!g) by.set(id, g = { personId: id, name, roles: [], grants: [] }); return g; };
  for (const r of data.roles) if (!active.has(r.personId)) at(r.personId, r.name).roles.push(r);
  for (const g of data.permissions) if (!active.has(g.personId)) at(g.personId, g.name).grants.push(g);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function Lingering({ gone, data }: { gone: Gone[]; data: AccessData }) {
  const router = useRouter(); const [busy, setBusy] = useState<string | null>(null);
  const { TEMPLATE } = useAccess();
  async function end(key: string, what: string, path: string, body: Record<string, string>) {
    if (!window.confirm(`End ${what}? It ends now and is recorded with your name.`)) return;
    setBusy(key);
    try { await post(path, body); notify({ id: "lingering", tone: "success", title: `Ended ${what}`, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "lingering", tone: "error", title: "Nothing was changed", message: message(e) }); } finally { setBusy(null); }
  }
  const PERM: Record<string, string> = { "hr.salary.read": "Read salary", "hr.salary.edit": "Edit salary" };
  return <section id="lingering" className={css.lingering} aria-label="No longer active, still holding access">
    <SectionHeader icon={History} title="No longer active, still holding access" count={`${gone.length} ${gone.length === 1 ? "person" : "people"}`} tone="bad" />
    <p className={calm.quiet}>They are not in the table because they left or were paused. Their access does nothing while they cannot sign in, but end it so it cannot come back with them.</p>
    <ul className={css.cards}>{gone.map((g) => <li key={g.personId}>
      <StripeCard tone="warn" title={<span>{g.name} · no longer active</span>}
        meta={<>{g.roles.map((r) => <span key={r.role} className={css.goneItem}>{TEMPLATE[r.role]?.title ?? r.role}
          {data.canEdit ? <button type="button" className={css.goneEnd} disabled={busy !== null} onClick={() => end(`r-${g.personId}-${r.role}`, `${g.name}'s ${TEMPLATE[r.role]?.one ?? r.role} role`, "settings/roles", { personId: g.personId, role: r.role, action: "revoke" })} aria-label={`End ${g.name}'s ${TEMPLATE[r.role]?.title ?? r.role} role`}>End</button> : null}</span>)}
          {g.grants.map((x) => <span key={x.permission} className={css.goneItem}>{PERM[x.permission] ?? x.permission}
          {data.canGrant ? <button type="button" className={css.goneEnd} disabled={busy !== null} onClick={() => end(`p-${g.personId}-${x.permission}`, `${g.name}'s ${PERM[x.permission] ?? x.permission} grant`, "settings/permissions", { personId: g.personId, permission: x.permission, action: "revoke" })} aria-label={`End ${g.name}'s ${PERM[x.permission] ?? x.permission} grant`}>End</button> : null}</span>)}</>} />
    </li>)}</ul>
  </section>;
}
