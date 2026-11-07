import { financialYear, type DocType } from "@pulse/invoice-doc";
import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import type { Company } from "../types";
import type { BillingSetup } from "./fields";
import { BillingSettings, Exports } from "./form";
import s from "./settings.module.css";
import { ClientPayments, type ClientPaySettings } from "./client-payments";
import type { CostVisibility } from "./form";
import { SalesFlowSettings, type SalesFlow } from "./flow";
import { BookOpen } from "lucide-react";
import { Card, SectionHeader } from "../../components/calm";

type Settings = { company: Company; inventoryEnabled: boolean; dueDays: number; roundTotal: boolean; fy: string; today: string; canWrite: boolean; quoteApproval?: boolean; canSetApproval?: boolean; costVisibility?: CostVisibility;
  series: { docType: DocType; fy: string; pattern: string; nextNo: number; lastDate: string | null }[];
  mirror: { enabled: boolean; name: string | null; note: string }; esign: readonly { key: string; label: string; kind: string; note: string }[] };

// BILLING-SETUP: Company, Numbering, Taxes & defaults, Industry pack, Fields, then exports, books and signing.
export default async function ErpSettings() {
  const [r, setup, pay, flow] = await Promise.all([api<Settings>("erp/settings"), api<BillingSetup>("erp/setup"), api<ClientPaySettings>("erp/client-payments"), api<SalesFlow>("erp/flow")]);
  if (!r.data) return <Message text={r.error ?? "Settings are unavailable"} />;
  const x = r.data;
  return <Page>
    <PageHeader title="Settings" context={[ERP_CONTEXT, x.company.legalName ?? ""]} />
    <ErpNav current="settings" inventory={x.inventoryEnabled} />
    <div className={s.page}>
      <BillingSettings costVisibility={x.costVisibility} quoteApproval={x.quoteApproval} canSetApproval={x.canSetApproval} company={x.company} inventoryEnabled={x.inventoryEnabled} dueDays={x.dueDays} roundTotal={x.roundTotal} series={x.series} fy={x.fy} today={x.today}
        canWrite={x.canWrite} setup={setup.data ?? null} />
      {/* KAZUK-FLOW config (1671): the company's sales flow, a preset or its own steps. */}
      {flow.data ? <SalesFlowSettings initial={flow.data} /> : null}
      <Exports fy={financialYear(x.today)} />
      {/* PORTAL-2: paying from the client's Pulse space (bank transfer and UPI; off until switched on). */}
      {pay.data ? <ClientPayments initial={pay.data} /> : null}
      <Card label="Books and signing" className={s.card}>
        <SectionHeader id="books-h" icon={<BookOpen size={16} aria-hidden="true" />} title="Books and signing" hint="Today: the acceptance link" />
        <p className={s.quiet}>{x.mirror.note}</p>
        <p className={s.quiet}>Issued invoices join the sales register, collections and Reconcile in Finance at each sync; the CA desk&apos;s Tally and Zoho exports include them.</p>
        <ul className={s.list}>{x.esign.map((o) => <li key={o.key}><b>{o.label}</b> · {o.kind} · {o.note}</li>)}</ul>
      </Card>
    </div>
  </Page>;
}
