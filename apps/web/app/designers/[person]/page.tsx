import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, Palette } from "lucide-react";
import { api, getMe } from "../../lib/api";
import { DESIGNER_DETAIL_ROLES, designerWeeklyTotals, hasDesignCounts } from "../../lib/designers-view.mjs";
import { apiPeriod, count, currentIsoWeek, isoWeek, isoWeekLabel, isoWeekMonday, longDay, shiftDay, type PeriodParams } from "../../lib/format";
import { Empty, Message, Page, PageHeader, Panel, styles } from "../../ui";
import type { DesignDeliveryType, DesignerDay, DesignerProfileData } from "../types";
import { designTypeLabel, orderedDesignTypes } from "../type-labels";
import css from "../designers.module.css";
import { DesignersWhy } from "../why";

type WeekParams = Pick<PeriodParams, "week" | "period">;

function weekParams(query: PeriodParams): WeekParams {
  return query.week ? { week: query.week } : query.period === "last" ? { period: "last" } : {};
}

function weekHref(person: string, week: string) {
  return "/designers/" + encodeURIComponent(person) + "?week=" + encodeURIComponent(week);
}

function WeekNavigation({ week, person }: { week: string; person: string }) {
  const monday = isoWeekMonday(week);
  const previous = isoWeek(shiftDay(monday, -7));
  const next = isoWeek(shiftDay(monday, 7));
  const current = currentIsoWeek();
  const canGoForward = week < current;
  const title = isoWeekLabel(week);
  return <nav className={css.weekNavigation} aria-label="Week navigation">
    <Link className={styles.btn} href={weekHref(person, previous)}><ChevronLeft size={14} aria-hidden="true" />Previous week</Link>
    <span>{title}</span>
    {canGoForward ? <Link className={styles.btn} href={weekHref(person, next)}>Next week<ChevronRight size={14} aria-hidden="true" /></Link> : null}
  </nav>;
}

function countFor(types: Record<string, number>, type: string) {
  const value = types[type];
  return count(typeof value === "number" && Number.isFinite(value) ? value : 0);
}

function DayCards({ days, types }: { days: DesignerDay[]; types: DesignDeliveryType[] }) {
  return <section className={styles.cards + " " + css.mobileOnly} aria-label="Daily design deliveries">
    {days.map((day) => <article className={styles.card} key={day.day}>
      <h3 className={styles.rowTitle}>{longDay(day.day)}</h3>
      <dl className={css.metrics}>{types.map((type) => <div key={type}>
        <dt>{designTypeLabel(type)}</dt><dd>{countFor(day.types, type)}</dd>
      </div>)}</dl>
    </article>)}
  </section>;
}

export default async function DesignerDetail({ params, searchParams }: {
  params: Promise<{ person: string }>;
  searchParams: Promise<PeriodParams>;
}) {
  const [{ person }, query] = await Promise.all([params, searchParams]);
  const meResult = await getMe();
  if (meResult.error) return <Message text={meResult.error} />;
  if (!meResult.data) return null;
  if (!DESIGNER_DETAIL_ROLES.has(meResult.data.role) || !meResult.data.person || meResult.data.person !== person) {
    return <Page><PageHeader title="Designers" back={{ href: "/designers", label: "Designers" }} />
      <section className={styles.panel}><Empty icon={Palette} first title="Daily detail is private"
        text="Only the person can open their own daily design counts. Weekly team totals stay on the Designers view." /></section>
    </Page>;
  }

  const result = await api<DesignerProfileData>("designers/" + encodeURIComponent(person) + apiPeriod(weekParams(query)));
  if (result.error) return <Message text={result.error} />;
  if (!result.data) return null;
  const data = result.data;
  const title = isoWeekLabel(data.week);
  const days = data.days;
  const weeklyTypes = designerWeeklyTotals(days);
  const types = orderedDesignTypes(Object.keys(days[0]?.types ?? weeklyTypes));
  const hasDeliveries = hasDesignCounts(weeklyTypes);
  const header = <PageHeader title="Your design deliveries" back={{ href: "/designers", label: "Designers" }}
    context={[title, "Your daily detail"]} actions={<WeekNavigation week={data.week} person={person} />} />;
  if (!hasDeliveries) return <Page fit>
    {header}
    <Panel title="Weekly totals by type" sub={title} tools={<DesignersWhy />}>
      <Empty icon={CalendarDays} first title="Not enough data yet"
        text="Pulse found no eligible design exports for this week. Counts will appear when an export is available in Drive." />
    </Panel>
  </Page>;
  return <Page fit>
    {header}
    <Panel title="Weekly totals by type" sub={title} tools={<DesignersWhy />}>
      <div className={styles.tableWrap + " " + css.desktopOnly}>
        <table className={styles.table} aria-label="Your weekly design deliveries by type">
          <thead><tr><th scope="col">Design type</th><th scope="col" className={styles.right}>Delivered</th></tr></thead>
          <tbody>{types.map((type) => <tr key={type}><th scope="row">{designTypeLabel(type)}</th><td className={styles.right}>{countFor(weeklyTypes, type)}</td></tr>)}</tbody>
        </table>
      </div>
      <section className={styles.cards + " " + css.mobileOnly} aria-label="Your weekly design deliveries by type">
        {types.map((type) => <article className={styles.card} key={type}>
          <h3 className={styles.rowTitle}>{designTypeLabel(type)}</h3><p>{countFor(weeklyTypes, type)} delivered</p>
        </article>)}
      </section>
    </Panel>
    <Panel title="Daily totals by type" sub="Visible only to you">
        <div className={styles.tableWrap + " " + css.desktopOnly}>
          <table className={styles.table} aria-label="Your daily design deliveries">
            <thead><tr><th scope="col">Day</th>{types.map((type) => <th scope="col" className={styles.right} key={type}>{designTypeLabel(type)}</th>)}</tr></thead>
            <tbody>{days.map((day) => <tr key={day.day}><th scope="row" className={styles.nowrap}>{longDay(day.day)}</th>
              {types.map((type) => <td key={type} className={styles.right}>{countFor(day.types, type)}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        <DayCards days={days} types={types} />
    </Panel>
  </Page>;
}
