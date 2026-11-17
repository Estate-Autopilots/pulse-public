import { Building2 } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { adminConfig } from "@/app/lib/config";
import { ago, compact, day } from "@/app/lib/format";
import { PLAN_LABELS, type OrgRow } from "@/app/lib/types";
import { Empty, Kpi, Page, PageHeader, Panel, QueryTabs, Table, Tiles, Unavailable, kitStyles } from "@/app/ui/kit";
import { LimitMeter, StatusBadge } from "@/app/ui/parts";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: every organisation on Pulse, each a tenant of the platform company (EA and Atlas Crest too).
export default async function Organisations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const filter = q.status ?? "all";
  const config = adminConfig();
  const r = await read<{ orgs: OrgRow[] }>("platform/orgs");
  const all = r.data?.orgs ?? [];
  const shown = all
    .filter((o) => filter === "all" ? true : filter === "suspended" ? o.status === "suspended" : filter === "trial" ? o.status === "active" && (o.activation === "trial" || o.plan === "trial") : filter === "rehearsal" ? o.rehearsal : o.status === filter)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : b.status === "active" ? 1 : 0) || Date.parse(b.lastActive ?? "1970-01-01") - Date.parse(a.lastActive ?? "1970-01-01"));
  const active = all.filter((o) => o.status === "active");
  return (
    <Page wide>
      <PageHeader title="Organisations" context={[`Tenants of ${config.company ?? `the ${config.product} platform`}`, `${all.length} in all`]}
        actions={config.appUrl ? <a className={kitStyles.button} href={`${config.appUrl}/companies`}>Set up a company</a> : null} />
      <Tiles>
        <Kpi label="Active" value={active.length} note={`${all.length} in all`} />
        <Kpi label="Suspended" value={all.filter((o) => o.status === "suspended").length} tone={all.some((o) => o.status === "suspended") ? "warn" : undefined} />
        <Kpi label="People" value={compact(active.reduce((n, o) => n + o.people, 0))} note={`${compact(active.reduce((n, o) => n + o.clients, 0))} client seats`} />
        <Kpi label="AI tokens this month" value={compact(all.reduce((n, o) => n + o.aiTokensThisMonth, 0))} />
      </Tiles>
      <QueryTabs base="/organisations" param="status" current={filter}
        items={[{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "trial", label: "Trial" }, { key: "suspended", label: "Suspended" }, { key: "rehearsal", label: "Rehearsal" }]} />
      <Panel title="Organisation directory" sub={`${shown.length} shown`}>
        {r.error ? <Unavailable title="The organisation directory" reason={r.error} /> : !shown.length ? <Empty icon={Building2} title="No organisations here" /> :
          <Table label="Organisation directory">
            <thead><tr><th>Organisation</th><th>Status</th><th>Plan</th><th data-num="">People</th><th data-num="">Active (7 d)</th><th>Last active</th><th>AI tokens this month</th></tr></thead>
            <tbody>{shown.map((o) => <tr key={o.id}>
              <td><Link className={css.name} href={`/organisations/${o.id}`}>{o.name}</Link><span className={css.sub}>{[o.code, o.handle ? `@${o.handle}` : null, o.host, o.own ? "Hosts the platform admins" : null].filter(Boolean).join(" · ")}</span></td>
              <td><StatusBadge status={o.status} activation={o.activation} rehearsal={o.rehearsal} /></td>
              <td>{PLAN_LABELS[o.plan] ?? o.plan}<span className={css.sub}>{o.planSet ? (o.trialEnds ? `Trial ends ${day(o.trialEnds)}` : "Set") : "Not set"}</span></td>
              <td data-num="">{o.seatLimit ? <LimitMeter used={o.people} limit={o.seatLimit} /> : o.people}</td>
              <td data-num="">{o.active7d}</td>
              <td>{ago(o.lastActive)}</td>
              <td><LimitMeter used={o.aiTokensThisMonth} limit={o.aiTokensMonth} /></td>
            </tr>)}</tbody>
          </Table>}
      </Panel>
    </Page>
  );
}
