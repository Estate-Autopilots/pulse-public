import type { ReactNode } from "react";
import type { HomeData, Insights } from "../lib/api";
import { count, periodQuery } from "../lib/format";
import { FeedPanel, Header, PeopleCount, TeamDayPanel, TopProjects, TrendPanel, WorkTiles } from "../home-views";
import { AttendancePanel, AttentionPanel, ClientsPanel, IdentityPanel, LocationsPanel, MixPanel, MoneyState, PipelinePanel, PodsPanel, ReadinessPanel, SegmentsPanel, TeamsPanel } from "../insights";
import { Deck } from "../fit";
import { Fit, Kpi, Page, QueryTabs } from "../ui";
import d from "./dash.module.css";

type Leadership = Extract<HomeData, { view: "leadership" }>;
const TABS = [{ key: "overview", label: "Overview" }, { key: "delivery", label: "Delivery" }, { key: "people", label: "People" }, { key: "money", label: "Finance" }, { key: "research", label: "Leads & pipes" }];
const DELIVERY = [{ key: "activity", label: "Activity" }, { key: "mix", label: "Creative mix" }, { key: "markets", label: "Markets" }];
const PEOPLE = [{ key: "today", label: "Today" }, { key: "teams", label: "Pods & teams" }, { key: "tracking", label: "Tracking" }];

/** `off`: the organisation's switched-off modules. HR off leaves out attendance and People → Today; Money off leaves
 *  out the Finance tab. `scope` names "all accounts" by the company's own code (UX-TENANT). */
export function LeadershipDashboard({ data, insights, tab, view, scope = "All accounts", off = [], top }: { data: Leadership; insights: Insights; tab?: string; view?: string; scope?: string; off?: readonly string[]; top?: ReactNode }) {
  const attendance = !off.includes("hr") && insights.attendanceEnabled === true;
  const tabs = off.includes("money") ? TABS.filter((t) => t.key !== "money") : TABS;
  const people = off.includes("hr") ? PEOPLE.filter((t) => t.key !== "today") : PEOPLE;
  const pq = periodQuery(data.period); const current = tabs.find((t) => t.key === tab)?.key ?? "overview";
  const projectsHref = `/projects${periodQuery(data.period, { show: "active" })}`; const p = insights.people;
  const subs = current === "people" ? people : DELIVERY; const sub = subs.find((t) => t.key === view)?.key ?? subs[0].key;
  return <Page fit>
    <Header data={data} scope={scope} />
    {top}
    {current === "overview" ? <Deck tall={960} head={<QueryTabs base="/dashboard" items={tabs} current={current} keep={pq.slice(1)} />}
      views={[
        { label: "This week", content: <><section className={d.kpis} data-n={6} aria-label="Key numbers">
        <WorkTiles data={data} deliveriesHref={`/dashboard${periodQuery(data.period, { tab: "delivery" })}`} projectsHref={projectsHref} quietHref="/projects?show=quiet" />
        <Kpi label="Active clients" value={count(insights.portfolio.activeClients)} href="/clients" note={`${count(insights.portfolio.activeClientsBefore)} in the 8 weeks before`} />
        <Kpi label="Team" value={<PeopleCount headcount={p.headcount} ai={p.ai} />} href={attendance ? "/hr" : "/people"} note={attendance ? `${p.inToday} in today · ${p.onLeave} on leave` : "Human and AI employees"} />
      </section><Fit className={d.pair}><TrendPanel data={data} hrefFor={(week) => `/dashboard?week=${week}`} fill /><AttentionPanel data={insights} issuesOnly /></Fit></> },
        { label: "Pipeline & clients", content: <Fit className={d.trio}><PipelinePanel data={insights} /><ClientsPanel data={insights} /><AttentionPanel data={insights} quietOnly /></Fit> },
      ]} /> : <QueryTabs base="/dashboard" items={tabs} current={current} keep={pq.slice(1)} />}
    {current === "delivery" || current === "people" ? <div className={d.sub}>
      <QueryTabs base="/dashboard" items={subs} current={sub} keep={[pq.slice(1), `tab=${current}`].filter(Boolean).join("&")} param="view" sub />
      <span className={d.subNote}>{current === "delivery" ? "Delivery signals from real files" : attendance ? "Attendance, teams and attribution" : "People, teams and attribution"}</span>
    </div> : null}
    {current === "delivery" ? <Fit className={sub === "activity" ? d.pair : d.pairEven}>
      {sub === "activity" ? <><FeedPanel data={data} href={projectsHref} fill /><TopProjects data={data} href={projectsHref} fill /></> : null}
      {sub === "mix" ? <><MixPanel data={insights} /><IdentityPanel data={insights} /></> : null}
      {sub === "markets" ? <><SegmentsPanel data={insights} /><LocationsPanel data={insights} /></> : null}
    </Fit> : null}
    {current === "people" ? <Fit className={d.pairEven}>
      {sub === "today" ? <><AttendancePanel data={insights} /><TeamDayPanel data={data} viewerPerson={data.viewer.person} decide fill /></> : null}
      {sub === "teams" ? <><PodsPanel data={insights} /><TeamsPanel data={insights} /></> : null}
      {sub === "tracking" ? <><IdentityPanel data={insights} /><ReadinessPanel data={insights} /></> : null}
    </Fit> : null}
    {current === "money" ? <Fit className={d.pairEven}><MoneyState /></Fit> : null}
  </Page>;
}
