import Link from "next/link";

import { read } from "@/app/lib/api";
import { compact } from "@/app/lib/format";
import { PLAN_LABELS, type UsageRow } from "@/app/lib/types";
import { Kpi, Page, PageHeader, Panel, QueryTabs, Table, Tiles, Unavailable } from "@/app/ui/kit";
import { LimitMeter } from "@/app/ui/parts";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: usage by organisation, read against each plan's limits.
export default async function Usage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const raw = (await searchParams).days ?? "30";
  const days = ["7", "30", "90"].includes(raw) ? raw : "30";
  const r = await read<{ days: number; orgs: UsageRow[] }>(`platform/usage?days=${days}`);
  const rows = [...(r.data?.orgs ?? [])].sort((a, b) => b.aiTokens - a.aiTokens || b.activePeople - a.activePeople);
  const total = (k: keyof UsageRow) => rows.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  return (
    <Page wide>
      <PageHeader title="Usage" context={["Every organisation", `Last ${days} days`]} />
      <QueryTabs base="/usage" param="days" current={days} items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }]} />
      <Tiles>
        <Kpi label={`AI tokens, ${days} days`} value={compact(total("aiTokens"))} note={`${compact(total("aiRuns"))} AI employee runs`} href="/ai-spend" />
        <Kpi label="AI tokens this month" value={compact(total("aiTokensThisMonth"))} />
        <Kpi label="Signed-in people" value={compact(total("activePeople"))} note={`of ${compact(total("people"))} on teams`} />
        <Kpi label="Tasks and messages" value={compact(total("tasksCreated") + total("messages"))} note={`${compact(total("tasksCreated"))} tasks · ${compact(total("messages"))} messages`} />
      </Tiles>
      <Panel title="Usage by organisation" sub="AI tokens: AI employees, group summaries and product map reads">
        {r.error ? <Unavailable title="Usage" reason={r.error} /> :
          <Table label="Usage by organisation">
            <thead><tr><th>Organisation</th><th data-num="">People</th><th data-num="">Signed in</th><th data-num="">AI tokens</th><th>This month vs limit</th><th data-num="">AI runs</th><th data-num="">Tasks</th><th data-num="">Messages</th></tr></thead>
            <tbody>{rows.map((o) => <tr key={o.id}>
              <td><Link className={css.name} href={`/organisations/${o.id}`}>{o.name}</Link><span className={css.sub}>{PLAN_LABELS[o.plan ?? ""] ?? "Plan not set"}{o.status !== "active" ? ` · ${o.status}` : ""}</span></td>
              <td data-num="">{o.seatLimit ? <LimitMeter used={o.people} limit={o.seatLimit} /> : o.people}</td>
              <td data-num="">{o.activePeople}</td>
              <td data-num="">{compact(o.aiTokens)}</td>
              <td><LimitMeter used={o.aiTokensThisMonth} limit={o.aiTokensMonth} /></td>
              <td data-num="">{compact(o.aiRuns)}</td>
              <td data-num="">{compact(o.tasksCreated)}</td>
              <td data-num="">{compact(o.messages)}</td>
            </tr>)}</tbody>
          </Table>}
      </Panel>
    </Page>
  );
}
