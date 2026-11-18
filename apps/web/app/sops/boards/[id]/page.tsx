import { Suspense } from "react";
import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { BoardBuilder } from "../../board";
import type { BoardDetail } from "../../board-types";
import css from "../../sops.module.css";

/** WORKFLOW BUILDER: one board. Its workflows are tabs, one per person's or role's job, built from blocks and joined by
 *  hand-offs; leadership designs and tests them here, everyone else reads them. */
export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<BoardDetail>(`workflows/boards/${id}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!;
  return <Page>
    <PageHeader title={d.board.name} back={{ href: "/processes", label: "Processes" }} recent={{ title: d.board.name }}
      context={[`${d.tabs.length} ${d.tabs.length === 1 ? "tab" : "tabs"}`, d.board.purpose]} />
    <div className={css.area}>
      <Suspense><BoardBuilder data={d} /></Suspense>
    </div>
  </Page>;
}
