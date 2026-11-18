import { ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { Message, Page, PageHeader, styles } from "../../ui";
import { EmptyState as Empty } from "../../components/kit";
import { SelectField } from "../../kit/select-field";
import { span } from "../../lib/finance-numbers.mjs";
import { Periods } from "../../finance/numbers";
import { ErpNav } from "../nav";
import { DealsBoard, type Deals } from "../../sales/deals";
import { AutoForm } from "../../sales/auto-form";
import css from "../../finance/numbers.module.css";

export const metadata = { title: "Deals · Billing" };

/** KAZUK-V2 G12 (Kazuk, 6 Nov 2026, R31): Billing → Deals. How quotations moved from the first price to the agreed one:
 *  the discount, versions, days to yes and to paid, services cut, deals lost by reason. Read only. A salesperson sees
 *  their own; the Sales Head, leadership and Finance see everyone's and may pick one salesperson. */
export default async function DealsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const period = ["month", "last", "quarter", "fy", "lastfy"].includes(q.period) ? q.period : "quarter";
  const person = q.person && /^[0-9a-f-]{36}$/.test(q.person) ? q.person : "";
  const r = await api<Deals>(`sales-deals?${new URLSearchParams(Object.entries({ period, person, all: person ? "" : "1" }).filter(([, v]) => v))}`);
  if (!r.data) return <Page><PageHeader title="Deals" context={["Billing"]} />
    {r.status === 403 ? <Empty icon={ShieldCheck} title="Another salesperson's deals are for the Sales Head" text="You can see your own deals here." action={{ href: "/erp/deals", label: "See my own" }} />
      : <Message text={r.error ?? "Deals are unavailable"} />}</Page>;
  const d = r.data, when = span(d.from, d.to), keep = person ? { person } : undefined;
  const title = d.everyone || d.person?.self ? "Deals" : `Deals · ${d.person?.name ?? ""}`;
  return <Page>
    <PageHeader title={title} context={["Billing", d.everyone ? "Everyone's deals" : d.person?.self ? "Your deals" : "One salesperson", when]} />
    <ErpNav current="deals" own={d.ownOnly} />
    <div className={css.page}>
      <p className={css.quiet}>How each quotation moved from its first price to the one the client agreed. Read only.</p>
      <div className={css.head}>
        <Periods base="/erp/deals" period={d.period} keep={keep} />
        {d.canSeeTeam ? <AutoForm className={css.person} action="/erp/deals" label="Pick a salesperson">
          <input type="hidden" name="period" value={d.period} />
          <label className={styles.field}>Salesperson<SelectField name="person" defaultValue={person}>
            <option value="">Everyone</option>
            {(d.team ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {person && d.person && !(d.team ?? []).some((p) => p.id === person) ? <option value={person}>{d.person.name}</option> : null}
          </SelectField></label>
        </AutoForm> : null}
      </div>
      <DealsBoard d={d} own={!!d.person?.self} newHref={d.canOpenErp ? "/erp/new?type=quotation" : undefined} />
    </div>
  </Page>;
}
