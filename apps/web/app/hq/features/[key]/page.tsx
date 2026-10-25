import { Message } from "../../../ui";
import { FeaturePage } from "../../feature-sheet";
import { loadHq } from "../../load";

export const dynamic = "force-dynamic";

/** PULSE-HQ: one feature's own page (a link to share), editable by Pulse's editors. */
export default async function FeatureRoute({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "The catalogue is unavailable."} />;
  const feature = r.data.features.find((f) => f.key === key);
  if (!feature) return <Message text="That feature is not in the catalogue." />;
  return <FeaturePage feature={feature} canEdit={r.data.canEdit} offers={r.data.offers} ideas={r.data.ideas} base="/hq/features" />;
}
