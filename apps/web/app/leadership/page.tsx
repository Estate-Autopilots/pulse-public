import { GrowthView, LeadView } from "../research/views";
import type { GrowthData, LeadData } from "../research/types";
import { api, getMe, type HomeData, type Insights } from "../lib/api";
import { apiPeriod, type PeriodParams } from "../lib/format";
import { PerformanceSignals } from "../people/performance";
import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Empty, Message, Page, PageHeader, QueryTabs, styles } from "../ui";
import { LeadershipView, PEOPLE_VIEWS, TABS } from "./view";
import { SeatComparison, SeatList, type Seat, type SeatCompare } from "./seats";
import { StaffingGaps, type Gaps } from "./staffing";
import { ValueBoard, type ValueData } from "./value";

export default async function Leadership({ searchParams }: { searchParams: Promise<PeriodParams & { tab?: string; view?: string; month?: string; band?: string; seat?: string }> }) {
  const params = await searchParams;
  // LIFECYCLE: People → Value (founders and HR with the salary permission), Seats and Staffing gaps.
  if (params.tab === "people" && ["value", "seats", "staffing"].includes(params.view ?? "")) {
    const view = params.view!;
    const locked = (text: string) => <section className={styles.panel}><Empty icon={Lock} first title="Not available to this account" text={text} /></section>;
    let body: ReactNode;
    if (view === "value") {
      const r = await api<ValueData>(`value${/^\d{4}-\d{2}$/.test(params.month ?? "") ? `?month=${params.month}` : ""}`);
      body = r.data ? <ValueBoard data={r.data} base="/leadership?tab=people&view=value" band={params.band} /> : locked(r.status === 403 ? "Value against cost reads like salaries: HR and leadership, or an admin given the salary permission. Nothing was read and nothing was logged." : r.error ?? "Unavailable");
    } else if (view === "seats" && params.seat) {
      const r = await api<SeatCompare>(`seats/${encodeURIComponent(params.seat)}`);
      body = r.data ? <SeatComparison data={r.data} back="/leadership?tab=people&view=seats" /> : <Message text={r.error ?? "Seat unavailable"} />;
    } else if (view === "seats") {
      const r = await api<{ seats: Seat[] }>("seats");
      body = r.data ? <SeatList seats={r.data.seats} base="/leadership?tab=people&view=seats" /> : locked(r.error ?? "Seats are for leadership.");
    } else {
      const r = await api<Gaps>("staffing-gaps");
      body = r.data ? <StaffingGaps data={r.data} seatsHref="/leadership?tab=people&view=seats" /> : locked(r.error ?? "Staffing gaps are for leadership and HR.");
    }
    const context = { value: "Value to the company against cost · founders and HR", seats: "Who held each role seat, compared by tenure month", staffing: "Where staffing is thin" }[view];
    return <Page fit><PageHeader title="Leadership" context={[context!]} /><QueryTabs base="/leadership" current="people" items={TABS} />
      <QueryTabs base="/leadership" keep="tab=people" param="view" sub current={view} items={PEOPLE_VIEWS} />{body}</Page>;
  }
  if(['growth','pipeline','outcomes'].includes(params.tab??'')){
    const r=params.tab==='outcomes'?await api<LeadData>('research'):await api<GrowthData>('research/growth');
    if(r.error||!r.data)return <Message text={r.error??'Research observations unavailable'}/>;
    return <Page fit><PageHeader title="Leadership" context={['Growth and recorded outcomes']}/><QueryTabs base="/leadership" current={params.tab!} items={TABS}/>{params.tab==='outcomes'?<LeadView d={r.data as LeadData}/>:<GrowthView d={r.data as GrowthData} pipeline={params.tab==='pipeline'}/>}</Page>;
  }
  if(params.tab==='performance')return <Page fit><PageHeader title="Leadership" context={['Recorded work, by pod and person']}/><QueryTabs base="/leadership" current="performance" items={TABS}/><PerformanceSignals company/></Page>;
  const [home, insights, me] = await Promise.all([api<HomeData>(`home${apiPeriod(params)}`), api<Insights>(`insights${apiPeriod(params)}`), getMe()]);
  if (insights.error || !insights.data) return <Message text={insights.error ?? "This view is unavailable."} />;
  if (home.error || !home.data || home.data.view !== "leadership") return <Message text={home.error ?? "Leadership is for organisation admins."} />;
  return <LeadershipView data={home.data} insights={insights.data} tab={params.tab} orgName={me.data?.orgName ?? "Pulse"} />;
}
