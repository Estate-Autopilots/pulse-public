import { Rocket } from "lucide-react";

import { read } from "@/app/lib/api";
import { adminConfig } from "@/app/lib/config";
import { ago, when } from "@/app/lib/format";
import type { Health, Release } from "@/app/lib/types";
import { Badge, Empty, Kpi, Page, PageHeader, Panel, Table, Tiles, Unavailable , kitStyles } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: releases and status (the Sales X-Ray admin's Releases & status), from Pulse's train: every environment's
// API records the release it runs when it starts (PULSE_RELEASE), so this is what really ran, and when.
export default async function Releases() {
  const config = adminConfig();
  const [r, health] = await Promise.all([read<{ releases: Release[]; running: { env: string; sha: string } | null }>("platform/releases"), read<Health>("platform/health")]);
  const rows = r.data?.releases ?? [];
  const latest = (env: string) => rows.find((x) => x.env === env);
  const envs = [...new Set(rows.map((x) => x.env))];
  return (
    <Page wide>
      <PageHeader title="Releases & status" context={["dev/live → pulse-ci → production, automatically", "What each environment ran"]}
        actions={config.appUrl ? <a className={kitStyles.button} href={`${config.appUrl}/whats-new`}>What’s new in {config.product}</a> : null} />
      <Tiles>
        <Kpi label="This API runs" value={r.data?.running ? r.data.running.sha.slice(0, 12) : (health.data?.api.release ?? "—").slice(0, 12)} note={r.data?.running?.env ?? health.data?.api.environment ?? undefined} />
        {envs.slice(0, 3).map((env) => { const x = latest(env)!; return <Kpi key={env} label={env === "production" ? "Production" : env} value={x.sha.slice(0, 12)} note={`since ${ago(x.firstSeen)}`} />; })}
      </Tiles>
      <Panel title="Release history" sub="Newest first">
        {r.error ? <Unavailable title="Releases" reason={r.error} /> : !rows.length ? <Empty icon={Rocket} title="No release recorded yet" text="Each API records its release when it starts; the next deploy fills this." /> :
          <Table label="Release history">
            <thead><tr><th>Environment</th><th>Release</th><th>First started</th><th>Last started</th><th data-num="">Starts</th></tr></thead>
            <tbody>{rows.map((x) => <tr key={`${x.env}:${x.sha}`}>
              <td>{x.env === "production" ? <Badge tone="accent">Production</Badge> : <Badge>{x.env}</Badge>}{latest(x.env)?.sha === x.sha ? <span className={css.sub}>Running now</span> : null}</td>
              <td><code className={css.code}>{x.sha.slice(0, 12)}</code></td>
              <td>{when(x.firstSeen)}</td><td>{when(x.lastSeen)}</td><td data-num="">{x.starts}</td>
            </tr>)}</tbody>
          </Table>}
      </Panel>
    </Page>
  );
}
