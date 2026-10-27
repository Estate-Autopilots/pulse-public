import { ArrowUpRight, ListChecks } from "lucide-react";
import { Badge, Empty, Kpi, Message, Page, PageHeader, Panel, Tiles, styles } from "../ui";
import { count, dayYear } from "../lib/format";
import { ClaimableDeliveries, type ClaimLabels, type ClaimableItem } from "../delivery-claims";
import { getClaimableDeliveries, getClaimableDesigns, getPersonalWeek } from "./my-week-data";

const deliveryClaimLabels: ClaimLabels = {
  title: "Shared-login deliveries to claim",
  action: "This is mine",
  loading: "Loading shared-login deliveries",
  emptyTitle: "No shared-login deliveries to claim",
  emptyText: "Unclaimed deliveries from your projects will appear here for this week.",
  unavailable: "Shared-login deliveries are unavailable. Refresh to try again.",
  conflict: "This delivery is no longer available to claim. Refresh to update the list.",
  waiting: "Waiting for your manager",
  success: "Claim sent to your manager for confirmation.",
  type: "Type",
  day: "Day",
};

const designClaimLabels: ClaimLabels = {
  title: "Shared-login designs this week",
  action: "This is mine",
  loading: "Loading shared-login designs",
  emptyTitle: "No shared-login designs to claim",
  emptyText: "Unclaimed designs from your projects will appear here for this week.",
  unavailable: "Shared-login designs are unavailable. Refresh to try again.",
  conflict: "This design export is no longer available to claim. Refresh to update the list.",
  waiting: "Waiting for your manager",
  success: "Design claimed. It is waiting for your manager.",
  type: "Type",
  day: "Day",
};

function designTypeName(type: string): string {
  const labels: Record<string, string> = {
    single_image_ad: "Single image ad", carousel: "Carousel", brochure: "Brochure",
    logo: "Logo", pitch_deck: "Pitch deck", other: "Other",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function displayed(value: number | null): string {
  return value === null ? "—" : String(value);
}

function gapLabel(progress: { target: number | null; delivered: number | null; gap: number | null }): string {
  if (progress.target === null) return "No target set";
  if (progress.delivered === null || progress.gap === null) return "Delivery data unavailable";
  return progress.gap > 0 ? `${progress.gap} pending` : "Target met";
}

export async function PersonalMyWeek({ personId, week }: { personId: string; week?: string }) {
  const result = await getPersonalWeek(personId, week);
  if (result.data === undefined) return <Message text={result.error ?? "This view is unavailable."} />;

  const data = result.data;
  const [claims, designClaims] = await Promise.all([
    getClaimableDeliveries(data.week),
    getClaimableDesigns(data.week),
  ]);
  const deliveryItems: ClaimableItem[] = (claims.data?.deliveries ?? []).map((delivery) => ({
    id: delivery.id,
    projectName: delivery.projectName,
    fileName: delivery.fileName,
    type: delivery.kind === "draft" ? "Draft" : "Final",
    day: dayYear(delivery.deliveredAt),
  }));
  // The API authorizes designers by the tenant's configured role list. A 403 means
  // this person is not a designer; service and authorization failures stay visible.
  const designItems: ClaimableItem[] = (designClaims.data?.designs ?? []).map((design) => ({
    id: design.id,
    projectName: design.projectName,
    fileName: design.fileName,
    type: designTypeName(design.type),
    day: dayYear(design.uploadedAt),
  }));
  return <Page>
    <PageHeader title="My week" context={[data.week, "Your deliveries and assigned tasks"]}
      actions={<form action="/my-week" className={styles.inline}>
        <label className={styles.field}>Week<input name="week" type="week" defaultValue={data.week} className={styles.input} /></label>
        <button className={styles.btn}>View week</button>
      </form>} />

    {data.totalDeliveries !== undefined && <Tiles count={3}>
      <Kpi label="Deliveries" value={count(data.totalDeliveries)} note="Counted from your weekly creative-type totals." />
      <Kpi label="Drafts" value={count(data.drafts ?? 0)} note="Draft classification follows the configured delivery-folder rule." />
      <Kpi label="Finals" value={count(data.finals ?? 0)} note="Final classification follows the configured delivery-folder rule." />
    </Tiles>}

    <Panel title="Deliveries by creative type" sub={data.week}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th scope="col">Creative type</th><th scope="col">Target</th><th scope="col">Done</th><th scope="col">Drafts / finals</th><th scope="col">Gap</th></tr></thead>
          <tbody>{data.types.map(progress => <tr key={progress.type}>
            <th scope="row">{progress.label}</th>
            <td>{progress.target === null ? <span className={styles.muted}>No target set</span> : <>{progress.target}{progress.placeholder && <> <Badge>Placeholder target</Badge></>}</>}</td>
            <td>{displayed(progress.delivered)}</td>
            <td>{progress.drafts === null || progress.finals === null ? "—" : `${progress.drafts} / ${progress.finals}`}
              {progress.claimed.drafts + progress.claimed.finals > 0 ? <> <Badge>confirmed claim · {count(progress.claimed.drafts + progress.claimed.finals)}</Badge></> : null}
            </td>
            <td>{gapLabel(progress)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {data.types.some(progress => progress.delivered === null) && <p className={styles.status}>Per-type delivery counts are not available yet. This view does not assign the account total to a creative type.</p>}
    </Panel>

    <ClaimableDeliveries week={data.week} items={deliveryItems} endpoint="/api/v1/deliveries" labels={deliveryClaimLabels} error={claims.error} />

    {designClaims.status !== 403 && <ClaimableDeliveries week={data.week} items={designItems} endpoint="/api/v1/designs" labels={designClaimLabels}
      keepClaimedRow error={designClaims.error} />}

    <Panel title="Open tasks assigned to you" sub={data.openTasks === undefined ? "Not available" : count(data.openTasks.length)}>
      {data.openTasks === undefined
        ? <Empty icon={ListChecks} title="Backlog data is unavailable" text="Assigned tasks and their linked assets will appear here when the weekly feed is available." first />
        : data.openTasks.length === 0
          ? <Empty icon={ListChecks} title="No open tasks this week" text="Tasks assigned to you will appear here with any linked assets." first />
          : <ul className={styles.list}>{data.openTasks.map(task => <li key={task.id}>
            <div className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{task.title}</span>
                <span className={styles.rowMeta}><Badge>{task.status.replaceAll("_", " ")}</Badge>{task.dueAt ? <span>Due {dayYear(task.dueAt)}</span> : null}</span>
                {task.assets.length ? <span className={styles.rowMeta}>{task.assets.map(asset => asset.url
                  ? <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><ArrowUpRight size={12} aria-hidden="true" />Linked asset</a>
                  : <span key={asset.id}>Linked asset unavailable</span>)}</span> : null}
              </span>
            </div>
          </li>)}</ul>}
    </Panel>
  </Page>;
}
