import { Message } from "../../../ui";
import { loadHq } from "../../load";
import { Studio } from "./studio";

export const dynamic = "force-dynamic";

/** PULSE-HQ: Offer Studio for one offer. */
export default async function OfferStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "Offer Studio is unavailable."} />;
  const offer = r.data.offers.find((o) => o.id === id);
  if (!offer) return <Message text="That offer is not here any more." />;
  return <Studio key={offer.id} initial={offer} features={r.data.features} canEdit={r.data.canEdit} />;
}
