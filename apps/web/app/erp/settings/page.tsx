import { financialYear, type DocType } from "@pulse/invoice-doc";
import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import type { Company } from "../types";
import type { BillingSetup } from "./fields";
import { BillingSettings, Exports } from "./form";
import s from "./settings.module.css";

type Settings = { company: Company; inventoryEnabled: boolean; dueDays: number; roundTotal: boolean; fy: string; today: string; canWrite: boolean;
  series: { docType: DocType; fy: string; pattern: string; nextNo: number; lastDate: string | null }[];
  mirror: { enabled: boolean; name: string | null; note: string }; esign: readonly { key: string; label: string; kind: string; note: string }[] };

// BILLING-SETUP: Company, Numbering, Taxes & defaults, Industry pack, Fields, then exports, books and signing.
export default async function ErpSettings() {
  const [r, setup] = await Promise.all([api<Settings>("erp/settings"), api<BillingSetup>("erp/setup")]);
  if (!r.data) return <Message text={r.error ?? "Settings are unavailable"} />;
  const x = r.data;
  return <Page>
    <PageHeader title="Settings" context={[ERP_CONTEXT, x.company.legalName ?? ""]} />
    <ErpNav current="settings" inventory={x.inventoryEnabled} />
    <div className={s.page}>
      <BillingSettings company={x.company} inventoryEnabled={x.inventoryEnabled} dueDays={x.dueDays} roundTotal={x.roundTotal} series={x.series} fy={x.fy} today={x.today}
        canWrite={x.canWrite} setup={setup.data ?? null} />
      <Exports fy={financialYear(x.today)} />
      <section className={s.card} aria-labelledby="books-h">
        <div className={s.head}><h2 id="books-h">Books and signing</h2><small>Today: the acceptance link</small></div>
        <p className={s.quiet}>{x.mirror.note}</p>
        <p className={s.quiet}>Issued invoices join the sales register, collections and Reconcile in Finance at each sync; the CA desk&apos;s Tally and Zoho exports include them.</p>
        <ul className={s.list}>{x.esign.map((o) => <li key={o.key}><b>{o.label}</b> · {o.kind} · {o.note}</li>)}</ul>
      </section>
    </div>
  </Page>;
}
