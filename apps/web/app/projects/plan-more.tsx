import Link from "next/link";
import { CircleCheck, Handshake, Hourglass, MessageCircle, Users } from "lucide-react";
import { ChatLinkButton, ConditionSwitch, PromiseAnswer, PromiseEdit, RolePick } from "./plan-more-client";
import css from "./plan-clocks.module.css";

/** PM-BUILD-2 (18 Nov 2026; KAZUK-PM-2 phase 2, migration 2310), as KAZUK-PM-2's concept 1 ("One project"):
 *  - "What we promised" first, always on view (Kazuk's rule 5): the sales-set numbers large, the worked-out ones small
 *    (never typed), and who confirmed them. A change by anyone but sales waits for sales to confirm.
 *  - "Set up this project": who does each role the plan needs (a person, or nobody here: then those steps are left
 *    out), the project's chat groups (so their updates can reach the plan), and the plan's conditions. Folds to one line
 *    once nothing is left to set. Every word comes from the template. */
export type PromiseField = { key: string; label: string; kind: string; unit: string | null; hint: string | null; value: string | number | null };
export type PromiseOut = { key: string; label: string; unit: string | null; value: number | null; compare: { key: string; label: string; value: number | null } | null };
export type PromiseView = { title: string; note: string | null; inputs: PromiseField[]; outputs: PromiseOut[]; set: boolean; confirmedAt: string | null; confirmedBy: string | null;
  pending: { values: Record<string, string | number>; at: string; note: string | null; by: string | null; mine: boolean; changed: string[]; outputs: PromiseOut[]; waitsFor: string[]; more: number } | null;
  canChange: boolean; bySales: boolean; canConfirm: boolean; confirmers?: string[]; confirmersMore?: number };
export type RoleRow = { role: string; open: number; nobody: number; left: number; lead: boolean; outside: boolean; holder: string | null; holderName: string | null; none: boolean; named?: boolean };
export type Condition = { key: string; label: string; hint: string | null; question?: string | null; on: boolean; steps: string[] };
export type Chat = { id: string; name: string; kind: string; linkedTo?: string | null; lastAt?: string | null };

const short = (d: string | null) => d ? new Date(d.length > 10 ? d : `${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "";
const num = (v: number | string | null | undefined) => v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : String(v);
const withUnit = (f: { unit: string | null }, v: number | string | null) => v === null || v === "" ? "—" : f.unit === "%" ? `${num(v)}%` : f.unit ? `${num(v)} ${f.unit}` : num(v);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function PromisePanel({ projectId, promise }: { projectId: string; promise: PromiseView | null }) {
  if (!promise) return null;
  const nums = promise.inputs.filter((f) => f.kind !== "text"), goal = promise.inputs.find((f) => f.kind === "text");
  const p = promise.pending;
  return <section className={css.promise} aria-label={promise.title} data-empty={promise.set ? undefined : ""}>
    <div className={css.promiseHead}><h3><Handshake size={16} aria-hidden="true" />{promise.title}</h3>
      {p ? <span className={css.promiseMark} data-tone="wait">Change waiting for sales</span>
        : promise.confirmedAt ? <span className={css.promiseMark} data-tone="good"><CircleCheck size={13} aria-hidden="true" />Confirmed by {promise.confirmedBy ?? "sales"} · {short(promise.confirmedAt)}</span> : null}
      {promise.canChange ? <span className={css.promiseAct}><PromiseEdit projectId={projectId} fields={promise.inputs} bySales={promise.bySales} first={!promise.set}
        waiting={p ? `${p.mine ? "You" : p.by ?? "Someone"} proposed ${p.changed.map((k) => { const f = promise.inputs.find((x) => x.key === k)!; return `${lower(f.label)} ${withUnit(f, f.value)} → ${withUnit(f, p.values[k] ?? null)}`; }).join(", ") || "no change"}` : null}
        confirmers={promise.confirmers?.length ? `${promise.confirmers[0]}${promise.confirmers.length + (promise.confirmersMore ?? 0) > 1 ? " or another salesperson" : ""} (sales)` : null} /></span> : null}
    </div>
    {promise.set ? <>
      <dl className={css.promiseBig}>{nums.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{withUnit(f, f.value)}</dd></div>)}</dl>
      {goal?.value ? <p className={css.promiseGoal}><span>{goal.label}:</span> “{goal.value}”</p> : null}
      {promise.outputs.length ? <p className={css.promiseWorked} aria-label="Worked out from these"><span className={css.workedLabel}>Worked out from these</span>{promise.outputs.map((o) => {
        const over = o.compare && o.value !== null && o.compare.value !== null && o.value > o.compare.value;
        return <span key={o.key} data-tone={over ? "bad" : undefined} title={o.compare ? `${o.compare.label}: ${num(o.compare.value)}` : undefined}><b>{num(o.value)}</b> {lower(o.label)}{over ? ` (more than the ${num(o.compare!.value)} promised)` : ""}</span>; })}</p> : null}
    </> : <p className={css.promiseEmpty}>Sales fills these in from the deal. Until then the plan has no numbers to work to.</p>}
    {p ? <div className={css.promisePending}>
      <p><b>{p.mine ? "You" : p.by ?? "Someone"}</b> proposed {p.changed.length ? p.changed.map((k) => { const f = promise.inputs.find((x) => x.key === k)!;
        return `${lower(f.label)} ${withUnit(f, f.value)} → ${withUnit(f, p.values[k] ?? null)}`; }).join(", ") : "no change"}{p.note ? ` · “${p.note}”` : ""}</p>
      {promise.canConfirm ? <PromiseAnswer projectId={projectId} /> : <p className={css.promiseWho}><Hourglass size={13} aria-hidden="true" />Waiting for {p.waitsFor.length ? `${p.waitsFor.join(", ")}${p.more ? ` and ${p.more} more` : ""}` : "sales"} to confirm</p>}
    </div> : null}
  </section>;
}

export function SetupCard({ projectId, canRun, who, conditions, chats, people, leadName }: { projectId: string; canRun: boolean; who: RoleRow[]; conditions: Condition[];
  chats: { linked: Chat[]; suggested: Chat[]; canLink: boolean } | null; people: { id: string; name: string }[]; leadName: string | null }) {
  if (!canRun) return null;
  const roles = who.filter((r) => !r.lead && (r.open || r.none || r.holder || r.left));
  const open = roles.filter((r) => r.nobody > 0 && !r.none).length + (chats && !chats.linked.length ? 1 : 0);
  const summary = [roles.length ? `${roles.length - roles.filter((r) => r.nobody > 0 && !r.none).length} of ${roles.length} roles set` : null,
    chats ? `${chats.linked.length} ${chats.linked.length === 1 ? "chat" : "chats"} linked` : null].filter(Boolean).join(" · ");
  return <details className={css.setup} open={open > 0} aria-label="Set up this project">
    <summary className={css.setupHead}><Users size={16} aria-hidden="true" /><b>{open ? "Set up this project" : "Team and chats"}</b>
      <span className={css.setupCount} data-tone={open ? "now" : "good"}>{open ? `${open} ${open === 1 ? "thing" : "things"} to set` : <><CircleCheck size={13} aria-hidden="true" />All set</>}</span>
      {open ? null : <small>{summary}</small>}</summary>
    <div className={css.setupBody}>
      {roles.length ? <div className={css.setupPart}>
        <p className={css.setupLabel}>Who does what{leadName ? <span> · {leadName.split(" ")[0]} (lead) does the rest</span> : null}</p>
        <ul className={css.roleRows}>{roles.map((r) => <li key={r.role} className={css.roleRow} data-state={r.none ? "none" : r.nobody > 0 ? "open" : "set"}>
          <span className={css.roleName}><b>{r.role}</b><small>{r.none ? `${r.left} ${r.left === 1 ? "step" : "steps"} left out` : r.nobody > 0 ? `${r.nobody} ${r.nobody === 1 ? "step has" : "steps have"} nobody` : `${r.open} ${r.open === 1 ? "step" : "steps"}`}</small></span>
          <RolePick projectId={projectId} role={r.role} value={r.none ? "none" : r.holder ?? ""} people={r.holder && !people.some((x) => x.id === r.holder) ? [...people, { id: r.holder, name: r.holderName ?? "Someone" }] : people} outside={r.outside} />
        </li>)}</ul>
      </div> : null}
      {chats ? <div className={css.setupPart}>
        <p className={css.setupLabel}>Chats for this project<span> · messages here can update the plan</span></p>
        {chats.linked.length ? <ul className={css.chatRows}>{chats.linked.map((c) => <li key={c.id}><span className={css.chatChip}>
          <Link href={`/chats?channel=${c.id}`}><MessageCircle size={13} aria-hidden="true" />{c.name}</Link>
          {chats.canLink ? <ChatLinkButton projectId={projectId} channelId={c.id} name={c.name} on={false} /> : null}</span></li>)}</ul>
          : <p className={css.setupHint}>No group is linked yet.{chats.suggested.length ? " These look like this client's:" : " Link the client's group from Chats, or ask an admin."}</p>}
        {chats.suggested.length && chats.canLink ? <ul className={css.chatRows}>{chats.suggested.slice(0, 4).map((c) => <li key={c.id} data-suggested="">
          <span className={css.chatName}><MessageCircle size={13} aria-hidden="true" /><span>{c.name}</span>{c.linkedTo ? <small>now on {c.linkedTo}</small> : null}</span>
          <ChatLinkButton projectId={projectId} channelId={c.id} name={c.name} on /></li>)}</ul> : null}
      </div> : null}
      {conditions.length ? <div className={css.setupPart}>
        <ul className={css.condRows}>{conditions.map((c) => { const n = c.steps.length, steps = `${n} ${n === 1 ? "step" : "steps"}`;
          return <li key={c.key}><ConditionSwitch projectId={projectId} k={c.key} label={c.question ?? `${c.label}?`} on={c.on}
            sub={c.on ? `Yes: ${steps} added to the plan` : `Turn on for yes: it adds ${steps}${c.hint ? ` (${c.hint})` : ""}`} /></li>; })}</ul>
      </div> : null}
    </div>
  </details>;
}
