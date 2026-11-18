import { FileSearch } from "lucide-react";
import { api } from "../../lib/api";
import { day } from "../../lib/format";
import { Empty, Message, Page, PageHeader, QueryTabs, styles as ui } from "../../ui";
import { SourceCard } from "../drive-parts";
import Link from "next/link";
import empty from "./drive-empty.module.css";
import type { DriveList } from "../types";
import css from "../sops.module.css";

/** SOP-WORKFLOW: the documents in Drive that read like an SOP (found by the Drive refresh), each read into steps with
 *  a confidence. Leadership brings one in as it is, edits it first, or says it is not an SOP. */
export default async function DrivePage({ searchParams }: { searchParams: Promise<{ status?: string; all?: string }> }) {
  const q = await searchParams; const status = ["new", "imported", "dismissed", "gone"].includes(q.status ?? "") ? q.status! : "new";
  const r = await api<DriveList>(`sops/drive?status=${status}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!, n = (k: string) => d.counts[k] ?? 0;
  // VISUAL-QA (round 3: 59 documents made 13,400 px): the first 15, then "Show all".
  const listed = q.all === "1" ? d.sources : d.sources.slice(0, 15);
  return <Page>
    <PageHeader title="Add processes from Google Drive" back={{ href: "/processes", label: "Processes" }} context={d.lastAt ? [`${n("new")} to look at`, `${n("imported")} added`, `Last looked ${day(d.lastAt)}`] : undefined} />
    <div className={css.area}>
      {Object.values(d.counts).some((x) => x > 0) ? <QueryTabs sub base="/sops/drive" param="status" current={status} items={[{ key: "new", label: "To look at", count: n("new") }, { key: "imported", label: "Added", count: n("imported") },
        { key: "dismissed", label: "Not a process", count: n("dismissed") }, ...(n("gone") ? [{ key: "gone", label: "No longer in Drive", count: n("gone") }] : [])]} /> : null}
      {/* FIX-DOCS-WORK (owner, 10 Nov 2026: "import from Drive is unclear"): what this page is, in plain words. */}
      {d.sources.length ? <p className={css.hint}>Pulse found these how-to documents in your company&apos;s Google Drive: checklists and step-by-step guides. Open one to turn it into a process, so its steps become a list people follow. Nothing changes until you say yes. Pay, agreements, contact lists and HR folders are never read.</p> : null}
      {d.sources.length ? <><ul className={css.sources}>{listed.map((s) => <SourceCard key={s.id} s={s} />)}</ul>
        {listed.length < d.sources.length ? <p style={{ display: "flex", justifyContent: "center", margin: "12px 0 4px" }}><Link className={ui.btn} href={`/sops/drive?status=${status}&all=1`}>Show all {d.sources.length} documents</Link></p> : null}</>
        : status === "new" && !d.lastAt ? <div className={empty.box}><span className={empty.art} aria-hidden="true"><FileSearch size={26} /></span><h2>Connect Drive to find your how-to docs</h2>
          <p>Connect your company&apos;s Google Drive. Pulse then finds checklists and step-by-step guides, for example “Site visit checklist”, and lists them here to turn into processes.</p>
          <div className={empty.preview} aria-hidden="true"><span className={empty.doc}>Site visit checklist.docx</span><span className={empty.arrow}>→</span><span className={empty.proc}>Site visit · 6 steps</span></div>
          <Link className={empty.go} href="/settings?tab=connected">Connect Google Drive</Link><small className={empty.small}>Pulse only reads. It never changes anything in your Drive.</small>
          <Link className={empty.alt} href="/processes/new">Or start from a ready-made process</Link></div>
        : <Empty icon={FileSearch} title={status !== "new" ? "Nothing here" : "Nothing new to look at"}
          text={status !== "new" ? "Documents move here when you decide them." : "Every how-to document Pulse found in your Google Drive has been looked at. New ones show up after the next Drive read."} />}
    </div>
  </Page>;
}
