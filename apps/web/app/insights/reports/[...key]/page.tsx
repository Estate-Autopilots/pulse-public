import Link from "next/link";
import { api } from "../../../lib/api";
import { orgZone } from "../../../lib/brand-server";
import { Message, Page, PageHeader } from "../../../ui";
import { ReportBody, ReportExports, type ReportPage } from "../view";
import r from "../reports.module.css";
// WA-REPORT (1074): one page of the analysis book (/insights/reports/<part>/<id>): its key numbers, charts, tables and
// evidence, exports (Markdown, PDF) and the pages before and after it. Leadership and admins, or the colleague it is about.
const PART_TAB: Record<string, string> = { company: "company", pods: "pods", people: "people", clients: "clients", projects: "projects", groups: "groups" };

export default async function ReportPageView({ params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const k = key.map(decodeURIComponent).join("/");
  const [res, zone] = await Promise.all([api<ReportPage>(`reports/page?key=${encodeURIComponent(k)}`), orgZone()]);
  if (res.error) return <Message text={res.status === 404 ? "This report page is not there, or not yours to read" : res.error} />;
  const p = res.data!;
  const context = [p.subtitle, p.printed ? `Printed p. ${p.printed.start} · ${p.printed.pages} ${p.printed.pages === 1 ? "page" : "pages"}` : null, `Edition ${p.edition.version}`].filter(Boolean) as string[];
  return <Page>
    <PageHeader title={p.title} context={context} back={{ href: `/insights/reports?tab=${PART_TAB[p.part] ?? "company"}`, label: "Reports" }} actions={<ReportExports page={p} />} />
    <ReportBody page={p} zone={zone} />
    {p.prev || p.next ? <nav className={r.pager} aria-label="Pages">
      {p.prev ? <Link href={`/insights/reports/${p.prev.key}`}>← {p.prev.title}</Link> : <span />}
      {p.next ? <Link href={`/insights/reports/${p.next.key}`}>{p.next.title} →</Link> : <span />}
    </nav> : null}
  </Page>;
}
