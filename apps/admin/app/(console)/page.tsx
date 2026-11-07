import Link from "next/link";

import { read } from "@/app/lib/api";
import { adminConfig } from "@/app/lib/config";
import { ago, bytes, compact } from "@/app/lib/format";
import type { AuditRow, Bug, Health, OrgRow } from "@/app/lib/types";
import { Badge, Kpi, Page, PageHeader, Panel, Table, Tiles, Unavailable } from "@/app/ui/kit";
import { AuditTable, StatusBadge } from "@/app/ui/parts";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: the admin home, after the Sales X-Ray console's: what needs a look across the whole platform.
export default async function Home() {
  const config = adminConfig();
  const [orgs, bugs, health, audit] = await Promise.all([
    read<{ orgs: OrgRow[] }>("platform/orgs"),
    read<{ bugs: Bug[]; counts: Record<string, number> }>("platform/bugs?status=new"),
    read<Health>("platform/health"),
    read<{ entries: AuditRow[] }>("platform/audit"),
  ]);
  const all = orgs.data?.orgs ?? [];
  const active = all.filter((o) => o.status === "active");
  const recent = [...all].sort((a, b) => Date.parse(b.lastActive ?? "1970-01-01") - Date.parse(a.lastActive ?? "1970-01-01")).slice(0, 8);
  return (
    <Page>
      <PageHeader title="Home" context={[`${config.product} platform`, config.company ?? "", config.environment === "development" ? "Development" : ""]} />
      <Tiles>
        <Kpi label="Active organisations" value={active.length} note={`${all.length} in all`} href="/organisations" />
        <Kpi label="People on teams" value={compact(active.reduce((n, o) => n + o.people, 0))} note={`${compact(all.reduce((n, o) => n + o.active7d, 0))} signed in this week`} href="/people" />
        <Kpi label="New bug reports" value={bugs.data?.counts?.new ?? 0} tone={(bugs.data?.counts?.new ?? 0) > 0 ? "warn" : "good"} href="/bugs" note={`${bugs.data?.counts?.triaged ?? 0} triaged · ${bugs.data?.counts?.fixing ?? 0} being fixed`} />
        <Kpi label="AI tokens this month" value={compact(all.reduce((n, o) => n + o.aiTokensThisMonth, 0))} href="/ai-spend" />
      </Tiles>
      <div className={css.split}>
        <Panel title="Organisations, most recently active" action={{ href: "/organisations", label: "All organisations" }}>
          {orgs.error ? <Unavailable title="Organisations" reason={orgs.error} /> :
            <Table label="Recently active organisations">
              <thead><tr><th>Organisation</th><th>Status</th><th data-num="">People</th><th>Last active</th></tr></thead>
              <tbody>{recent.map((o) => <tr key={o.id}>
                <td><Link className={css.name} href={`/organisations/${o.id}`}>{o.name}</Link><span className={css.sub}>{o.code}{o.own ? " · hosts the platform admins" : ""}</span></td>
                <td><StatusBadge status={o.status} activation={o.activation} rehearsal={o.rehearsal} /></td>
                <td data-num="">{o.people}</td><td>{ago(o.lastActive)}</td>
              </tr>)}</tbody>
            </Table>}
        </Panel>
        <div className={css.stack}>
          <Panel title="System" action={{ href: "/health", label: "System health" }}>
            {health.error || !health.data ? <Unavailable title="System health" reason={health.error ?? "No answer"} /> :
              <dl className={css.facts}>
                <dt>Release</dt><dd><code className={css.code}>{health.data.api.release.slice(0, 12)}</code> · {health.data.api.environment ?? "—"}</dd>
                <dt>Database</dt><dd>{bytes(health.data.database.bytes)} · migration {health.data.database.migration ?? "—"}</dd>
                <dt>Background jobs</dt><dd>{health.data.jobs.stuck ? <Badge tone="warn">{health.data.jobs.stuck} waiting over an hour</Badge> : <Badge tone="good">Nothing stuck</Badge>}</dd>
              </dl>}
          </Panel>
          <Panel title="Newest bug reports" action={{ href: "/bugs", label: "Bugs" }}>
            {bugs.error ? <Unavailable title="Bug reports" reason={bugs.error} /> : !bugs.data?.bugs.length ? <p className={css.note}>No new reports.</p> :
              <ul className={css.list}>{bugs.data.bugs.slice(0, 5).map((b) => <li key={b.id} className={css.item}><div><b>{b.words?.slice(0, 120) || "No words"}</b><small>{b.org} · #{b.number} · {ago(b.createdAt)}{b.blocksWork ? " · blocks work" : ""}</small></div></li>)}</ul>}
          </Panel>
        </div>
      </div>
      <Panel title="Latest in the platform audit log" action={{ href: "/audit", label: "Audit log" }}>
        {audit.error ? <Unavailable title="The audit log" reason={audit.error} /> : <AuditTable rows={(audit.data?.entries ?? []).slice(0, 8)} />}
      </Panel>
    </Page>
  );
}
