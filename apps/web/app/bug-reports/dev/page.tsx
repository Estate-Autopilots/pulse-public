// KAZUK-REST slice 5 (E1/E2, migration 1708): the Pulse dev team's inbox of bug reports from every company. Only a
// summary arrives (the company, its report number, the screen, severity, app and browser, counts); the full report stays
// with that company, and platform admins open it in the admin console. Leadership of the Pulse dev organisation triages
// here and makes its own task; anyone else is sent back to their own bug reports.
import { Building2 } from "lucide-react";
import { api } from "../../lib/api";
import { orgZone } from "../../lib/brand-server";
import { Empty, Message, Page, PageHeader, QueryTabs } from "../../ui";
import { DevInbox, type DevInboxData } from "./inbox";

export const metadata = { title: "From other companies · Bug reports · Pulse" };

const STATUS = [{ key: "open", label: "Open" }, { key: "new", label: "New" }, { key: "fixed", label: "Fixed" }, { key: "all", label: "All" }];

export default async function DevBugInbox({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const status = STATUS.some((s) => s.key === q.status) ? q.status! : "open";
  const [r, zone] = await Promise.all([api<DevInboxData>(`bug-reports/dev-inbox?status=${status}`), orgZone()]);
  const back = { href: "/bug-reports", label: "Bug reports" };
  if (!r.data) return <Page><PageHeader title="From other companies" back={back} /><Message text={r.error} /></Page>;
  if (!r.data.devOrg) return <Page><PageHeader title="From other companies" back={back} />
    <Empty icon={Building2} title="This is the Pulse dev team’s inbox" text="Bug reports from every company arrive in the organisation named as the Pulse dev organisation. Your company’s own reports are under Bug reports." action={back} />
  </Page>;
  const c = r.data.counts!;
  return <Page>
    <PageHeader title="From other companies" back={back}
      context={[`${c.new} new · ${c.handling} being handled · from ${c.companies} ${c.companies === 1 ? "company" : "companies"}`, "A summary only: the full report stays with its company"]} />
    <QueryTabs base="/bug-reports/dev" param="status" items={STATUS} current={status} label="Where it stands" />
    <DevInbox data={r.data} zone={zone} adminUrl={process.env.PULSE_ADMIN_URL ?? ""} />
  </Page>;
}
