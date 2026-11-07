// AI-AUTONOMY (owner, 27 Oct 2026): the bug and feature board. Tool requests and ideas (many filed by AI employees that
// lacked a tool), and bugs for the people who reported them and leadership: upvote, discuss, and see where each stands.
// Leadership puts an item on the queue Pulse's dev agents pick up; a dev agent comments and marks it shipped.
import { api } from "../../lib/api";
import { orgZone } from "../../lib/brand-server";
import { Message, Page, PageHeader, QueryTabs } from "../../ui";
import { Board, type BoardData } from "./board";

export const metadata = { title: "Bug and feature board · Pulse" };

const KINDS = [{ key: "all", label: "Everything" }, { key: "tool_needed", label: "Tools needed" }, { key: "feature", label: "Ideas" }, { key: "bug", label: "Bugs" }];
const STATUS = [{ key: "open", label: "Open" }, { key: "fixed", label: "Shipped" }, { key: "all", label: "All" }];

export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const kind = KINDS.some((k) => k.key === q.kind) ? q.kind! : "all", status = STATUS.some((s) => s.key === q.status) ? q.status! : "open", sort = q.sort === "new" ? "new" : "top";
  const zone = await orgZone();
  const list = await api<BoardData>(`board?${new URLSearchParams({ kind, status, sort })}`);
  if (!list.data) return <Page><PageHeader title="Bug and feature board" /><Message text={list.error} /></Page>;
  const fromAi = list.data.items.filter((i) => i.byAgent).length;
  return <Page>
    <PageHeader title="Bug and feature board" context={[`${list.data.items.length} ${status === "fixed" ? "shipped" : status === "all" ? "items" : "open"}${fromAi ? ` · ${fromAi} from AI employees` : ""}`, "Vote for what matters; Pulse’s dev agents pick up what leadership queues"]} />
    <QueryTabs base="/bug-reports/board" items={KINDS} current={kind} param="kind" keep={`status=${status}&sort=${sort}`} label="Kinds" />
    <Board data={list.data} zone={zone} status={status} sort={sort} kind={kind} openId={q.id ?? null} />
  </Page>;
}
