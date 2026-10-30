import { Coins } from "lucide-react";
import Link from "next/link";

import { read } from "@/app/lib/api";
import { compact } from "@/app/lib/format";
import type { SpendMonth, SpendRow } from "@/app/lib/types";
import { Empty, Kpi, Meter, Page, PageHeader, Panel, QueryTabs, Table, Tiles, Unavailable, kitStyles } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

const inr = (n: number | null | undefined) => n === null || n === undefined ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;

// PULSE-ADMIN: AI spend (the Sales X-Ray admin's AI spend), from Pulse's own token metering (AI employee runs, group
// summaries, product map reads) by organisation and engine, in rupees from the price table (Settings → AI prices).
export default async function AiSpend({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const raw = (await searchParams).days ?? "30";
  const days = ["7", "30", "90"].includes(raw) ? raw : "30";
  const r = await read<{ days: number; rows: SpendRow[]; months: SpendMonth[]; priced: boolean }>(`platform/ai-spend?days=${days}`);
  const rows = r.data?.rows ?? [];
  const tokens = (x: SpendRow) => Number(x.tokensIn) + Number(x.tokensOut);
  const money = (list: SpendRow[]) => list.some((x) => x.inr !== null) ? list.reduce((n, x) => n + Number(x.inr ?? 0), 0) : null;
  const group = (key: (x: SpendRow) => string) => {
    const map = new Map<string, SpendRow[]>();
    for (const x of rows) map.set(key(x), [...(map.get(key(x)) ?? []), x]);
    return [...map.entries()].map(([name, list]) => ({ name, list, tokens: list.reduce((n, x) => n + tokens(x), 0), inr: money(list),
      runs: list.reduce((n, x) => n + Number(x.runs), 0), failed: list.reduce((n, x) => n + Number(x.failed), 0) })).sort((a, b) => (b.inr ?? 0) - (a.inr ?? 0) || b.tokens - a.tokens);
  };
  const byOrg = group((x) => `${x.orgId}|${x.org}`), byEngine = group((x) => x.engine), bySource = group((x) => x.source);
  const total = rows.reduce((n, x) => n + tokens(x), 0), totalInr = money(rows);
  const unpriced = byEngine.filter((g) => g.inr === null && g.tokens > 0).map((g) => g.name);
  const months = [...new Set((r.data?.months ?? []).map((m) => m.month))].sort().reverse().slice(0, 4);
  const monthOrgs = [...new Map((r.data?.months ?? []).map((m) => [m.orgId, m.org])).entries()];
  const cell = (org: string, month: string) => (r.data?.months ?? []).find((m) => m.orgId === org && m.month === month);
  return (
    <Page wide>
      <PageHeader title="AI spend" context={["AI tokens and rupees across every organisation", `Last ${days} days`]}
        actions={<Link className={kitStyles.button} href="/settings#prices">AI prices</Link>} />
      <QueryTabs base="/ai-spend" param="days" current={days} items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }]} />
      <Tiles>
        <Kpi label="Spend" value={inr(totalInr)} note={r.data?.priced ? (unpriced.length ? `${unpriced.length} engine(s) not priced` : "From the price table") : "No prices yet"} href="/settings#prices" />
        <Kpi label="Tokens" value={compact(total)} note={`${compact(rows.reduce((n, x) => n + Number(x.tokensIn), 0))} in · ${compact(rows.reduce((n, x) => n + Number(x.tokensOut), 0))} out`} />
        <Kpi label="AI runs" value={compact(rows.reduce((n, x) => n + Number(x.runs), 0))} note={`${rows.reduce((n, x) => n + Number(x.failed), 0)} failed`} />
        <Kpi label="Engines in use" value={byEngine.length} />
      </Tiles>
      {r.error ? <Unavailable title="AI spend" reason={r.error} /> : !rows.length && !months.length ? <Panel title="AI spend"><Empty icon={Coins} title="No AI use in this period" /></Panel> : <>
        {months.length ? <Panel title="By organisation and month" sub="Rupees (tokens), the last months">
          <Table label="AI spend by organisation and month">
            <thead><tr><th>Organisation</th>{months.map((m) => <th key={m} data-num="">{m}</th>)}</tr></thead>
            <tbody>{monthOrgs.map(([id, name]) => <tr key={id}><td><Link className={css.name} href={`/organisations/${id}`}>{name}</Link></td>
              {months.map((m) => { const c = cell(id, m); return <td key={m} data-num="">{c ? <>{inr(c.inr)}<span className={css.sub}>{compact(c.tokens)} tokens</span></> : "—"}</td>; })}</tr>)}</tbody>
          </Table>
        </Panel> : null}
        <div className={css.split}>
          <Panel title="By organisation" sub={`Last ${days} days`}>
            <Table label="AI spend by organisation">
              <thead><tr><th>Organisation</th><th data-num="">Rupees</th><th data-num="">Tokens</th><th>Share</th><th data-num="">Runs</th></tr></thead>
              <tbody>{byOrg.map((g) => { const [id, name] = g.name.split("|"); return <tr key={g.name}>
                <td><Link className={css.name} href={`/organisations/${id}`}>{name}</Link></td><td data-num="">{inr(g.inr)}</td><td data-num="">{compact(g.tokens)}</td>
                <td><Meter value={g.tokens} max={total} label={`${Math.round((g.tokens / Math.max(total, 1)) * 100)}% of tokens`} /></td>
                <td data-num="">{compact(g.runs)}</td></tr>; })}</tbody>
            </Table>
          </Panel>
          <div className={css.stack}>
            <Panel title="By engine">
              <Table label="AI spend by engine">
                <thead><tr><th>Engine</th><th data-num="">Rupees</th><th data-num="">Tokens</th></tr></thead>
                <tbody>{byEngine.map((g) => <tr key={g.name}><td><code className={css.code}>{g.name}</code></td><td data-num="">{inr(g.inr)}</td><td data-num="">{compact(g.tokens)}</td></tr>)}</tbody>
              </Table>
            </Panel>
            <Panel title="By feature">
              <Table label="AI spend by feature">
                <thead><tr><th>Feature</th><th data-num="">Rupees</th><th data-num="">Tokens</th></tr></thead>
                <tbody>{bySource.map((g) => <tr key={g.name}><td>{g.name}</td><td data-num="">{inr(g.inr)}</td><td data-num="">{compact(g.tokens)}</td></tr>)}</tbody>
              </Table>
            </Panel>
          </div>
        </div>
        {unpriced.length ? <p className={css.note}>No price for {unpriced.join(", ")}: add one (or a “*” price for any other engine) under Settings → AI prices.</p> : null}
      </>}
    </Page>
  );
}
