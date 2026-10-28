import { Fragment } from "react";

import { read } from "@/app/lib/api";
import { bytes, duration, when } from "@/app/lib/format";
import type { Health } from "@/app/lib/types";
import { Badge, Kpi, Page, PageHeader, Panel, Tiles, Unavailable } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: system health: the release running, the API, the database, and background jobs across organisations.
export default async function HealthPage() {
  const r = await read<Health>("platform/health");
  if (r.error || !r.data) return <Page><PageHeader title="System health" /><Unavailable title="System health" reason={r.error ?? "No answer"} /></Page>;
  const h = r.data;
  return (
    <Page wide>
      <PageHeader title="System health" context={[`Release ${h.api.release.slice(0, 12)}`, h.api.environment ?? ""]} />
      <Tiles>
        <Kpi label="API up for" value={duration(h.api.uptimeSeconds)} note={`Memory ${bytes(h.api.rssBytes)} · Node ${h.api.node}`} />
        <Kpi label="Database" value={bytes(h.database.bytes)} note={`Migration ${h.database.migration ?? "—"} · ${h.database.connections} connections`} />
        <Kpi label="Background jobs" value={h.jobs.aiRuns + h.jobs.groupJobs + h.jobs.mapJobs} tone={h.jobs.stuck ? "warn" : "good"} note={h.jobs.stuck ? `${h.jobs.stuck} waiting over an hour` : "Nothing stuck"} />
        <Kpi label="Password sessions, 24 h" value={h.sessions24h} note={`${h.orgs.active} active organisations`} />
      </Tiles>
      <div className={css.split}>
        <Panel title="Queues" sub="Unfinished work, every organisation">
          <dl className={css.facts}>
            <dt>AI employee runs</dt><dd>{h.jobs.aiRuns}</dd>
            <dt>Group summaries</dt><dd>{h.jobs.groupJobs}</dd>
            <dt>Product map reads</dt><dd>{h.jobs.mapJobs}</dd>
            <dt>Waiting over an hour</dt><dd>{h.jobs.stuck ? <Badge tone="warn">{h.jobs.stuck}</Badge> : <Badge tone="good">None</Badge>}</dd>
            <dt>API started</dt><dd>{when(h.api.startedAt)}</dd>
            <dt>Organisations</dt><dd>{h.orgs.active} active · {h.orgs.suspended} suspended · {h.orgs.setup} being set up</dd>
          </dl>
        </Panel>
        <Panel title="Largest tables">
          <dl className={css.facts}>{h.database.largest.map((t) => <Fragment key={t.table}><dt><code className={css.code}>{t.table}</code></dt><dd>{bytes(t.bytes)}</dd></Fragment>)}</dl>
        </Panel>
      </div>
    </Page>
  );
}
