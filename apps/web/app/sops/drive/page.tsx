import { FileSearch } from "lucide-react";
import { api } from "../../lib/api";
import { day } from "../../lib/format";
import { Empty, Message, Page, PageHeader, QueryTabs } from "../../ui";
import { SourceCard } from "../drive-parts";
import type { DriveList } from "../types";
import css from "../sops.module.css";

/** SOP-WORKFLOW: the documents in Drive that read like an SOP (found by the Drive refresh), each read into steps with
 *  a confidence. Leadership brings one in as it is, edits it first, or says it is not an SOP. */
export default async function DrivePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const q = await searchParams; const status = ["new", "imported", "dismissed", "gone"].includes(q.status ?? "") ? q.status! : "new";
  const r = await api<DriveList>(`sops/drive?status=${status}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!, n = (k: string) => d.counts[k] ?? 0;
  return <Page>
    <PageHeader title="Import from Drive" back={{ href: "/processes", label: "Processes" }} context={[`${n("new")} waiting`, `${n("imported")} brought in`, d.lastAt ? `Drive read ${day(d.lastAt)}` : "Drive not read yet"]} />
    <div className={css.area}>
      <QueryTabs sub base="/sops/drive" param="status" current={status} items={[{ key: "new", label: "Waiting", count: n("new") }, { key: "imported", label: "Brought in", count: n("imported") },
        { key: "dismissed", label: "Not SOPs", count: n("dismissed") }, ...(n("gone") ? [{ key: "gone", label: "No longer in Drive", count: n("gone") }] : [])]} />
      <p className={css.hint}>Pulse looks through Drive at every refresh for documents that read like an SOP: process, checklist, how-to, workflow and responsibility documents with numbered steps or a step table. Contact lists, pay, agreements and the HR drives are never read. Nothing becomes an SOP until you confirm it.</p>
      {d.sources.length ? <ul className={css.sources}>{d.sources.map((s) => <SourceCard key={s.id} s={s} />)}</ul>
        : <Empty icon={FileSearch} title={status === "new" ? "Nothing waiting" : "Nothing here"} text={status === "new" ? "Every SOP-like document Pulse found in Drive has been decided. New ones appear after the next Drive refresh." : "Documents move here when you decide them."} />}
    </div>
  </Page>;
}
