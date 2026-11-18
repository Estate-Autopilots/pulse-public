import { Badge, Panel, styles, Why } from "../../ui";
import { isSevenDayPeriod, periodLabel, range } from "../../lib/format";
import type { Period } from "../../lib/api";
import editorStyles from "./editors.module.css";
import { editorTargetSummary, editorTargetTotal, type EditorTarget } from "./targets";

export type EditorTargetTotals = {
  delivered: number;
  drafts: number;
  finals: number;
};

const deliveryExplanation =
  "Targets and placeholder flags come from the weekly API. Delivered totals follow the selected period. The total gap is only calculated for an exact 7-day selection with a target for every type; type-level delivery counts appear only when the API week matches the selected ISO week.";

export function EditorTargetTable({
  account,
  period,
  breakdownWeek,
  targets,
  totals,
  sharedLogin = false,
}: {
  account: string;
  period: Period;
  breakdownWeek: string | null;
  targets: readonly EditorTarget[];
  totals: EditorTargetTotals;
  sharedLogin?: boolean;
}) {
  const targetTotal = editorTargetTotal(targets);
  const compareWeeklyTarget = isSevenDayPeriod(period);
  const selectedPeriod = `${periodLabel(period)} · ${range(period.from, period.to)}`;
  const showTypeBreakdown = Boolean(period.week && breakdownWeek === period.week);
  const weeklyDelivered = targets.reduce((sum, target) => sum + target.delivered.drafts + target.delivered.finals, 0);
  const weeklyDrafts = targets.reduce((sum, target) => sum + target.delivered.drafts, 0);
  const weeklyFinals = targets.reduce((sum, target) => sum + target.delivered.finals, 0);
  const deliveredTotal = showTypeBreakdown ? weeklyDelivered : totals.delivered;
  const deliveredDrafts = showTypeBreakdown ? weeklyDrafts : totals.drafts;
  const deliveredFinals = showTypeBreakdown ? weeklyFinals : totals.finals;
  const gapTotal = targets.length > 0 && targetTotal.unconfigured === 0
    ? Math.max(0, targetTotal.value - deliveredTotal) : null;
  const totalGap = compareWeeklyTarget && gapTotal !== null ? gapTotal : "—";

  return (
    <Panel title="Weekly targets by creative type" sub={selectedPeriod} tools={<Why detail={deliveryExplanation} />}>
      <div className={editorStyles.desktopOnly}><div className={styles.tableWrap}><table className={styles.table} aria-label={`${account} target, delivered, and gap by creative type`}>
        <thead>
          <tr>
            <th scope="col">Creative type</th>
            <th scope="col">Target / week</th>
            <th scope="col">Delivered · selected period (draft / final)</th>
            <th scope="col">Gap · 7 days</th>
          </tr>
        </thead>
        <tbody>
          {sharedLogin ? <tr>
            <th scope="row">All types</th>
            <td>Shared login · no personal target</td>
            <td>{deliveredTotal} · {deliveredDrafts} drafts / {deliveredFinals} finals</td>
            <td>—</td>
          </tr> : targets.length ? targets.map((target) => (
            <tr key={target.type}>
              <th scope="row">{target.label}</th>
              <td>{target.perWeek === null ? "Not set" : `${target.perWeek} / week`} {target.placeholder && <> <Badge>placeholder target</Badge></>}</td>
              <td aria-label={showTypeBreakdown ? `${target.label} delivery count from API` : `${target.label} delivery count not reported for this period`}>
                {showTypeBreakdown ? <>{target.delivered.drafts + target.delivered.finals} · {target.delivered.drafts} drafts / {target.delivered.finals} finals
                  {target.claimed.drafts + target.claimed.finals > 0 ? <> <Badge>confirmed claim · {target.claimed.drafts + target.claimed.finals}</Badge></> : null}</> : "—"}
              </td>
              <td aria-label={showTypeBreakdown && target.gap !== null ? `${target.label} gap from API` : `${target.label} gap not reported for this period`}>
                {showTypeBreakdown && target.gap !== null ? target.gap : "—"}
              </td>
            </tr>
          )) : <tr><td colSpan={4}>Weekly targets unavailable</td></tr>}
          {!sharedLogin && <tr>
            <th scope="row">All types · API total</th>
            <td>{editorTargetSummary(targets)}</td>
            <td>{deliveredTotal} · {deliveredDrafts} drafts / {deliveredFinals} finals</td>
            <td>{totalGap}</td>
          </tr>}
        </tbody>
      </table></div></div>
      <section className={`${styles.cards} ${editorStyles.mobileOnly}`} aria-label={`${account} weekly targets by creative type`}>
        {sharedLogin ? <article className={styles.card}>
          <strong>Shared login · no personal target</strong>
          <dl className={editorStyles.metrics}>
            <div><dt>Target / week</dt><dd>—</dd></div>
            <div><dt>Delivered</dt><dd>{deliveredTotal}<span className={styles.muted}>{deliveredDrafts} drafts / {deliveredFinals} finals</span></dd></div>
            <div><dt>Gap · 7 days</dt><dd>—</dd></div>
          </dl>
        </article> : targets.map((target) => (
          <article key={target.type} className={styles.card}>
            <div className={styles.rowMeta}><strong>{target.label}</strong>{target.placeholder && <Badge>placeholder target</Badge>}</div>
            <dl className={editorStyles.metrics}>
              <div><dt>Target / week</dt><dd>{target.perWeek === null ? "Not set" : target.perWeek}</dd></div>
              <div><dt>Delivered</dt><dd className={styles.muted}>{showTypeBreakdown ? <>{target.delivered.drafts + target.delivered.finals} · {target.delivered.drafts} drafts / {target.delivered.finals} finals
                {target.claimed.drafts + target.claimed.finals > 0 ? <Badge>confirmed claim · {target.claimed.drafts + target.claimed.finals}</Badge> : null}</> : "Not reported for this period"}</dd></div>
              <div><dt>Gap</dt><dd className={styles.muted}>{showTypeBreakdown && target.gap !== null ? target.gap : "Not reported for this period"}</dd></div>
            </dl>
          </article>
        ))}
        {!sharedLogin && <article className={styles.card}>
          <strong>All types · API total</strong>
          <dl className={editorStyles.metrics}>
            <div><dt>Target / week</dt><dd>{editorTargetSummary(targets)}</dd></div>
            <div><dt>Delivered</dt><dd>{deliveredTotal}<span className={styles.muted}>{deliveredDrafts} drafts / {deliveredFinals} finals</span></dd></div>
            <div><dt>Gap · 7 days</dt><dd>{totalGap}</dd></div>
          </dl>
        </article>}
      </section>
      <p className={styles.panelFoot}>Targets and available type breakdowns come from the weekly API. Type-level delivered and gap cells appear only when that API week matches the selected ISO week; the total row continues to follow the selected period.</p>
      {deliveredTotal === 0 && <p className={styles.panelFoot}>No deliveries are recorded for this uploader in the selected period.</p>}
    </Panel>
  );
}
