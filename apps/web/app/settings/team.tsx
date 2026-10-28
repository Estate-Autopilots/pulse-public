"use client";

import { ArrowRightLeft, Network, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { plural, userId } from "../lib/format";
import { Modal, post } from "../records";
import { Avatar, Empty, styles, Workspace } from "../ui";
import { Combobox, Menu } from "../kit";
import css from "./settings.module.css";
import type { Member, Pod, StaffPerson } from "./types";
import { useOrgCode } from "../org-code";
import { W } from "../kit/word";
import { lower } from "../lib/words.mjs";
import { useWords } from "../org-code";

const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";
const firstName = (name: string) => name.split(/\s+/)[0];

/** Create a pod or rename one: a single name field in a dialog. */
function PodName({ pod, onClose }: { pod?: Pod; onClose: () => void }) {
  const words = useWords();
  const router = useRouter(); const formId = useId(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (pod && name === pod.name) { onClose(); return; }
    setBusy(true); setError("");
    try {
      await post(pod ? `settings/pods/${pod.id}` : "settings/pods", { name });
      notify({ id: "pod", tone: "success", title: pod ? `Renamed to ${name}` : `${name} created`, timeout: 2500 });
      onClose(); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={pod ? `Rename ${pod.name}` : `New ${lower(words.team)}`} onClose={onClose} foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : pod ? "Rename" : `Create ${lower(words.team)}`}</button></div>}>
      <form id={formId} className={styles.modalBody} onSubmit={submit}>
        <label className={`${styles.field} ${styles.wide}`}><W k="team" /> name<input name="name" defaultValue={pod?.name ?? ""} required minLength={2} maxLength={40} placeholder={`e.g. ${words.team} 3`} autoComplete="off" /></label>
        <p className={styles.modalNote}>{pod ? `The ${plural(pod.members.length, "person", "people")} in this ${lower(words.team)} follow the new name, and keep it when the sources sync.` : `The ${lower(words.team)} starts empty. Move people into it from the other ${lower(words.teams)} afterwards.`}</p>
      </form>
    </Modal>
  );
}

/** Everyone below each person in the reporting lines. A person can never report to someone in their own set. */
function reportingTree(people: StaffPerson[]) {
  const ids = new Set(people.map((p) => p.id)); const children = new Map<string, StaffPerson[]>();
  for (const p of people) if (p.managerId && ids.has(p.managerId)) children.set(p.managerId, [...(children.get(p.managerId) ?? []), p]);
  const below = new Map<string, Set<string>>();
  const walk = (id: string, seen: Set<string>): Set<string> => {
    const known = below.get(id); if (known) return known;
    const all = new Set<string>();
    for (const child of children.get(id) ?? []) if (!seen.has(child.id)) { all.add(child.id); for (const x of walk(child.id, new Set([...seen, child.id]))) all.add(x); }
    below.set(id, all); return all;
  };
  for (const p of people) walk(p.id, new Set([p.id]));
  const top = people.filter((p) => !p.managerId || !ids.has(p.managerId));
  return { children, below, top };
}

/** Pods with their people, and the reporting lines: who is in which pod and who reports to whom. */
export function Team({ pods, unassigned, people, canEdit, initialView = "pods" }: { pods: Pod[]; unassigned: Member[]; people: StaffPerson[]; canEdit: boolean; initialView?: "pods" | "lines" }) {
  const words = useWords();
  const orgCode = useOrgCode();
  const router = useRouter(); const [view, setView] = useState<"pods" | "lines">(initialView);
  const [naming, setNaming] = useState<Pod | "new" | null>(null); const [saving, setSaving] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const tree = useMemo(() => reportingTree(people), [people]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const managed = people.filter((p) => p.managerId && byId.has(p.managerId)).length;
  async function move(person: Member, pod: string) {
    setSaving(person.id);
    try {
      await post(`people/${person.id}`, { pod });
      notify({ id: `move:${person.id}`, tone: "success", title: pod ? `${person.name} moved to ${pod}` : `${person.name} is no longer in a ${lower(words.team)}`, timeout: 2500 });
      router.refresh();
    } catch (e) { notify({ id: `move:${person.id}`, tone: "error", title: `${person.name} was not moved`, message: message(e) }); } finally { setSaving(null); }
  }
  async function report(person: Member, managerId: string) {
    setSaving(person.id);
    try {
      await post(`people/${person.id}`, { managerId });
      const manager = byId.get(managerId);
      notify({ id: `manager:${person.id}`, tone: "success", title: manager ? `${person.name} now reports to ${manager.name}` : `${person.name} no longer has a manager`, timeout: 2500 });
      router.refresh();
    } catch (e) { notify({ id: `manager:${person.id}`, tone: "error", title: `${person.name}'s manager was not changed`, message: message(e) }); } finally { setSaving(null); }
  }
  /** One manager for everyone in a pod who has none yet: the quick way to start. */
  async function reportPod(pod: Pod, managerId: string) {
    const manager = byId.get(managerId); if (!manager) return;
    const targets = pod.members.filter((m) => m.id !== managerId && !m.managerId && !tree.below.get(m.id)?.has(managerId));
    if (!targets.length) { notify({ id: `pod-manager:${pod.id}`, tone: "info", title: "Nothing to change", message: `Everyone in ${pod.name} already has a manager.` }); return; }
    if (!window.confirm(`Make ${manager.name} the manager of ${plural(targets.length, "person", "people")} in ${pod.name} who ${targets.length === 1 ? "has" : "have"} no manager yet? ${firstName(manager.name)} will be able to approve their leave and attendance corrections.`)) return;
    setBusy(true); let done = 0; const failed: string[] = [];
    for (const m of targets) { try { await post(`people/${m.id}`, { managerId }); done += 1; } catch { failed.push(m.name); } }
    setBusy(false);
    notify({ id: `pod-manager:${pod.id}`, tone: failed.length ? "error" : "success", title: `${plural(done, "person", "people")} in ${pod.name} now ${done === 1 ? "reports" : "report"} to ${manager.name}`, message: failed.length ? `Not changed: ${failed.join(", ")}.` : undefined, timeout: failed.length ? undefined : 3000 });
    router.refresh();
  }
  async function remove(pod: Pod) {
    if (!window.confirm(`Remove ${pod.name}? It has no people or projects, so nothing else changes.`)) return;
    setBusy(true);
    try { await post(`settings/pods/${pod.id}`, { action: "remove" }); notify({ id: "pod", tone: "success", title: `${pod.name} removed`, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "pod", tone: "error", title: `${pod.name} was not removed`, message: message(e) }); } finally { setBusy(false); }
  }
  const locked = saving !== null || busy;
  /** "Reports to" as a compact picker (search, faces). People who already report up to this person cannot be chosen.
   *  UI-UPGRADE: the kit's list instead of a native select. */
  const managerSelect = (m: Member) => {
    const under = tree.below.get(m.id); const current = m.managerId && byId.has(m.managerId) ? m.managerId : null;
    return (
      <span className={css.reports} data-set={current ? "" : undefined}><span>Reports to</span>
        <Combobox label={`Who ${m.name} reports to`} value={current} disabled={locked} size="sm" variant="ghost" noneLabel="Nobody" placeholder="Nobody" searchable searchPlaceholder="Search people"
          options={people.filter((p) => p.id !== m.id).map((p) => ({ value: p.id, label: p.name, icon: <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={20} />,
            detail: under?.has(p.id) ? `Reports to ${firstName(m.name)}` : p.pod ?? undefined, disabled: under?.has(p.id) }))}
          onChange={(v) => { if (!locked) report(m, v ?? ""); }} />
      </span>
    );
  };
  const members = (list: Member[], current: string) => list.map((m) => (
    <li key={m.id} className={css.member} data-busy={saving === m.id ? "" : undefined}>
      <Avatar name={m.name} id={m.id} photoAt={m.photoAt} size={28} />
      <span className={css.memberText}><Link href={`/people/${m.id}`}>{m.name}</Link><small>{m.role}</small></span>
      {canEdit ? <span className={css.memberControls}>
        <Menu label={`Move ${m.name} to`} buttonLabel={`Move ${m.name} to another ${lower(words.team)}`} title={`Move to another ${lower(words.team)}`} className={css.moveBtn}
          items={[{ key: "h", heading: "Move to", label: "" }, ...pods.filter((p) => p.name !== current).map((p) => ({ key: p.id, label: p.name, icon: <UsersRound size={15} aria-hidden="true" />, onSelect: () => { if (!locked) move(m, p.name); } })),
            ...(current ? [{ key: "-sep", separator: true, label: "" }, { key: "-", label: `No ${lower(words.team)}`, onSelect: () => { if (!locked) move(m, ""); } }] : [])]}>
          <ArrowRightLeft size={14} aria-hidden="true" /><span>Move</span></Menu>
        {managerSelect(m)}
      </span> : m.managerId && byId.has(m.managerId) ? <small className={styles.muted}>Reports to {firstName(byId.get(m.managerId)!.name)}</small> : null}
    </li>
  ));
  const branch = (p: StaffPerson, depth: number): ReactNode => {
    const direct = tree.children.get(p.id) ?? []; const all = tree.below.get(p.id)?.size ?? 0;
    return (
      <li key={p.id}>
        <div className={css.line} data-busy={saving === p.id ? "" : undefined} style={{ paddingLeft: 14 + depth * 26 }}>
          {depth ? <span className={css.elbow} aria-hidden="true" /> : null}
          <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={28} />
          <span className={css.memberText}><Link href={`/people/${p.id}`}>{p.name}</Link><small>{[p.role, p.pod, userId(p.userNo, orgCode)].filter(Boolean).join(" · ")}</small></span>
          {direct.length ? <span className={css.lineCount} title={`${plural(direct.length, "direct report")}${all > direct.length ? `, ${all} people in all` : ""}`}>{plural(direct.length, "report")}{all > direct.length ? ` · ${all} in all` : ""}</span> : null}
          {canEdit ? managerSelect(p) : null}
        </div>
        {direct.length ? <ul className={css.lines}>{direct.map((child) => branch(child, depth + 1))}</ul> : null}
      </li>
    );
  };
  const leaders = tree.top.filter((p) => tree.children.has(p.id)); const loose = tree.top.filter((p) => !tree.children.has(p.id));
  return <>
    <div className={styles.toolbar}>
      <div className={styles.inline}>
        <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="View">
          <button type="button" className={styles.segment} aria-current={view === "pods" ? "true" : undefined} onClick={() => setView("pods")}><W k="teams" /><span className={styles.muted}>{pods.length}</span></button>
          <button type="button" className={styles.segment} aria-current={view === "lines" ? "true" : undefined} onClick={() => setView("lines")}>Reporting lines<span className={styles.muted}>{managed}</span></button>
        </div>
        <span className={styles.muted}>{view === "pods" ? <>{plural(people.length, "current person", "current people")}{unassigned.length ? ` · ${unassigned.length} without a ${lower(words.team)}` : ""}</> : <>{managed} of {people.length} have a manager</>}</span>
      </div>
      {canEdit && view === "pods" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setNaming("new")}><Plus size={14} aria-hidden="true" />New <W k="team" lc /></button> : null}
    </div>

    <Workspace>
    {view === "pods" ? <>
      {pods.length || unassigned.length ? <div className={css.pods}>
        {pods.map((pod, i) => {
          const empty = !pod.members.length && !pod.projects;
          return (
            <section key={pod.id} className={css.pod} aria-label={pod.name} style={{ animationDelay: `${Math.min(i, 8) * 24}ms` }}>
              <div className={css.podHead}>
                <span className={css.podName}><b>{pod.name}</b><small>{plural(pod.members.length, "person", "people")} · {plural(pod.projects, "project")}</small></span>
                {canEdit ? <>
                  <button type="button" className={styles.iconBtn} aria-label={`Rename ${pod.name}`} title="Rename" onClick={() => setNaming(pod)}><Pencil size={14} aria-hidden="true" /></button>
                  <button type="button" className={styles.iconBtn} aria-label={`Remove ${pod.name}`} title={empty ? `Remove this empty ${lower(words.team)}` : `Move its people and projects to another ${lower(words.team)} before removing it`} disabled={!empty || busy} style={empty ? undefined : { opacity: 0.4, cursor: "not-allowed" }} onClick={() => remove(pod)}><Trash2 size={14} aria-hidden="true" /></button>
                </> : null}
              </div>
              {pod.members.length ? <ul className={styles.list}>{members(pod.members, pod.name)}</ul> : <p className={css.podEmpty}>Nobody is in this <W k="team" lc /> yet. Use “Move to…” on a person in another <W k="team" lc />.</p>}
            </section>
          );
        })}
        {unassigned.length ? (
          <section className={css.pod} data-loose="" aria-label={`No ${lower(words.team)} yet`}>
            <div className={css.podHead}><span className={css.podName}><b>No <W k="team" lc /> yet</b><small>{plural(unassigned.length, "person", "people")} · current staff not placed in a pod</small></span></div>
            <ul className={styles.list}>{members(unassigned, "")}</ul>
          </section>
        ) : null}
      </div> : <section className={styles.panel}><Empty icon={UsersRound} first title={`No ${lower(words.teams)} yet`} text={`Create the first ${lower(words.team)}, then move people into it.`} /></section>}
      <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>A move or a new manager is saved on the person’s record with your name and is kept when the sources sync. A <W k="team" lc /> can be removed only when it has no people and no projects.</p>
    </> : <>
      {!managed ? (
        <section className={`${styles.panel} ${css.start}`}>
          <span className={css.startIcon}><Network size={18} strokeWidth={1.75} aria-hidden="true" /></span>
          <div>
            <h3>Nobody has a manager yet</h3>
            <p>A manager can see their reports’ attendance and leave, and approve their leave requests and attendance corrections. Until managers are set, every request goes to HR and the admins.</p>
            <p>{canEdit ? `To start, choose one manager for a whole ${lower(words.team)} below, or use “Reports to” on any person. You can change either at any time.` : "An organisation admin or HR can set who reports to whom."}</p>
          </div>
        </section>
      ) : null}
      {canEdit && pods.some((p) => p.members.some((m) => !m.managerId)) ? (
        <section className={styles.panel}>
          <div className={styles.panelHead}><h3 className={styles.panelTitle}>Set a manager for a <W k="team" lc /><small>Applies to people in the <W k="team" lc /> who have no manager yet</small></h3></div>
          <ul className={styles.list}>{pods.filter((p) => p.members.length).map((pod) => {
            const open = pod.members.filter((m) => !m.managerId).length;
            return (
              <li key={pod.id} className={css.podLine}>
                <span className={css.memberText}><b>{pod.name}</b><small>{open ? `${open} of ${pod.members.length} without a manager` : `All ${pod.members.length} have a manager`}</small></span>
                {open ? <span className={css.podManager}><Combobox label={`Manager for ${pod.name}`} value={null} disabled={locked} size="sm" placeholder="Choose a manager" searchable searchPlaceholder="Search people"
                  options={people.map((p) => ({ value: p.id, label: p.name, icon: <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={20} />, detail: p.pod ?? undefined }))}
                  onChange={(v) => { if (v && !locked) reportPod(pod, v); }} /></span> : <small className={styles.muted}>All set</small>}
              </li>
            );
          })}</ul>
        </section>
      ) : null}
      <section className={styles.panel}>
        <div className={styles.panelHead}><h3 className={styles.panelTitle}>Reporting lines<small>{managed ? `${plural(leaders.length, "person", "people")} at the top · ${plural(loose.length, "person", "people")} outside any line` : `${plural(people.length, "person", "people")}, none linked yet`}</small></h3></div>
        {people.length ? <ul className={css.lines} data-root="">
          {leaders.map((p) => branch(p, 0))}
          {leaders.length && loose.length ? <li className={css.linesRule}>No manager and no reports</li> : null}
          {loose.map((p) => branch(p, 0))}
        </ul> : <Empty icon={UsersRound} title="No current staff" text="People appear here once they are on a current team list." />}
      </section>
      <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>A person cannot report to themself or to someone below them in their own line. HR and admins can always decide requests, whoever the manager is; nobody decides their own.</p>
    </>}
    </Workspace>
    {naming ? <PodName pod={naming === "new" ? undefined : naming} onClose={() => setNaming(null)} /> : null}
  </>;
}
