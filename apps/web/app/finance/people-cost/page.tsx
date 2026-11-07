import { ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { Page } from "../../ui";
import { EmptyState, PageHeader } from "../../components/kit";
import { FinanceFrame } from "../nav";
import { Switch } from "../switch";
import type { LiveState } from "../types";
import type { LedgerEntry, PeopleCost } from "./model";
import { Budget, Ledger, Overview } from "./views";
import { WhatIf } from "./whatif";

/** COMP-B: Finance → People cost. One page: this month's payroll, the budget against actual, runway and What if…;
 *  founders and HR (individuals' pay stays theirs; the CA sees monthly totals on the CA desk). */
export default async function PeopleCostPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const query = new URLSearchParams(Object.entries({ opening: q.opening ?? "", compare: q.compare ?? "" }).filter(([, v]) => v));
  const [r, ledger, live] = await Promise.all([api<PeopleCost>(`comp/people-cost${query.size ? `?${query}` : ""}`), api<{ entries: LedgerEntry[] }>("comp/ledger"), api<LiveState>("finance/live")]);
  if (!r.data) return <Page calm><PageHeader eyebrow={["Finance", "Founders and HR"]} title="People cost" lede="Payroll, the people budget and runway, for founders and HR." />
    <EmptyState icon={ShieldCheck} title="People cost is for founders and HR" text={r.status === 403 ? "Like salaries, it needs the salary permission. Nothing was read and nothing was logged." : r.error ?? "Not available"}
      action={{ href: "/finance?tab=numbers", label: "Open Numbers instead" }} /></Page>;
  return <Page calm>
    <FinanceFrame tab="people-cost" q={q} live={live.data} private="Founders and HR · audited" />
    <Switch param="costView" label="People cost views" items={[
      { label: "Overview", content: <Overview d={r.data} /> },
      { label: "Budget", content: <Budget d={r.data} /> },
      { label: "What if…", content: <WhatIf d={r.data} /> },
      { label: "Ledger", content: <Ledger entries={ledger.data?.entries ?? null} /> },
    ]} />
  </Page>;
}
