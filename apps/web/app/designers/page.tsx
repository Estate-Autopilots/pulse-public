import Link from "next/link";
import { ChevronLeft, ChevronRight, Palette } from "lucide-react";
import { api, apiV1, getMe, type DesignClaimsResponse } from "../lib/api";
import { canOpenDesignerDetails, designerRowsForViewer, hasDesignCounts } from "../lib/designers-view.mjs";
import { apiPeriod, count, currentIsoWeek, isoWeek, isoWeekLabel, isoWeekMonday, shiftDay, type PeriodParams } from "../lib/format";
import { ClaimsToConfirm } from "../delivery-claims";
import { Badge, Empty, Message, Page, PageHeader, Panel, styles } from "../ui";
import type { DesignDeliveryType, DesignerSummary, DesignersData } from "./types";
import { designTypeLabel, orderedDesignTypes } from "./type-labels";
import css from "./designers.module.css";
import { DesignersWhy } from "./why";

type WeekParams = Pick<PeriodParams, "week" | "period">;

function weekParams(query: PeriodParams): WeekParams {
  return query.week ? { week: query.week } : query.period === "last" ? { period: "last" } : {};
}

function WeekNavigation({ week, base }: { week: string; base: string }) {
  const monday = isoWeekMonday(week);
  const previous = isoWeek(shiftDay(monday, -7));
  const next = isoWeek(shiftDay(monday, 7));
  const current = currentIsoWeek();
  const title = isoWeekLabel(week);
  const canGoForward = week < current;
  const href = (key: string) => base + "?week=" + encodeURIComponent(key);
  return <nav className={css.weekNavigation} aria-label="Week navigation">
    <Link className={`${styles.btn} ${css.weekStep}`} href={href(previous)} aria-label="Previous week" title="Previous week"><ChevronLeft size={15} aria-hidden="true" /></Link>
    <span aria-label={title}>{title}</span>
    {canGoForward ? <Link className={`${styles.btn} ${css.weekStep}`} href={href(next)} aria-label="Next week" title="Next week"><ChevronRight size={15} aria-hidden="true" /></Link> : null}
  </nav>;
}

function countFor(types: Record<string, number>, type: string) {
  const value = types[type];
  return count(typeof value === "number" && Number.isFinite(value) ? value : 0);
}

function ConfirmedClaimNote({ designer, className }: { designer: DesignerSummary; className?: string }) {
  const total = Object.values(designer.claimed ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  return total > 0 ? <span className={className ?? styles.muted}>Includes {count(total)} confirmed {total === 1 ? "claim" : "claims"}</span> : null;
}

function DesignerName({ designer, viewer, role, week }: { designer: DesignerSummary; viewer: string | null; role: string; week: string }) {
  if (designer.sharedLogin) return <Badge>Shared login</Badge>;
  if (canOpenDesignerDetails(viewer, designer, role) && designer.personId) {
    return <Link className={styles.cellLink} href={"/designers/" + encodeURIComponent(designer.personId) + "?week=" + encodeURIComponent(week)}>{designer.name}</Link>;
  }
  return <span>{designer.name}</span>;
}

function DesignerCards({ designers, types, viewer, role, week }: {
  designers: DesignerSummary[];
  types: DesignDeliveryType[];
  viewer: string | null;
  role: string;
  week: string;
}) {
  return <section className={styles.cards + " " + css.mobileOnly} aria-label="Weekly design deliveries by person and type">
    {designers.map((designer) => <article className={styles.card} key={designer.personId ?? "shared-login"}>
      <h3 className={styles.rowTitle}><DesignerName designer={designer} viewer={viewer} role={role} week={week} /></h3>
      <ConfirmedClaimNote designer={designer} />
      {hasDesignCounts(designer.types) ? <dl className={css.metrics}>{types.map((type) => <div key={type}>
        <dt>{designTypeLabel(type)}</dt><dd>{countFor(designer.types, type)}</dd>
      </div>)}</dl> : <p className={styles.muted}>Nothing recorded this week</p>}
    </article>)}
  </section>;
}

export default async function Designers({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const query = await searchParams;
  const periodQuery = apiPeriod(weekParams(query));
  const [result, meResult] = await Promise.all([
    api<DesignersData>("designers" + periodQuery),
    getMe(),
  ]);
  if (result.error) return <Message text={result.error} />;
  if (meResult.error) return <Message text={meResult.error} />;
  if (!result.data || !meResult.data) return null;
  if (meResult.data.role === "hr" || meResult.data.role === "privacy") return <Message text="Design delivery data is not available for this account." />;

  const data = result.data;
  const canReviewClaims = ["admin", "manager"].includes(meResult.data.role);
  const designClaimsResult = canReviewClaims
    ? await apiV1<DesignClaimsResponse>(`/v1/designs/claims?week=${encodeURIComponent(data.week)}&status=pending`)
    : null;
  const viewer = meResult.data.person;
  const rows = designerRowsForViewer(data.designers ?? [], viewer, meResult.data.role)
    .sort((a, b) => Number(a.sharedLogin) - Number(b.sharedLogin) || a.name.localeCompare(b.name));
  const week = data.week;
  const title = isoWeekLabel(week);
  const header = <PageHeader title="Designers" context={["Weekly counts"]} actions={<WeekNavigation week={week} base="/designers" />} />;

  const types = orderedDesignTypes(rows.flatMap((designer) => Object.keys(designer.types ?? {})));
  const hasDeliveries = rows.some((designer) => hasDesignCounts(designer.types));
  return <Page fit>
    {header}
    {canReviewClaims ? <ClaimsToConfirm claims={designClaimsResult?.data?.claims ?? []} error={designClaimsResult?.error} subject="designers" /> : null}
    <Panel title="Deliveries by type" tools={<DesignersWhy />}>
      {hasDeliveries ? <>
        <div className={styles.tableWrap + " " + css.desktopOnly}>
          <table className={styles.table} aria-label="Weekly design deliveries by person and type">
            <thead><tr><th scope="col">Designer</th>{types.map((type) => <th scope="col" className={styles.right} key={type}>{designTypeLabel(type)}</th>)}</tr></thead>
            <tbody>{rows.map((designer) => <tr key={designer.personId ?? "shared-login"}>
              <th scope="row"><span className={styles.rowMain}><DesignerName designer={designer} viewer={viewer} role={meResult.data.role} week={week} /><ConfirmedClaimNote designer={designer} className={css.claimNote} /></span></th>
              {hasDesignCounts(designer.types)
                ? types.map((type) => <td key={type} className={`${styles.nowrap} ${styles.right}`}>{countFor(designer.types, type)}</td>)
                : <td colSpan={Math.max(1, types.length)} className={styles.muted}>Nothing recorded this week</td>}
            </tr>)}</tbody>
          </table>
        </div>
        <DesignerCards designers={rows} types={types} viewer={viewer} role={meResult.data.role} week={week} />
      </> : <Empty icon={Palette} first title="Not enough data yet"
        text="Pulse found no eligible design exports for this week. Weekly counts will appear when an export is available in Drive." />}
    </Panel>
  </Page>;
}
