"use client";
// Settings → Who can do what (UX-TASKS). One table everybody can read. HR and admins change the three adjustable rules
// per role, inside limits the database enforces: leadership is fixed, a pod head never assigns outside the pod, a member
// never assigns beyond their pod. The rest of the rows say how the fixed rules work.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Lock } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import css from "./work-rules.module.css";

type Cell = { role: "hr" | "pod_head" | "member"; action: Action; scope: string; options: string[]; default: string; updatedAt: string | null; updatedBy: string | null };
type Action = "task.assign" | "task.ask" | "project.create";
export type RulesData = { canEdit: boolean; role: string; roleLabel: string; people: Record<string, number>; cells: Cell[] };

export const ROLES = [{ key: "leadership", label: "Leadership & admins" }, { key: "hr", label: "HR" }, { key: "pod_head", label: "Pod heads" }, { key: "member", label: "Members" }] as const;
export const SCOPE: Record<Action, Record<string, string>> = {
  "task.assign": { anyone: "Anyone", pod: "Their pod", self: "Only themselves" },
  "task.ask": { anyone: "Anyone", pod: "Their pod", none: "Nobody" },
  "project.create": { anyone: "Any project", pod: "In their pod", none: "No" },
};
const ROWS: { key: string; label: string; help: string; action?: Action; fixed?: Record<string, string> }[] = [
  { key: "own", label: "Create tasks for themselves", help: "Everyone, always.", fixed: { leadership: "Yes", hr: "Yes", pod_head: "Yes", member: "Yes" } },
  { key: "assign", label: "Assign tasks to others", help: "For people who have no domains yet. The person is told at once, in Pulse, on the phone and on the desktop. Outside this, Pulse asks them instead.", action: "task.assign" },
  { key: "domain", label: "Assign inside someone’s domains", help: "Domains are agreed between the person and the company, or set by company policy. Inside them work is assigned directly; outside them it is a request to join they accept or decline.",
    fixed: { leadership: "Yes", hr: "Yes", pod_head: "Always, for their people", member: "Where they may ask" } },
  { key: "domains", label: "Agree domains", help: "One side proposes, the other agrees, with a date. Company policy is mandatory and active at once.", fixed: { leadership: "Anyone’s; set policy", hr: "Anyone’s; set policy", pod_head: "Their people’s", member: "Propose their own; agree or decline" } },
  { key: "pool", label: "Put tasks in the pool", help: "A task with nobody yet, for the company, a department or a pod. The first claim wins.", fixed: { leadership: "Any pool", hr: "Any pool", pod_head: "Their pod’s and department’s", member: "No" } },
  { key: "claim", label: "Claim from the pool", help: "The claimant is credited the task’s value when the work is accepted.", fixed: { leadership: "Yes", hr: "Yes", pod_head: "Pools they belong to", member: "Pools they belong to" } },
  { key: "value", label: "Set importance and the estimate", help: "Pip suggests importance and effort; a person confirms. Nobody sets their own. Tasks carry no value points.", fixed: { leadership: "Any task", hr: "Any task", pod_head: "Their people’s and pod’s", member: "Tasks they create for others" } },
  { key: "ask", label: "Ask someone to take a task", help: "A request with Accept and Decline. If accepted it is theirs, and the asker reviews it.", action: "task.ask" },
  { key: "project", label: "Create projects", help: "Internal projects, or setting up the fulfilment of a client package.", action: "project.create" },
  { key: "people", label: "Add people to a project", help: "Inside your reach people are added; anyone else gets an invitation to accept.", fixed: { leadership: "Any project", hr: "Projects they may create", pod_head: "Their pod’s projects", member: "Their own projects; invite to others" } },
  { key: "join", label: "Ask to join a task or project", help: "The owner accepts or declines.", fixed: { leadership: "Yes", hr: "Yes", pod_head: "Yes", member: "Yes" } },
  { key: "accept", label: "Accept finished work", help: "The reviewer rates how good the work was; nothing is credited in points. Nobody accepts their own work.", fixed: { leadership: "When they review", hr: "When they review", pod_head: "Their pod by default", member: "When they review" } },
  { key: "see", label: "See tasks", help: "Plus anything they are asked about, mentioned in, follow, or that blocks their work.", fixed: { leadership: "All", hr: "All", pod_head: "Their pod’s", member: "Their own and their pod’s" } },
  { key: "client", label: "Create and edit client packages", help: "What was sold, its value and dates. The value is visible to leadership only.", fixed: { leadership: "Yes", hr: "No", pod_head: "No", member: "No" } },
  { key: "rules", label: "Change these rules", help: "Within the limits shown in each list.", fixed: { leadership: "Admins", hr: "Yes", pod_head: "No", member: "No" } },
];

export function WorkRules({ data }: { data: RulesData }) {
  const router = useRouter();
  const [cells, setCells] = useState(data.cells), [busy, setBusy] = useState<string | null>(null);
  const cell = (role: string, action: Action) => cells.find((c) => c.role === role && c.action === action);
  async function change(c: Cell, scope: string) {
    const before = cells; setCells(cells.map((x) => x === c ? { ...x, scope } : x)); setBusy(`${c.role}:${c.action}`);
    try { await post("work/rules", { role: c.role, action: c.action, scope }); notify({ id: "rules", tone: "success", title: "Rule saved", message: `${ROLES.find((r) => r.key === c.role)?.label}: ${ROWS.find((r) => r.action === c.action)?.label.toLowerCase()} · ${SCOPE[c.action][scope]}`, timeout: 3000 }); router.refresh(); }
    catch (e) { setCells(before); notify({ id: "rules", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "Try again" }); } finally { setBusy(null); }
  }
  return <section className={css.wrap} aria-labelledby="rules-title">
    <header className={css.head}>
      <div><h2 id="rules-title">Who can do what</h2><p>The same rules the database enforces on every task and project. You are in <b>{data.roleLabel}</b>.
        {data.canEdit ? " Change a list to adjust a role; each list only offers what is safe for that role." : " HR and admins can adjust the three rules with a list."}</p></div>
    </header>
    <div className={css.scroll}>
      <table className={css.table}>
        <thead><tr><th scope="col"><span className={css.srOnly}>What</span></th>{ROLES.map((r) => <th key={r.key} scope="col" data-mine={data.role === r.key ? "" : undefined}>{r.label}{data.people[r.key] !== undefined ? <small>{data.people[r.key]} {data.people[r.key] === 1 ? "person" : "people"}</small> : <small>none yet</small>}</th>)}</tr></thead>
        <tbody>{ROWS.map((row) => <tr key={row.key}>
          <th scope="row"><b>{row.label}</b><small>{row.help}</small></th>
          {ROLES.map((r) => {
            const label = r.label;
            if (row.fixed) return <td key={r.key} data-label={label} data-mine={data.role === r.key ? "" : undefined}><span className={css.fixed}>{row.fixed[r.key]}</span></td>;
            const action = row.action!;
            if (r.key === "leadership") return <td key={r.key} data-label={label} data-mine={data.role === r.key ? "" : undefined}><span className={css.fixed} title="Leadership and admins are never narrowed"><Lock size={11} aria-hidden="true" />{SCOPE[action].anyone}</span></td>;
            const c = cell(r.key, action)!;
            return <td key={r.key} data-label={label} data-mine={data.role === r.key ? "" : undefined}>
              {data.canEdit ? <label className={css.choose}><span className={css.srOnly}>{label}: {row.label}</span>
                <select value={c.scope} disabled={busy === `${c.role}:${c.action}`} onChange={(e) => change(c, e.target.value)}>{c.options.map((o) => <option key={o} value={o}>{SCOPE[action][o]}{o === c.default ? " (default)" : ""}</option>)}</select></label>
                : <span className={css.value}>{SCOPE[action][c.scope]}</span>}
              {c.scope !== c.default ? <small className={css.changed}><Check size={10} aria-hidden="true" />changed{c.updatedBy ? ` by ${c.updatedBy.split(" ")[0]}` : ""}</small> : null}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <p className={css.foot}>Pod heads are people HR made head of a pod, people with a managing role, and anyone with people reporting to them. Leadership and admins are never limited.</p>
  </section>;
}
