"use client";
// EST-1474: a creative sprint, edited in place. Saves go through lib/creative-saves.mjs (EST-1792): one at a time, in
// order, each with the time the edit was made, and an item's save carries the newest value of each of its fields, so a
// quick second edit never undoes the first. A refused save says "Not saved", with Retry, until a later save of it succeeds.
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonSelect, Segmented } from "../../../kit";
import { sprintSaves, type ItemFields, type SaveState } from "../../../lib/creative-saves.mjs";
import { post } from "../../../records";
import { Badge, Page, PageHeader, Panel, styles } from "../../../ui";
import css from "../../creative.module.css";
import { dayName, type Person, type SprintView } from "../../types";
import { DateField } from "../../../kit/date-field";

const STATE = { done: ["success", "Done"], overdue: ["danger", "Overdue"], today: ["warning", "Due today"], upcoming: ["neutral", "Upcoming"] } as const;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function SprintEditor({ initial, packages, people }: { initial: SprintView; packages: { key: string; label: string }[]; people: Person[] }) {
  const [view, setView] = useState(initial), [status, setStatus] = useState<SaveState>({ saving: false, failed: 0, drafts: {}, intake: {} });
  const [saves] = useState(() => sprintSaves<SprintView>({ base: `creative/sprints/${initial.sprint.id}`, post: (path, body) => post<SprintView>(path, body),
    show: (r) => setView((v) => ({ ...r, canReassign: v.canReassign })), change: setStatus,
    saved: (title) => notify({ id: "creative", tone: "success", title, timeout: 2000 }),
    failed: (message) => notify({ id: "creative", tone: "error", title: "Not saved", message }) }));
  /** What the page shows for an item: the server's fields, or the edits still on their way. */
  const shown = (kind: "input" | "milestone", key: string, saved: ItemFields, owner: string | null) => {
    const d = status.drafts[`${kind}:${key}`] ?? saved;
    return { ...d, owner: d.ownerPersonId === saved.ownerPersonId ? owner : people.find((p) => p.id === d.ownerPersonId)?.name ?? null };
  };
  const s = { ...view.sprint, ...status.intake }, c = view.clock, today = c.today;
  const why = c.missingInputs ? `${plural(c.missingInputs, "input")} missing` : `${c.lateInputs} late`;
  return (
    <Page>
      <PageHeader title={s.project} back={{ href: "/creative", label: "Creative Strategy" }}
        context={[packages.find((p) => p.key === s.package)?.label ?? s.package, c.day >= 1 ? `Day ${c.day}` : `Starts ${dayName(s.dayOne)}`,
          status.saving ? "Saving…" : status.failed ? "Not saved" : "Saved"]}
        actions={status.failed && !status.saving ? <button type="button" className={styles.btn} onClick={() => void saves.retry()}><RotateCcw size={14} aria-hidden="true" />Not saved · Retry</button> : undefined} />
      <div className={css.sprintGrid}>
        <Panel title="Intake" sub="Package, Day 1 and the people">
          <div className={css.form}>
            <Segmented label="Package" size="sm" value={s.package} onChange={(pkg) => void saves.sprint("package", pkg, "Package changed")} options={packages.map((p) => ({ value: p.key, label: p.label }))} />
            <label className={styles.field}><span>Day 1 (research meet)</span><DateField className={styles.input} defaultValue={s.dayOne} key={s.dayOne}
              onChange={(e) => { if (e.target.value && e.target.value !== s.dayOne) void saves.sprint("dayOne", e.target.value, "Day 1 moved"); }} /></label>
            <label className={styles.field}><span>Client approver</span><input className={styles.input} defaultValue={s.approver ?? ""} key={s.approver ?? ""} maxLength={120} placeholder="One named person" required
              onBlur={(e) => { const name = e.target.value.trim();
                if (!name) { if (s.approver) { e.target.value = s.approver; notify({ id: "creative", tone: "error", title: "Not saved", message: "Name the client approver" }); } return; }
                if (name !== (s.approver ?? "")) void saves.sprint("approver", name); }} /></label>
            {view.canReassign ? <>
              <div className={styles.kitField}><span>Growth strategist</span><PersonSelect label="Growth strategist" people={people} value={s.gsPersonId}
                onChange={(p) => { if (p) void saves.sprint("gsPersonId", p.id, "Growth strategist changed"); }} /></div>
              <div className={styles.kitField}><span>Creative strategist</span><PersonSelect label="Creative strategist" people={people} value={s.csPersonId}
                onChange={(p) => { if (p) void saves.sprint("csPersonId", p.id, "Creative strategist changed"); }} /></div>
            </> : <p className={css.people}>GS {s.gs ?? "not chosen"} · CS {s.cs ?? "not chosen"}</p>}
          </div>
        </Panel>
        <Panel title="Critical inputs" sub={c.missingInputs ? `${c.missingInputs} missing · due before Day 1` : "All received"}>
          <ul className={css.rows} id="inputs">{view.inputs.map((i) => { const saved = { ownerPersonId: i.ownerPersonId, doneOn: i.receivedOn, note: i.note }, d = shown("input", i.key, saved, i.owner);
            const late = d.doneOn ? Math.max(0, Math.round((Date.parse(d.doneOn) - Date.parse(s.dayOne)) / 864e5)) : null;
            return <li key={i.key} id={i.key} className={css.item}>
              <span className={css.main}><b>{i.label}</b><small>{d.doneOn ? `Received ${dayName(d.doneOn)}` : `Due before Day 1 · ${dayName(s.dayOne)}`}</small></span>
              <PersonSelect label={`${i.label}: owner`} size="sm" variant="ghost" people={people} value={d.ownerPersonId} onChange={(p) => void saves.item("input", i.key, saved, { ownerPersonId: p?.id ?? null })} />
              <DateField className={`${styles.input} ${css.date}`} aria-label={`${i.label}: received on`} defaultValue={d.doneOn ?? ""} key={d.doneOn ?? "none"} max={today}
                onChange={(e) => { const v = e.target.value || null; if (v !== d.doneOn) void saves.item("input", i.key, saved, { doneOn: v }); }} />
              {d.doneOn ? late ? <Badge tone="warning">{`${plural(late, "day")} late`}</Badge> : <Badge tone="success">Received</Badge> : <Badge tone={c.day >= 1 ? "danger" : "neutral"}>Missing</Badge>}
            </li>; })}</ul>
        </Panel>
        <Panel title="Sprint clock" sub={`Day 1 ${dayName(s.dayOne)}${c.shift ? ` · clock moved ${plural(c.shift, "day")}: ${why}` : ""} · client approvals get ${view.approvalWorkingDays} working days`} className={css.wide}>
          <ul className={css.rows}>{view.milestones.map((m) => { const [tone, label] = STATE[m.state], saved = { ownerPersonId: m.ownerPersonId, doneOn: m.doneOn, note: m.note }, d = shown("milestone", m.key, saved, m.owner);
            return <li key={m.key} id={m.key} className={css.item} data-state={m.state}>
              <label className={css.done}><input type="checkbox" checked={!!d.doneOn} aria-label={`${m.label}: done`}
                onChange={(e) => void saves.item("milestone", m.key, saved, { doneOn: e.target.checked ? today : null }, e.target.checked ? `${m.label} done` : undefined)} /></label>
              <span className={css.main}><b>{m.label}</b><small>{m.where} · Day {m.day}{m.day !== m.dueDay ? ` (planned Day ${m.dueDay})` : ""} · {d.doneOn ? `done ${dayName(d.doneOn)}` : dayName(m.due)}</small></span>
              <PersonSelect label={`${m.label}: owner`} size="sm" variant="ghost" people={people} value={d.ownerPersonId} onChange={(p) => void saves.item("milestone", m.key, saved, { ownerPersonId: p?.id ?? null })} />
              <Badge tone={tone}>{label}</Badge>
            </li>; })}</ul>
        </Panel>
      </div>
    </Page>
  );
}
