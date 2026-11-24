import { api, apiV1, getMe, holdAtGate, insightsFor, type HomeData } from "../lib/api";
import { apiPeriod, type PeriodParams } from "../lib/format";
import { cookies, headers } from "next/headers";
import { requestHost } from "../lib/host-mode.mjs";
import { platformBrand } from "../lib/host-families.mjs";
import { loadCalm } from "../home/load";
import { CalmHome } from "../home/view";
import { ModeSwitch } from "../home/mode";
import { homeMode } from "../home/focus";
import homeCss from "../home/home.module.css";
import { EditorHome, HrHome } from "../home-views";
import { WELCOME_COOKIE } from "../welcome-cookie";
import { LeadView } from "../research/views";
import type { LeadData } from "../research/types";
import { Message, Page, PageHeader, QueryTabs } from "../ui";
import { LeadershipDashboard } from "./leadership";
import { SalesHome } from "./sales-home";
import { readBrand } from "../lib/brand-server";
import { WaitingHome } from "../sops/waiting-home";
import type { WaitingItem } from "../sops/board-types";
import type { MyStep } from "../processes/flow-types";
import { UpdatesHomeCard } from "../updates/home-card";
import { newestUpdate } from "../updates/data";
import { RoleHome, type RoleHomeData } from "../processes/role-home";
import { WhatsNewPanel } from "../home/whats-new";
import { LeadPulse } from "../home/lead-pulse";
import { whatsNewItems } from "../lib/whats-new-server";
import { WHATS_NEW_COOKIE, WHATS_NEW_ID } from "../lib/whats-new.mjs";
import { FirstRunCard } from "../start/first-run-card";
import { ResumeDrafts } from "../resume-drafts";
import { QuoteFollowUps } from "../quote-follow-ups";
import { Suspense } from "react";
import { AcrossHome, type HomeCompanies } from "./across";
import type { DayData } from "../lib/my-day.mjs";
import type { FounderData } from "../lib/founder.mjs";

export default async function Dashboard({ searchParams }: { searchParams: Promise<PeriodParams & { tab?: string; view?: string; welcome?: string; classic?: string; mode?: string }> }) {
  const params = await searchParams;
  // STAFF-UX: held at the profile gate, nothing here is asked for (it all answered 403 profile_incomplete).
  await holdAtGate();
  if(params.tab==='research'){const r=await api<LeadData>('research');if(r.error||!r.data)return <Message text={r.error??'Lead observations unavailable'}/>;return <Page fit><PageHeader title="Dashboard" context={['Lead outcomes and observed pipe notices']}/><QueryTabs base="/dashboard" current="research" items={[{key:'overview',label:'Overview'},{key:'research',label:'Leads & pipes'}]}/><LeadView d={r.data}/></Page>;}
  // EST-1241: a role the organisation gave the sales home lands there (Settings → Modules → Screens and menu).
  // FLOW-E: the tiles of each work role the person holds (Settings → Industry & roles), with their steps from every process.
  // VISIBLE (owner, 25 Oct 2026): the last update's features on every Home until closed; leadership's clients-and-groups cards.
  const seenNews = (await cookies()).get(WHATS_NEW_COOKIE)?.value === WHATS_NEW_ID;
  // KAZUK-GAPS (A12): unfinished quotations, invoices and forms, from any device, first on every home (nothing when none).
  const product = platformBrand(requestHost(await headers()))?.product; // VITALS-SHIP: "Learn Vitals OS" on Vitals OS
  const news = (viewer: Parameters<typeof whatsNewItems>[0]) => { const items = seenNews ? [] : whatsNewItems(viewer, product); return <>{/* ONBOARD-SELF: a self-started company's getting-started guide */}<FirstRunCard /><Suspense fallback={null}><ResumeDrafts /></Suspense><Suspense fallback={null}><QuoteFollowUps /></Suspense>{items.length ? <WhatsNewPanel items={items} /> : null}</>; };
  // CONNECTIONS part A (owner, 16 Nov 2026: "the dashboard looks very ugly, has no purpose"): in a person's own personal
  // space the home is every company they are in: today's work, who waits on them, money, and who they work with.
  if (!params.tab && !params.view) { const viewer = (await getMe()).data; const here = viewer?.account?.orgs?.find((o) => o.current);
    if (viewer?.person && !viewer.mustChange && (here?.orgKind === "personal" || here?.mine)) return <AcrossHome data={await loadAcross(viewer.name)} />; }
  if (!params.tab) { const viewer = (await getMe()).data; if (viewer?.home === "sales" && viewer.person && !viewer.mustChange) { const roles = viewer.workRoles?.length ? (await apiV1<RoleHomeData>("/v1/flow/home")).data : null;
    return <SalesHome me={viewer} top={<>{news(viewer)}<UpdatesHomeCard /><RoleHome data={roles} compact /></>} hasUpdates={!!await newestUpdate()} />; } }
  // VITALS-SWEEP (speed): someone who is not leadership or HR gets the editor home, which then read their own tasks and
  // approval counts only after the home came back (a second round trip, tasks/home p50 0.37 s in production). The
  // signed-in person is already known here (the gate read it), so those reads start with the home read; if the home
  // turns out not to be the editor one they are simply not used, and the editor home still reads them if they were not
  // started.
  const known = (await getMe()).data, knownOff = known?.modules?.off ?? [];
  const editorGuess = !!known?.person && !known.mustChange && !["admin", "leadership", "hr"].includes(known.role ?? "") && !known.lead;
  const tasksEarly = editorGuess && !knownOff.includes("tasks") ? api<{ rows: { id: string; title: string; status: string; dueOn: string | null }[]; today: string }>("tasks/home") : null;
  const approvalsEarly = editorGuess && (known?.role === "pgs" || known?.role === "manager") && !knownOff.includes("hr") ? api<{ attendanceEnabled: boolean; leave: number; regularisations: number }>("hr/self/approvals") : null;
  const [result, insights, me, waiting, mine] = await Promise.all([api<HomeData>(`home${apiPeriod(params)}`), insightsFor(`insights${apiPeriod(params)}`), getMe(), api<{ items: WaitingItem[] }>("workflows/waiting"),
    apiV1<RoleHomeData & { steps: MyStep[] }>("/v1/flow/home")]);
  // WORKFLOW BUILDER: the workflow blocks that wait for this person, at the top of the home (nothing when none wait).
  const leads = !!me.data?.person && (me.data.role === "admin" || me.data.role === "leadership" || !!me.data.lead);
  const wait = <>{news(me.data)}<UpdatesHomeCard /><RoleHome data={mine.data} /><WaitingHome items={waiting.data?.items ?? []} steps={mine.data?.steps ?? []} /></>;
  if (result.error) return <Message text={result.error} />;
  const data = result.data; if (!data) return null;
  // Panels of a switched-off module are left out (EST-648); its API would answer 404.
  const off = me.data?.modules?.off ?? [];
  // FLOW-E: someone in HR who also holds a work role (two hats) sees that role's tiles on their HR home too.
  if (data.view === "hr") return <HrHome data={data} off={off} top={<>{leads ? <LeadPulse /> : null}{news(me.data)}<UpdatesHomeCard /><RoleHome data={mine.data} /></>} />;
  if (data.view === "editor") {
    // A PGS or manager decides their team's leave and corrections: the home says when something is waiting.
    // SPEED-TELEMETRY (14 Nov 2026): two numbers (hr/self/approvals), not the whole of My desk (hr/self, 0.6-3.1 s in
    // production), asked for at the same time as the person's tasks instead of one after the other.
    // UX-5A: the getting-started list's state rides in a cookie too, so the server draws what the browser will show.
    // QA-1024 (R085): the home leads with the person's own tasks (Work's own list; nothing when tasks are switched off).
    const [waitingCount, tasksResult] = await Promise.all([
      (data.role === "pgs" || data.role === "manager") && !off.includes("hr") ? approvalsEarly ?? api<{ attendanceEnabled: boolean; leave: number; regularisations: number }>("hr/self/approvals") : null,
      me.data?.person && !off.includes("tasks") ? tasksEarly ?? api<{ rows: { id: string; title: string; status: string; dueOn: string | null }[]; today: string }>("tasks/home") : null,
    ]);
    const counted = waitingCount?.data;
    const approvals = counted ? counted.leave + (counted.attendanceEnabled === true ? counted.regularisations : 0) : 0;
    const tasks = tasksResult?.data ?? null;
    return <EditorHome data={data} me={me.data} welcome={params.welcome === "1"} approvals={approvals} off={off} welcomeState={(await cookies()).get(WELCOME_COOKIE)?.value ?? null} top={wait} tasks={tasks} />;
  }
  // OWNER-HOME: leadership chooses Focus (the calm, ranked home) or Max (every panel); the choice rides in a cookie.
  const mode = homeMode(params, (await cookies()).get("pulse.home.mode")?.value);
  // Max shares the calm shell; explicit tabs/views keep every existing deeper dashboard.
  if (!params.tab && !params.view) return <CalmHome {...await loadCalm({ home: data, insights: insights.data ?? null, max: mode === "max" })} extra={<>{leads ? <LeadPulse /> : null}{news(me.data)}</>} />;
  if (insights.error || !insights.data) return <Message text={insights.error ?? "This view is unavailable."} />;
  // UX-TENANT: the company's own code names "all accounts"; a company that switched finance off has no Finance tab.
  const leadershipOff = me.data?.companyModules?.finance === false && !off.includes("money") ? [...off, "money"] : off;
  return <LeadershipDashboard data={data} insights={insights.data} tab={params.tab} view={params.view} scope={await (async () => { const code = (await readBrand())?.code; return code ? `All ${code} accounts` : "All company accounts"; })()} off={leadershipOff} top={<>{wait}{leads ? <LeadPulse /> : null}<div className={homeCss.maxBar}><ModeSwitch mode="max" /></div></>} />;
}

/** CONNECTIONS: the home across companies reads My day, All my companies, the person's agreements and their companies,
 *  each across every seat in its own organisation (services/api: my-day.ts, founder.ts, contracts.ts, home-across.ts). */
async function loadAcross(name: string | null) {
  const [day, founder, contracts, companies] = await Promise.all([api<DayData>("tasks/my-day"), api<FounderData>("founder"),
    api<{ mine: { key: string; canAccept: boolean; title: string; heldBy: string | null; parties?: { name: string; mine: boolean }[] }[] }>("contracts/mine"), api<HomeCompanies>("home/companies")]);
  const zone = day.data?.seats.find((s) => s.timeZone)?.timeZone ?? "Asia/Kolkata";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: zone }).format(new Date())) % 24;
  return { name, hour, day: day.data ?? null, founder: founder.data ?? null, contracts: contracts.data?.mine ?? null, companies: companies.data ?? null };
}
