import { api, apiV1, getMe, type EditorData, type EditorWeekResponse } from "../../../lib/api";
import { apiPeriod, count, isoWeek, longDay, periodLabel, periodQuery, range, type PeriodParams } from "../../../lib/format";
import { PeriodSwitcher } from "../../../period-switcher";
import { Badge, Kpi, Message, Page, PageHeader, Panel, Tiles, WeekChart, Why, styles, Workspace } from "../../../ui";
import { DeliveriesPanel, ProjectsPanel } from "../../../weekly-views";
import { EditorTargetTable } from "../editor-target-table";
import { editorTargetsFromWeek } from "../targets";

export default async function Editor({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<PeriodParams> }) {
  const account = decodeURIComponent((await params).account);
  const query = await searchParams;
  const [r, viewerResult] = await Promise.all([
    api<EditorData>(`editors/${encodeURIComponent(account)}${apiPeriod(query)}`),
    getMe(),
  ]);
  if (r.error) return <Message text={r.error} />; const d = r.data; if (!d) return null;
  const viewer = viewerResult.data ?? null;
  const targetWeek = d.period.week ?? isoWeek(d.period.from);
  const targetResult = d.holder_person_id && !d.sharedLogin
    ? await apiV1<EditorWeekResponse>(`/v1/editors/${encodeURIComponent(d.holder_person_id)}/week?week=${encodeURIComponent(targetWeek)}`)
    : null;
  const targetResponse = targetResult && "data" in targetResult ? targetResult.data ?? null : null;
  const max = Math.max(1, ...d.days.map((x) => x.deliveries)); const base = `/people/accounts/${encodeURIComponent(account)}`;
  return (
    <Page fit>
      <PageHeader title={d.account} back={{ href: `/people${periodQuery(d.period, { tab: "tracking", view: "accounts" })}`, label: "Tracking" }} recent={{ kind: "editor" }}
        context={[<Badge key="id" tone={d.identityVerified && !d.sharedLogin ? "success" : "neutral"}>{d.sharedLogin ? "Shared login · individual editor unverified" : d.identityVerified ? "Verified account" : "Individual editor unverified"}</Badge>, `${periodLabel(d.period)}, ${range(d.period.from, d.period.to)}`]}
        actions={<PeriodSwitcher period={d.period} />} />
      <EditorTargetTable account={d.account} period={d.period} breakdownWeek={targetResponse?.week ?? null} targets={editorTargetsFromWeek(targetResponse)} totals={{ delivered: d.deliveries.value, drafts: d.drafts, finals: d.finals }} sharedLogin={d.sharedLogin} />
      <Tiles count={4}>
        <Kpi label="Deliveries" value={count(d.deliveries.value)} note={d.usual ? `Usual ${d.usual.toFixed(1)} a week` : "None yet"} spark={<Why detail={d.deliveries.why.detail} />} />
        <Kpi label="Drafts / finals" value={`${count(d.drafts)} / ${count(d.finals)}`} note="From delivery folder names" />
        <Kpi label="Projects delivering" value={count(d.projects.length)} note={periodLabel(d.period)} />
        <Kpi label="Turnaround" value="—" note="Unavailable" spark={<Why detail={d.turnaroundDetail} />} />
      </Tiles>
      <Workspace>
        <Panel title="Deliveries per week" sub="Last 12 weeks" className={styles.span2}
          tools={<Why detail="Counts are by latest indexed modification in Asia/Kolkata. Repeated index observations do not add duplicate deliveries." />}>
          <WeekChart weeks={d.weeks} period={d.period} hrefFor={(week) => `${base}?week=${week}`} />
        </Panel>
        <Panel title="Deliveries per day" sub="Days with output">
          <div className={styles.tableWrap}><table className={styles.table}>
            <thead><tr><th>Day</th><th>Deliveries</th><th className={styles.right}>Drafts</th><th className={styles.right}>Finals</th></tr></thead>
            <tbody>{d.days.map((x) => <tr key={x.day}><td className={styles.nowrap}>{longDay(x.day)}</td><td className={`${styles.nowrap} ${styles.num}`}><span className={styles.cellBar}><i style={{ width: `${(x.deliveries / max) * 100}%` }} /></span>{x.deliveries}</td><td className={styles.right}>{x.drafts}</td><td className={styles.right}>{x.finals}</td></tr>)}</tbody>
          </table></div>
        </Panel>
        <DeliveriesPanel data={d} className={styles.span2} showCreditHowFor={viewer?.person && viewer.person === d.holder_person_id ? viewer.person : null} />
        <ProjectsPanel data={d} />
      </Workspace>
    </Page>
  );
}
