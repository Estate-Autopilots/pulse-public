import Link from "next/link";
import { api } from "../../lib/api";
import { addDays } from "../../lib/pr-studio.mjs";
import { Message, Page, PageHeader, QueryTabs } from "../../ui";
import { Audiences, BriefCard, Calendar, DraftCard, PrTeam, StoryBook, Streak, Untold, WriteBrief } from "../studio";
import { BrandFilter, BrandsView, IdeasView, PipelineView, ReportsView } from "../pipeline";
import type { Dashboard, StoryData } from "../types";
import type { DraftMeta, Idea, Overview, Report } from "../pipeline-types";
import css from "../pr.module.css";

export const dynamic = "force-dynamic";

const TABS = ["today", "pipeline", "ideas", "story", "drafts", "calendar", "brands", "report", "audiences", "team"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PR-STUDIO (owner, 6 Nov 2026): the running story of the company's work, briefs, audiences, creative drafts and the
 *  content calendar, so the days do not go blank (services/api/src/pr-studio.ts). Admins, leadership and AI employees.
 *  PR-PIPELINE: the pipeline on top (services/api/src/pr-pipeline.ts): proof of work, ideas with designed images and
 *  approvals, brands (company, personal, client) and the weekly report. */
export default async function PrStudioMorePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const tab = (TABS as readonly string[]).includes(q.tab) ? q.tab as typeof TABS[number] : "today";
  const brand = q.brand && UUID.test(q.brand) ? q.brand : null;
  const r = await api<Dashboard>(`pr${q.month && /^\d{4}-\d{2}$/.test(q.month) ? `?month=${q.month}` : ""}`);
  if (!r.data) return <Message text={r.status === 403 ? "PR Studio is for the company's admins and leadership." : r.error ?? "PR Studio is unavailable."} />;
  const d = r.data;
  const story = tab === "story" ? await api<StoryData>(`pr/story?from=${q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : addDays(d.today, -62)}&to=${d.today}`) : null;
  const pipe = ["pipeline", "ideas", "brands", "report", "calendar"].includes(tab) ? await api<Overview>("pr/pipeline") : null;
  const ideas = tab === "ideas" ? await api<{ ideas: Idea[] }>(`pr/pipeline/ideas${brand ? `?brand=${brand}` : ""}`) : null;
  const reports = tab === "report" ? await api<{ reports: Report[] }>("pr/pipeline/reports") : null;
  const meta = tab === "calendar" && pipe?.data?.brands.length ? await api<{ drafts: DraftMeta[] }>("pr/pipeline/drafts") : null;
  const metaById = Object.fromEntries((meta?.data?.drafts ?? []).map((m) => [m.id, { brand: m.brand, approval: m.approval, brandId: m.brandId }]));
  const drafts = [...d.waiting, ...d.calendar.filter((x) => !d.waiting.some((w) => w.id === x.id))];
  const shown = q.draft ? drafts.find((x) => x.id === q.draft) : undefined;
  const todays = d.briefs.filter((b) => b.day === d.today);
  const calendar = d.calendar.concat(d.waiting.filter((w) => !w.planOn)).filter((x) => !brand || metaById[x.id]?.brandId === brand);
  const unavailable = (x: { error?: string | null; status?: number } | null) => <Message text={x?.status === 403 ? "This is for the company's admins, leadership and the people on a brand." : x?.error ?? "This is unavailable."} />;
  return <Page>
    <PageHeader title="More PR tools" back={{ href: "/pr", label: "PR Studio" }} context={["The Story, proof of work, ideas, brands and the weekly report", `${d.company}`]}
      actions={<Link className={`${css.btn} ${css.primary}`} href="/pr/more?tab=story">Add to the Story</Link>} />
    <QueryTabs base="/pr/more" current={tab} items={[{ key: "today", label: "Today" }, { key: "pipeline", label: "Proof of work" }, { key: "ideas", label: "Ideas" },
      { key: "story", label: "Story" }, { key: "drafts", label: "Drafts", count: d.waiting.length }, { key: "calendar", label: "Calendar" }, { key: "brands", label: "Brands" },
      { key: "report", label: "Weekly report" }, { key: "audiences", label: "Audiences" }, { key: "team", label: "PR team" }]} />
    <div className={css.wrap}>
      {tab === "today" ? <>
        <Streak streak={d.streak} toldLast30={d.toldLast30} activeDaysLast30={d.activeDaysLast30} toldToday={d.toldToday} untold={d.untoldCount} />
        <section className={css.section} aria-label="Today's briefs">
          <div className={css.sectionHead}><h2>Today&apos;s briefs</h2><WriteBrief /></div>
          {todays.length ? <div className={css.grid}>{todays.map((b) => <BriefCard key={b.id} brief={b} />)}</div>
            : <p className={css.empty}>The morning brief writes itself from 7:00 and the evening brief from 18:00, from the Story. Write one now with the buttons above.</p>}
        </section>
        <section className={css.section} aria-label="Drafts waiting">
          <div className={css.sectionHead}><h2>Drafts waiting</h2><Link className={css.link} href="/pr?tab=drafts">All drafts</Link></div>
          {d.waiting.length ? <div className={css.grid}>{d.waiting.slice(0, 4).map((x) => <DraftCard key={x.id} draft={x} company={d.company} today={d.today} />)}</div>
            : <p className={css.empty}>No drafts waiting. Pick what to tell below.</p>}
        </section>
        <section className={css.section} id="untold" aria-label="Done but not yet told">
          <div className={css.sectionHead}><h2>Done, not yet told</h2><span className={css.muted}>{d.untoldCount}</span></div>
          <Untold entries={d.untold} audiences={d.audiences} count={d.untoldCount} />
        </section>
        {d.briefs.length > todays.length ? <section className={css.section} aria-label="Earlier briefs">
          <div className={css.sectionHead}><h2>Earlier briefs</h2></div>
          <div className={css.grid}>{d.briefs.filter((b) => b.day !== d.today).slice(0, 4).map((b) => <BriefCard key={b.id} brief={b} />)}</div>
        </section> : null}
      </> : null}
      {tab === "pipeline" ? pipe?.data ? <PipelineView o={pipe.data} /> : unavailable(pipe) : null}
      {tab === "ideas" ? ideas?.data && pipe?.data ? <IdeasView ideas={ideas.data.ideas} brands={pipe.data.brands} brand={brand} /> : unavailable(ideas) : null}
      {tab === "brands" ? pipe?.data ? <BrandsView o={pipe.data} /> : unavailable(pipe) : null}
      {tab === "report" ? reports?.data ? <ReportsView reports={reports.data.reports} currency={pipe?.data?.currency ?? "INR"} /> : unavailable(reports) : null}
      {tab === "story" ? story?.data ? <StoryBook months={story.data.months} today={d.today} /> : <Message text={story?.error ?? "The Story is unavailable."} /> : null}
      {tab === "drafts" ? <div className={css.stack}>
        {shown ? <DraftCard draft={shown} company={d.company} today={d.today} open /> : null}
        {drafts.filter((x) => x.id !== shown?.id).map((x) => <DraftCard key={x.id} draft={x} company={d.company} today={d.today} />)}
        {!drafts.length ? <p className={css.empty}>No drafts yet. On Today, pick what was done and an audience, and Pulse drafts the headline, the message, a long post and images.</p> : null}
      </div> : null}
      {tab === "calendar" ? <>
        <BrandFilter brands={pipe?.data?.brands ?? []} brand={brand} month={d.month} />
        <Calendar drafts={calendar} month={d.month} today={d.today} meta={metaById} />
      </> : null}
      {tab === "audiences" ? <Audiences audiences={d.audiences} /> : null}
      {tab === "team" ? <PrTeam agents={d.agents} hired={d.hired} me={d.me} /> : null}
    </div>
  </Page>;
}
