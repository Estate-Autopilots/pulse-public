"use client";
// FOCUS (owner, 7 Nov 2026): the funding list. Filter chips by state (Can apply / Blocked / In progress / Done), one
// card per programme: amount, deadline, who can apply, documents, what blocks it (with its project), status.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { focusPost } from "../focus/model";
import css from "../focus/focus.module.css";

export type Program = { id: string; name: string; kind: string; amount: string; eligibility: string; docs: string; deadline: string; status: string;
  blockedBy: string | null; projectId: string | null; projectName: string | null; url: string | null; note: string; updatedAt: string };

const STATUS: [string, string][] = [["blocked", "Blocked"], ["ready", "Can apply"], ["drafting", "Writing"], ["applied", "Applied"], ["approved", "Approved"],
  ["active", "Credits in use"], ["rejected", "Turned down"], ["not_fit", "Not a fit"]];
const GROUPS: [string, string, string[]][] = [["all", "All", []], ["ready", "Can apply", ["ready"]], ["blocked", "Blocked", ["blocked"]],
  ["moving", "In progress", ["drafting", "applied", "approved", "active"]], ["closed", "Closed", ["rejected", "not_fit"]]];
const TONE: Record<string, string> = { blocked: "bad", ready: "good", drafting: "warn", applied: "warn", approved: "good", active: "good", rejected: "quiet", not_fit: "quiet" };

export function FundingList({ programs }: { programs: Program[] }) {
  const router = useRouter();
  const [group, setGroup] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const shown = programs.filter((p) => group === "all" || GROUPS.find((g) => g[0] === group)![2].includes(p.status));
  const setStatus = async (p: Program, status: string) => {
    setError(null);
    try { await focusPost(`funding/${p.id}`, { status }); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); }
  };
  return <div className={css.board}>
    <div className={css.tabs} role="tablist" aria-label="Show">
      {GROUPS.map(([key, label, statuses]) => <button key={key} type="button" role="tab" aria-selected={group === key} className={css.tab} onClick={() => setGroup(key)}>
        {label} <small>{key === "all" ? programs.length : programs.filter((p) => statuses.includes(p.status)).length}</small></button>)}
    </div>
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    {shown.length ? <ul className={css.cards}>{shown.map((p) => <li key={p.id} className={css.card} data-tone={TONE[p.status]}>
      <div className={css.cardHead}>
        <h2>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</h2>
        <select aria-label={`Status of ${p.name}`} value={p.status} onChange={(e) => void setStatus(p, e.target.value)}>
          {STATUS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <p className={css.amount}>{p.amount || "Amount not known"}<span>{p.deadline}</span></p>
      {p.blockedBy && p.status === "blocked" ? <p className={css.blocker}>Blocked by: {p.blockedBy}
        {p.projectId ? <> · <Link href={`/projects/${p.projectId}`}>{p.projectName ?? "project"}</Link></> : null}</p> : null}
      <dl className={css.facts}>
        {p.eligibility ? <><dt>Who can apply</dt><dd>{p.eligibility}</dd></> : null}
        {p.docs ? <><dt>Papers needed</dt><dd>{p.docs}</dd></> : null}
      </dl>
    </li>)}</ul> : <p className={css.quiet}>Nothing here.</p>}
  </div>;
}
