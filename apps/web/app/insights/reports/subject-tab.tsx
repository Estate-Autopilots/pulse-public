import Link from "next/link";
import { FileText } from "lucide-react";
import { api } from "../../lib/api";
import { orgZone } from "../../lib/brand-server";
import { Empty, Panel, styles } from "../../ui";
import { ReportBody, ReportExports, type ReportPage } from "./view";
// WA-REPORT (1074): the report page about a colleague, a client or a project, as a tab of their own page in Pulse. The database
// decides who sees it (leadership and admins; a colleague their own).

/** The report page about this subject that the viewer may read, if any (one cheap read, for the tab bar). */
export async function reportFor(kind: "person" | "client" | "project" | "group", id: string) {
  return (await api<{ page: { key: string; title: string; summary: string | null } | null }>(`reports/subject/${kind}/${encodeURIComponent(id)}`)).data?.page ?? null;
}

export async function ReportTab({ reportKey }: { reportKey: string }) {
  const [res, zone] = await Promise.all([api<ReportPage>(`reports/page?key=${encodeURIComponent(reportKey)}`), orgZone()]);
  if (!res.data) return <Panel title="Report"><Empty icon={FileText} title="Not visible to your account" text="Reports are read by leadership and admins, and by the colleague a report is about." /></Panel>;
  const p = res.data;
  return <section aria-label="Report">
    <Panel title="Report" sub={`From the analysis of the client groups · edition ${p.edition.version}${p.printed ? ` · printed p. ${p.printed.start}` : ""}`}
      tools={<><ReportExports page={p} /><Link className={styles.btn} href={`/insights/reports/${p.key}`}>Open in Reports</Link></>}>
      <div style={{ padding: "0 14px 14px" }}><ReportBody page={p} zone={zone} /></div>
    </Panel>
  </section>;
}
