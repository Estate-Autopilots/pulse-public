import Link from "next/link";
import { redirect } from "next/navigation";
import { api } from "../lib/api";
import { VIEWS, isDay, type View } from "../lib/pr-flow.mjs";
import { Message, Page, PageHeader } from "../ui";
import { FlowStudio } from "./flow";
import { kitPost } from "./flow-pick";
import type { FlowData } from "./flow-types";
import css from "./flow.module.css";

export const dynamic = "force-dynamic";

const OLD_TABS = ["today", "pipeline", "ideas", "story", "drafts", "calendar", "brands", "report", "audiences", "team"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PR-STUDIO-2 (owner, 7 Nov 2026: "there is no flow"): PR Studio is one path per brand, left to right: Strategy ->
 *  Calendar -> Board -> Library -> Post kit -> Insights (services/api/src/pr-flow.ts). The earlier tools (the Story,
 *  proof of work, ideas, brands, the weekly report) stay under /pr/more, and their old links lead there. */
export default async function PrStudioPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  if (q.tab && OLD_TABS.includes(q.tab)) redirect(`/pr/more?${new URLSearchParams(q).toString()}`);
  const brand = q.brand && UUID.test(q.brand) ? q.brand : "";
  const r = await api<FlowData>(`pr/flow${brand ? `?brand=${brand}` : ""}`);
  if (!r.data) return <Message text={r.status === 403 ? "PR Studio is for the company's admins, leadership and the people on a brand." : r.error ?? "PR Studio is unavailable."} />;
  const d = r.data;
  const view: View = (VIEWS as string[]).includes(q.view) ? q.view as View : "calendar";
  const cal = ["month", "week", "day"].includes(q.cal) ? q.cal as "month" | "week" | "day" : "month";
  const date = isDay(q.date) ? q.date : d.today ?? "";
  const post = q.post && UUID.test(q.post) ? q.post : null;
  const asset = q.asset && UUID.test(q.asset) ? q.asset : null;
  const base = (extra: Record<string, string>) => `/pr?${new URLSearchParams({ ...(d.brand ? { brand: d.brand.id } : {}), ...extra }).toString()}`;
  const due = kitPost(d, null);
  const unmeasured = d.posts.find((p) => p.stage === "posted");
  // One primary action per screen.
  const primary = !d.brand ? null
    : view === "strategy" ? <Link className={css.primaryBtn} href={base({ view: "strategy", edit: "1" })}>Edit the strategy</Link>
    : view === "calendar" ? due ? <Link className={css.primaryBtn} href={base({ view: "kit", post: due.id })}>Open the next post kit</Link> : null
    : view === "board" ? <Link className={css.primaryBtn} href={base({ view: "board", new: "1" })}>New idea</Link>
    : view === "insights" && unmeasured ? <Link className={css.primaryBtn} href={base({ view: "kit", post: unmeasured.id })}>Log the numbers</Link>
    : null;
  return <Page>
    <PageHeader title="PR Studio" context={[d.brand ? d.brand.name : "No brand yet", "Plan, schedule and post, one step at a time"]} actions={primary} />
    <FlowStudio data={d} view={view} cal={cal} date={date} post={post} asset={asset} edit={q.edit === "1"} adding={q.new === "1"} />
  </Page>;
}
