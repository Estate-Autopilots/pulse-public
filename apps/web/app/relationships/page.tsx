import Link from "next/link";
import { Info, Network, Search } from "lucide-react";
import { api } from "../lib/api";
import { count, plural } from "../lib/format";
import { Badge, Empty, Kpi, Message, Page, PageHeader, Panel, QueryTabs, Tiles, styles } from "../ui";
import { EdgeActions, ModelDefinition, RefreshSources, ReviewerAdmin } from "./actions";
import { day, ROLE, STATUS, type Edge, type Graph, type Group, type Kind, type Setup } from "./types";
import css from "./relationships.module.css";

type Params = { view?: string; kind?: string; status?: string; q?: string; dev?: string; subject?: string; all?: string };
const KIND_ORDER: Kind[] = ["development", "client", "team", "account_owner", "contact", "model"];
const STATUSES: [string, string][] = [["", "Current"], ["confirmed", "Confirmed"], ["proposed", "Proposed"], ["corrections", "Corrections waiting"], ["unresolved", "Name only"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"]];

/** R46: RE projects and the records around them, as typed relationships with where each came from, its dates, and
 *  whether a named reviewer confirmed it. Imported links stay proposals; reviewers confirm, reject or correct them. */
// MODULES-1024: 248 groups made a 1.75 MB page that took 3 s to render on pulse-dev; the first GROUP_CAP render unless
// "Show all" is asked for (as Projects and Clients do since QA-1024).
const GROUP_CAP = 60;

export default async function Relationships({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const qs = new URLSearchParams();
  for (const k of ["view", "kind", "status", "q", "dev", "subject"] as const) if (p[k]) qs.set(k, p[k]!);
  const r = await api<Graph>(`relationships${qs.toString() ? `?${qs}` : ""}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  const setup = d.me.admin ? (await api<Setup>("relationships/setup")).data ?? null : null;
  const keep = (omit: string[]) => { const s = new URLSearchParams(qs); for (const k of omit) s.delete(k); return s.toString(); };
  const href = (set: Record<string, string>) => { const s = new URLSearchParams(qs); for (const [k, v] of Object.entries(set)) v ? s.set(k, v) : s.delete(k); const t = s.toString(); return t ? `/relationships?${t}` : "/relationships"; };
  const waiting = d.byKind.filter((k) => d.me.kinds.includes(k.kind)).reduce((n, k) => n + k.proposed, 0);
  const dev = d.developments;
  return (
    <Page fit>
      <PageHeader title="Relationships" back={{ href: "/contacts", label: "Contacts" }}
        context={[`${count(d.counts.confirmed)} confirmed`, `${count(d.counts.proposed)} proposed`, `${plural(dev.developments, "RE project")} from ${plural(dev.engagements, "engagement record")}`]}
        actions={<>{p.dev || p.subject || p.q || p.kind || p.status ? <Link className={styles.btn} href={d.view === "review" ? "/relationships?view=review" : "/relationships"}>Clear filters</Link> : null}</>} />
      <Tiles count={4} dense>
        <Kpi label="Confirmed" value={count(d.counts.confirmed)} tone="success" note={d.counts.corrections ? `${count(d.counts.corrections)} with a correction waiting` : "by a named reviewer"} />
        <Kpi label="Proposed" value={count(d.counts.proposed)} note={`${count(d.counts.unresolved)} only a written name`} href="/relationships?status=proposed" />
        <Kpi label="RE projects" value={count(dev.developments)} note={`${count(dev.shared)} sold more than once (${count(dev.inShared)} engagement records)`} href="/relationships?kind=development" />
        <Kpi label={d.me.reviewer ? "Waiting for you" : "Rejected"} value={count(d.me.reviewer ? waiting : d.counts.rejected)} href={d.me.reviewer ? "/relationships?view=review" : "/relationships?status=rejected"}
          note={d.me.reviewer ? "in the kinds you review" : "kept, with who decided"} />
      </Tiles>
      <div className={css.layout} data-grow="">
        <section className={css.main}>
          <div className={styles.toolbar}>
            <QueryTabs base="/relationships" param="view" current={d.view} keep={keep(["view"])}
              items={[{ key: "graph", label: "All relationships" }, { key: "review", label: "To confirm", count: d.me.reviewer ? waiting : d.counts.proposed }]} />
            <form className={styles.search} action="/relationships" role="search">
              {(["view", "kind", "status"] as const).map((k) => p[k] ? <input key={k} type="hidden" name={k} value={p[k]} /> : null)}
              <Search size={14} aria-hidden="true" />
              <input className={styles.input} type="search" name="q" defaultValue={p.q ?? ""} placeholder="Search projects, clients, people…" aria-label="Search relationships" />
            </form>
          </div>
          <div className={css.filters}>
            <div className={styles.segmented} role="group" aria-label="Kind of relationship">
              <Link className={styles.segment} href={href({ kind: "" })} aria-current={!p.kind ? "true" : undefined}>All kinds</Link>
              {KIND_ORDER.map((k) => d.byKind.find((x) => x.kind === k)).filter((x) => !!x).map((k) => (
                <Link key={k!.kind} className={styles.segment} href={href({ kind: k!.kind })} aria-current={p.kind === k!.kind ? "true" : undefined}>
                  {k!.label}<span className={styles.muted}>{count(k!.confirmed + k!.proposed)}</span></Link>))}
            </div>
            <div className={styles.segmented} role="group" aria-label="Status">
              {STATUSES.map(([key, label]) => <Link key={key || "current"} className={styles.segment} href={href({ status: key })} aria-current={(p.status ?? "") === key ? "true" : undefined}>{label}</Link>)}
            </div>
          </div>
          {d.view === "review" && !d.me.reviewer ? <p className={css.note}><Info size={14} aria-hidden="true" /><span>You are not a named reviewer, so you see what waits for someone who is. You can suggest a correction on any relationship; a reviewer decides it.</span></p> : null}
          {d.groups.length ? <div className={css.groups} data-items="">
            {(p.all === "1" ? d.groups : d.groups.slice(0, GROUP_CAP)).map((g) => <GroupCard key={g.key} group={g} />)}
            {d.groups.length > GROUP_CAP && p.all !== "1" ? <p className={css.note}><Info size={14} aria-hidden="true" /><span>Showing {count(GROUP_CAP)} of {count(d.groups.length)} groups. <Link href={href({ all: "1" })}>Show all {count(d.groups.length)}</Link>, or search or choose a kind.</span></p>
              : d.more ? <p className={css.note}><Info size={14} aria-hidden="true" /><span>Showing the first {count(d.shown)}. Search or choose a kind to narrow the list.</span></p> : null}
          </div> : <section className={styles.panel}><Empty icon={Network} first title={d.view === "review" ? "Nothing waits for confirmation" : "No relationships here"}
            text={d.lastRun ? "Nothing matches these filters." : "An admin reads the sources once to propose the first relationships (Set up, on the right)."} /></section>}
        </section>
        <aside className={css.side}>
          <Panel title="How this works" sub="proposals are not facts">
            <ul className={css.how}>
              <li>Pulse proposes relationships from records it already has: the project’s client, engagement records sharing a project key, the PM the project sources name, client contacts. Each shows where it came from.</li>
              <li>Only a reviewer an admin named for that kind confirms, rejects or corrects one. A written name with no record stays unresolved: nobody is matched by name.</li>
              <li>Engagement records sold again for the same RE project sit together; they are not separate developments.</li>
              <li>Every decision is kept and can be undone. When a source changes later, Pulse proposes the change and the confirmed relationship stands until a reviewer decides.</li>
            </ul>
          </Panel>
          <Panel title="Models" sub={d.models.defined ? "defined by the owner" : "waiting for the owner"}>
            <p className={css.small}>{d.models.defined ? "Model links show with the others and can be confirmed." : "The owner has not yet said what “models” means in this graph (owner errand E14), so model links stay hidden and cannot be confirmed."}</p>
            {setup ? <ModelDefinition model={setup.model} hidden={setup.hiddenModels} /> : null}
          </Panel>
          {setup ? <Panel title="Set up" sub="admins">
            <ReviewerAdmin setup={setup} />
            <RefreshSources runs={setup.runs} />
          </Panel> : null}
        </aside>
      </div>
    </Page>
  );
}

function GroupCard({ group: g }: { group: Group }) {
  const head = g.type === "development" ? "RE project" : g.type === "client" ? "Client" : "Engagement record";
  return <article className={`${styles.panel} ${css.group}`}>
    <header className={css.groupHead}>
      <span className={css.groupTitle}><b>{g.label}</b><Badge>{head}</Badge>
        {g.type === "development" && g.engagements.length > 1 ? <Badge tone="accent">{plural(g.engagements.length, "engagement record")}</Badge> : null}</span>
      {g.engagements.length ? <span className={css.engagements}>{g.engagements.map((e) => <Link key={e.id} href={e.href ?? "#"} className={css.engagement} title={[e.sub, e.label].filter(Boolean).join(" ")}>{e.sub ? <small>{e.sub}</small> : null}<span>{e.label}</span></Link>)}</span> : null}
    </header>
    <ul className={css.edges}>{g.edges.map((e) => <EdgeRow key={e.thread} edge={e} multi={g.engagements.length > 1} />)}</ul>
  </article>;
}

function NodeLink({ node }: { node: Edge["object"] }) {
  return node.resolved && node.href ? <Link href={node.href} className={css.node}>{node.label}</Link> : <span className={css.unresolved} title="Only a written name: no record chosen">{node.label}</span>;
}

function EdgeRow({ edge: e, multi }: { edge: Edge; multi: boolean }) {
  const role = e.role ? ROLE[e.role] ?? e.role : null;
  const dates = e.validFrom || e.validTo ? [e.validFrom ? `from ${day(e.validFrom)}` : null, e.validTo ? `to ${day(e.validTo)}` : null].filter(Boolean).join(" ") : null;
  return <li className={css.edge} data-status={e.status}>
    <div className={css.edgeMain}>
      <span className={css.kind}>{e.kindLabel}</span>
      <span className={css.line}>
        {e.subject.type === "engagement" && multi ? <><Link href={e.subject.href ?? "#"} className={css.subject}>{e.subject.sub ?? e.subject.label}</Link><span aria-hidden="true" className={css.arrow}>→</span></> : null}
        <NodeLink node={e.object} />{role && e.kind !== "development" ? <span className={styles.muted}>{role}</span> : null}
      </span>
      <span className={css.badges}>
        <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
        {!e.object.resolved ? <Badge tone="warning">Name only</Badge> : null}
        {e.disputed ? <Badge tone="warning">Reviewers disagreed</Badge> : null}
        {e.sameName ? <span title="Records with the same name are kept apart; nothing is merged by name"><Badge>{plural(e.sameName, "other record")} with this name</Badge></span> : null}
      </span>
    </div>
    <p className={css.meta}>
      <span>{e.source.label}{e.source.evidence.length ? `: ${e.source.evidence.join(" · ")}` : ""}{e.source.confidence !== null && e.object.resolved ? ` · the source is ${Math.round(e.source.confidence * 100)}% sure` : ""}</span>
      {dates ? <span>{dates}</span> : null}
      {e.decided ? <span>{e.decided.action === "reject" ? "Rejected" : e.decided.action === "correct" ? "Corrected" : "Confirmed"} by {e.decided.by ?? "a reviewer"} · {day(e.decided.at)}{e.decided.note ? ` · “${e.decided.note}”` : ""}</span> : null}
    </p>
    {e.pending ? <p className={css.pending}><b>Correction waiting:</b> <NodeLink node={e.pending.object} /> · {e.pending.fromSource ? "the source changed" : `suggested by ${e.pending.by ?? "a colleague"}`} · {day(e.pending.at)}{e.pending.note ? ` · “${e.pending.note}”` : ""}</p> : null}
    <EdgeActions edge={e} />
  </li>;
}
