import Link from "next/link";
import { redirect } from "next/navigation";
import { api, getMe } from "../lib/api";
import { VIEWS, isDay, type View } from "../lib/pr-flow.mjs";
import { Message, Page, PageHeader } from "../ui";
import { FlowStudio } from "./flow";
import { PrFirstRun } from "./first-run";
import type { FlowData } from "./flow-types";
import css from "./flow.module.css";

export const dynamic = "force-dynamic";

const OLD_TABS = ["today", "pipeline", "ideas", "story", "drafts", "calendar", "brands", "report", "audiences", "team"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PR-STUDIO-2 (owner, 7 Nov 2026: "there is no flow"); FIX-PR-CALENDAR (10 Nov: "a total mess ... redesign the whole
 *  flow"): PR Studio is one path per brand: Today (do this next), then Plan -> Calendar -> Create -> Check -> Schedule ->
 *  Post -> Results (services/api/src/pr-flow.ts). A company's own brand is ready the first time; the earlier tools (the
 *  Story, proof of work, ideas, brands, the weekly report) stay under /pr/more, and their old links lead there. */
export default async function PrStudioPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  if (q.tab && OLD_TABS.includes(q.tab)) redirect(`/pr/more?${new URLSearchParams(q).toString()}`);
  const brand = q.brand && UUID.test(q.brand) ? q.brand : "";
  const r = await api<FlowData>(`pr/flow${brand ? `?brand=${brand}` : ""}`);
  if (!r.data) return <Message text={r.status === 403 ? "PR Studio is for the company's admins, leadership and the people on a brand." : r.error ?? "PR Studio is unavailable."} />;
  const d = r.data;
  const view: View = (VIEWS as string[]).includes(q.view) ? q.view as View : "home";
  const cal = ["month", "week", "day"].includes(q.cal) ? q.cal as "month" | "week" | "day" : "month";
  const date = isDay(q.date) ? q.date : d.today ?? "";
  const post = q.post && UUID.test(q.post) ? q.post : null;
  const asset = q.asset && UUID.test(q.asset) ? q.asset : null;
  const base = (extra: Record<string, string>) => `/pr?${new URLSearchParams({ ...(d.brand ? { brand: d.brand.id } : {}), ...extra }).toString()}`;
  const unmeasured = d.posts.find((p) => p.stage === "posted");
  // One primary action per screen (Today's is "Do this next" inside the page; the Post kit's is Mark posted).
  const primary = !d.brand ? null
    : view === "strategy" && q.edit !== "1" ? <Link className={css.primaryBtn} href={base({ view: "strategy", edit: "1" })}>Edit the plan</Link>
    : view === "create" || view === "board" ? <Link className={css.primaryBtn} href={base({ view, new: "1" })}>New idea</Link>
    : view === "insights" && unmeasured ? <Link className={css.primaryBtn} href={base({ view: "kit", post: unmeasured.id })}>Log the numbers</Link>
    : null;
  // UI-SWEEP: no brand yet is PR Studio's first run (what it does, a sample month, the three-step setup), not one card.
  if (!d.brand) {
    const me = (await getMe()).data;
    return <Page>
      <PageHeader title="PR Studio" context={["Plan, write and post for your brand"]} />
      <PrFirstRun me={d.me} company={me?.orgName ?? null} today={d.today ?? ""} />
    </Page>;
  }
  return <Page>
    <PageHeader title="PR Studio" context={[d.brand ? d.brand.name : "PR Studio", "Plan, make, check and post, one step at a time"]} actions={primary} />
    <FlowStudio data={d} view={view} cal={cal} date={date} post={post} asset={asset} edit={q.edit === "1"} adding={q.new === "1"} />
  </Page>;
}
