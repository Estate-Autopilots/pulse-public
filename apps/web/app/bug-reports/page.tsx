// BUG-REPORT (owner, 27 Oct 2026): every bug people reported (Ctrl+B, a shake, the account menu), for leadership and
// admins to triage: status, severity, assignee, reports that look like one problem, and a Pulse task made from one.
// Everyone else sees their own reports and where each stands.
import { api } from "../lib/api";
import { orgZone } from "../lib/brand-server";
import { Message, Page, PageHeader } from "../ui";
import { BugTriage, MyBugReports, type BugList, type MineRow } from "./triage";

export const metadata = { title: "Bug reports · Pulse" };

export default async function BugReports({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const params = new URLSearchParams({ ...(q.status ? { status: q.status } : {}), ...(q.q ? { q: q.q } : {}) });
  const zone = await orgZone();
  const list = await api<BugList>(`bug-reports${params.size ? `?${params}` : ""}`);
  if (list.status === 403) {
    const mine = await api<{ rows: MineRow[] }>("bug-reports/mine");
    return <Page>
      <PageHeader title="Your bug reports" context={["What you reported and where each stands", "Press Ctrl+B (⌘B) on any screen, or shake the phone in the Pulse app"]} />
      {mine.data ? <MyBugReports rows={mine.data.rows} zone={zone} /> : <Message text={mine.error} />}
    </Page>;
  }
  if (!list.data) return <Page><PageHeader title="Bug reports" /><Message text={list.error} /></Page>;
  return <Page>
    <PageHeader title="Bug reports" context={[`${list.data.counts.new} new · ${list.data.counts.triaged + list.data.counts.fixing} being handled`, "Reported with Ctrl+B, a phone shake or the account menu"]} />
    <BugTriage data={list.data} openId={q.id ?? null} zone={zone} />
  </Page>;
}
