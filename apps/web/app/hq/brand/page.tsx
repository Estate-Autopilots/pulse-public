import { Message } from "../../ui";
import { loadHq } from "../load";
import { BrandCanvas } from "./canvas";

export const dynamic = "force-dynamic";

/** PULSE-HQ: Pulse's positioning and brand, edited in place, with its history and the offers that use it. */
export default async function BrandPage() {
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "The brand is unavailable."} />;
  return <BrandCanvas brand={r.data.brand} canEdit={r.data.canEdit} updatedAt={r.data.brandUpdatedAt} versions={r.data.brandVersions ?? []} offers={r.data.offers} />;
}
