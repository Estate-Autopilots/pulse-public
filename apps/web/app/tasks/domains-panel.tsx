import { Compass } from "lucide-react";
import { Empty, Panel } from "../ui";
import type { Domain } from "./types";
import { DomainCard, ProposeDomain } from "./work-two";
import css from "./work-two.module.css";

export type DomainsView = { person: { id: string; name: string; pod: string | null; department: string | null }; self: boolean; domains: Domain[];
  can: { propose: boolean; policy: boolean }; options: { categories: { key: string; label: string }[]; pods: string[]; clients: { id: string; name: string }[]; projects: { id: string; name: string; kind: string }[] } | null;
  suggestions: { title: string; categories: string[]; pod: string | null; evidence: string[] }[] };

/** A person's responsibility domains on their profile: what is agreed (with the date) or company policy, what waits for
 *  an answer, suggestions from the work they already do, and what ended. */
export function DomainsPanel({ data }: { data: DomainsView }) {
  const first = data.person.name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
  const live = data.domains.filter((d) => d.status === "active" || d.status === "proposed");
  const past = data.domains.filter((d) => !["active", "proposed"].includes(d.status));
  const propose = data.can.propose && data.options ? <ProposeDomain personId={data.person.id} personName={data.person.name} self={data.self} canPolicy={data.can.policy} options={data.options} /> : undefined;
  return <>
    <Panel title="Responsibility domains" sub={live.length ? `${live.filter((d) => d.status === "active").length} active${live.some((d) => d.status === "proposed") ? ` · ${live.filter((d) => d.status === "proposed").length} waiting` : ""}` : undefined} tools={propose}>
      <p className={css.formNote} style={{ padding: "0 14px 6px" }}>{data.self ? "What you are responsible for. Work inside your domains comes to you directly (and your head never needs to ask); anything else arrives as a request you can accept or decline."
        : `What ${first} is responsible for. Work inside these domains is assigned to ${first} directly; anything else is a request ${first} can accept or decline.`}</p>
      {live.length ? <ul className={css.domains}>{live.map((d) => <DomainCard key={d.id} d={d} self={data.self} />)}</ul>
        : <Empty icon={Compass} compact title="No domains yet" text={data.self ? "Propose one, or wait for your head or HR to propose one. Until then, Who can do what decides who may give you work directly." : `Until ${first} has domains, Who can do what decides who may give ${first} work directly.`} />}
    </Panel>
    {data.suggestions.length && data.options ? <Panel title="Suggested from the work already done" sub="Nothing is created until someone proposes it and the other side agrees">
      <div className={css.suggestions}>{data.suggestions.map((s) => <div key={s.title} className={css.suggestion}><span><b>{s.title}</b><small>{s.evidence.join(" · ")}</small></span>
        <ProposeDomain personId={data.person.id} personName={data.person.name} self={data.self} canPolicy={data.can.policy} options={data.options!} prefill={s} label="Propose this" /></div>)}</div>
    </Panel> : null}
    {past.length ? <Panel title="Ended, declined or withdrawn" sub={`${past.length}`}><ul className={css.domains}>{past.map((d) => <DomainCard key={d.id} d={d} self={data.self} />)}</ul></Panel> : null}
  </>;
}
