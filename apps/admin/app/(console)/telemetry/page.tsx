import { Gauge } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { adminConfig } from "@/app/lib/config";
import { compact } from "@/app/lib/format";
import type { Telemetry } from "@/app/lib/types";
import { Empty, Kpi, Page, PageHeader, Panel, QueryTabs, Table, Tiles, Unavailable , kitStyles } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: product telemetry across organisations (0983's daily rollup): where Pulse is slow or failing.
export default async function TelemetryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const raw = (await searchParams).days ?? "7";
  const days = ["1", "7", "30"].includes(raw) ? raw : "7";
  const config = adminConfig();
  const r = await read<Telemetry>(`platform/telemetry?days=${days}`);
  const t = r.data;
  const orgs = [...(t?.orgs ?? [])].sort((a, b) => b.events - a.events);
  const events = orgs.reduce((n, o) => n + Number(o.events), 0), errors = orgs.reduce((n, o) => n + Number(o.errors), 0);
  return (
    <Page wide>
      <PageHeader title="Product telemetry" context={["Pages, clicks, API calls and errors", `Last ${days === "1" ? "day" : `${days} days`}`]}
        actions={config.appUrl ? <a className={kitStyles.button} href={`${config.appUrl}/telemetry`}>One organisation in detail</a> : null} />
      <QueryTabs base="/telemetry" param="days" current={days} items={[{ key: "1", label: "Today" }, { key: "7", label: "7 days" }, { key: "30", label: "30 days" }]} />
      {r.error || !t ? <Unavailable title="Telemetry" reason={r.error ?? "No answer"} /> : <>
        <Tiles>
          <Kpi label="Events" value={compact(events)} />
          <Kpi label="Errors" value={compact(errors)} tone={errors ? "warn" : "good"} note={events ? `${((errors / events) * 100).toFixed(2)}% of events` : undefined} />
          <Kpi label="Organisations sending" value={orgs.length} />
          <Kpi label="Sessions" value={compact(orgs.reduce((n, o) => n + Number(o.sessions), 0))} />
        </Tiles>
        <Panel title="By organisation">
          {!orgs.length ? <Empty icon={Gauge} title="Nothing measured in this period" /> :
            <Table label="Telemetry by organisation">
              <thead><tr><th>Organisation</th><th data-num="">Events</th><th data-num="">Errors</th><th data-num="">People</th><th data-num="">Sessions</th><th data-num="">Page p75</th><th>Platforms</th></tr></thead>
              <tbody>{orgs.map((o) => <tr key={o.id}>
                <td><Link className={css.name} href={`/organisations/${o.id}`}>{o.name}</Link></td>
                <td data-num="">{compact(o.events)}</td><td data-num="">{compact(o.errors)}</td><td data-num="">{o.people}</td><td data-num="">{compact(o.sessions)}</td>
                <td data-num="">{o.pageP75 ? `${compact(o.pageP75)} ms` : "—"}</td>
                <td>{o.platforms.filter((p) => p !== "*").join(", ") || "—"}</td>
              </tr>)}</tbody>
            </Table>}
        </Panel>
        <div className={css.split}>
          <Panel title="Slowest places" sub="p75, per organisation">
            {!t.slowest.length ? <p className={css.note}>No timings in this period.</p> :
              <Table label="Slowest places">
                <thead><tr><th>Place</th><th>Organisation</th><th data-num="">p75</th><th data-num="">Events</th></tr></thead>
                <tbody>{t.slowest.map((x, i) => <tr key={i}><td><code className={css.code}>{x.name}</code><span className={css.sub}>{x.kind}</span></td><td>{x.org}</td><td data-num="">{x.p75 ? `${compact(x.p75)} ms` : "—"}</td><td data-num="">{compact(x.events)}</td></tr>)}</tbody>
              </Table>}
          </Panel>
          <Panel title="Most errors">
            {!t.failing.length ? <p className={css.note}>No errors in this period.</p> :
              <Table label="Places with the most errors">
                <thead><tr><th>Place</th><th>Organisation</th><th data-num="">Errors</th></tr></thead>
                <tbody>{t.failing.map((x, i) => <tr key={i}><td><code className={css.code}>{x.name}</code><span className={css.sub}>{x.kind}</span></td><td>{x.org}</td><td data-num="">{compact(x.errors)}</td></tr>)}</tbody>
              </Table>}
          </Panel>
        </div>
      </>}
    </Page>
  );
}
