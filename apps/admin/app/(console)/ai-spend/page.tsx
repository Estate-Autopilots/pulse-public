import { Coins } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { compact } from "@/app/lib/format";
import type { SpendRow } from "@/app/lib/types";
import { Empty, Kpi, Meter, Page, PageHeader, Panel, QueryTabs, Table, Tiles, Unavailable } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

// PULSE-ADMIN: AI spend (the Sales X-Ray admin's AI spend), from Pulse's own token metering: AI employee runs, group
// summaries and product map reads, by organisation and by engine. Tokens, not money: prices per engine are not kept yet.
export default async function AiSpend({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const raw = (await searchParams).days ?? "30";
  const days = ["7", "30", "90"].includes(raw) ? raw : "30";
  const r = await read<{ days: number; rows: SpendRow[] }>(`platform/ai-spend?days=${days}`);
  const rows = r.data?.rows ?? [];
  const tokens = (x: SpendRow) => Number(x.tokensIn) + Number(x.tokensOut);
  const sum = (list: SpendRow[]) => list.reduce((n, x) => n + tokens(x), 0);
  const group = (key: (x: SpendRow) => string) => {
    const map = new Map<string, SpendRow[]>();
    for (const x of rows) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
    return [...map.entries()].map(([name, list]) => ({ name, list, tokens: sum(list), runs: list.reduce((n, x) => n + Number(x.runs), 0), failed: list.reduce((n, x) => n + Number(x.failed), 0) }))
      .sort((a, b) => b.tokens - a.tokens);
  };
  const byOrg = group((x) => `${x.orgId}|${x.org}`);
  const byEngine = group((x) => x.engine);
  const bySource = group((x) => x.source);
  const total = sum(rows);
  return (
    <Page wide>
      <PageHeader title="AI spend" context={["AI tokens across every organisation", `Last ${days} days`]} />
      <QueryTabs base="/ai-spend" param="days" current={days} items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }]} />
      <Tiles>
        <Kpi label="Tokens" value={compact(total)} note={`${compact(rows.reduce((n, x) => n + Number(x.tokensIn), 0))} in · ${compact(rows.reduce((n, x) => n + Number(x.tokensOut), 0))} out`} />
        <Kpi label="AI runs" value={compact(rows.reduce((n, x) => n + Number(x.runs), 0))} />
        <Kpi label="Failed runs" value={compact(rows.reduce((n, x) => n + Number(x.failed), 0))} tone={rows.some((x) => Number(x.failed) > 0) ? "warn" : "good"} />
        <Kpi label="Engines in use" value={byEngine.length} />
      </Tiles>
      {r.error ? <Unavailable title="AI spend" reason={r.error} /> : !rows.length ? <Panel title="AI spend"><Empty icon={Coins} title="No AI use in this period" /></Panel> : <>
        <div className={css.split}>
          <Panel title="By organisation">
            <Table label="AI tokens by organisation">
              <thead><tr><th>Organisation</th><th data-num="">Tokens</th><th>Share</th><th data-num="">Runs</th><th data-num="">Failed</th></tr></thead>
              <tbody>{byOrg.map((g) => { const [id, name] = g.name.split("|"); return <tr key={g.name}>
                <td><Link className={css.name} href={`/organisations/${id}`}>{name}</Link></td><td data-num="">{compact(g.tokens)}</td>
                <td><Meter value={g.tokens} max={total} label={`${Math.round((g.tokens / Math.max(total, 1)) * 100)}% of tokens`} /></td>
                <td data-num="">{compact(g.runs)}</td><td data-num="">{g.failed}</td></tr>; })}</tbody>
            </Table>
          </Panel>
          <div className={css.stack}>
            <Panel title="By engine">
              <Table label="AI tokens by engine">
                <thead><tr><th>Engine</th><th data-num="">Tokens</th><th data-num="">Runs</th></tr></thead>
                <tbody>{byEngine.map((g) => <tr key={g.name}><td><code className={css.code}>{g.name}</code></td><td data-num="">{compact(g.tokens)}</td><td data-num="">{compact(g.runs)}</td></tr>)}</tbody>
              </Table>
            </Panel>
            <Panel title="By feature">
              <Table label="AI tokens by feature">
                <thead><tr><th>Feature</th><th data-num="">Tokens</th><th data-num="">Runs</th></tr></thead>
                <tbody>{bySource.map((g) => <tr key={g.name}><td>{g.name}</td><td data-num="">{compact(g.tokens)}</td><td data-num="">{compact(g.runs)}</td></tr>)}</tbody>
              </Table>
            </Panel>
          </div>
        </div>
        <p className={css.note}>Tokens are what Pulse metered. Money per engine is not kept yet; each organisation’s monthly token limit is under its plan.</p>
      </>}
    </Page>
  );
}
