import { Message } from "../../ui";
import { Catalogue } from "../catalogue";
import { loadHq } from "../load";

export const dynamic = "force-dynamic";

/** PULSE-HQ: the feature catalogue, kept here by Pulse's editors (every organisation reads it at /features). */
export default async function FeaturesPage() {
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "The catalogue is unavailable."} />;
  const { features, offers, ideas, canEdit, people } = r.data;
  return <Catalogue features={features} offers={offers} ideas={ideas} canEdit={canEdit} people={people} base="/hq/features" title="Feature catalogue" />;
}
