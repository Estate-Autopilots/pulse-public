import Link from "next/link";
import { ArrowLeft, PenLine } from "lucide-react";
import { Message } from "../../../../ui";
import { loadHq } from "../../../load";
import { valueScore } from "../../../model";
import { OfferSheet } from "../../../offer-sheet";
import { PrintButton } from "./print";
import css from "../../../hq.module.css";

export const dynamic = "force-dynamic";

/** PULSE-HQ: one offer as a full, printable one-page sheet (for customers and investors). */
export default async function OfferSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "The offer sheet is unavailable."} />;
  const offer = r.data.offers.find((o) => o.id === id);
  if (!offer) return <Message text="That offer is not here any more." />;
  return <>
    <div className={`${css.toolbar} ${css.noPrint}`} style={{ paddingTop: 12 }}>
      <Link href="/hq/offers" className={css.ghost}><ArrowLeft size={16} aria-hidden="true" />Offer Studio</Link>
      <span style={{ flex: 1 }} />
      {r.data.canEdit ? <Link href={`/hq/offers/${offer.id}`} className={css.secondary}><PenLine size={15} aria-hidden="true" />Edit</Link> : null}
      <PrintButton />
    </div>
    <div style={{ maxWidth: 980, width: "100%", margin: "0 auto" }}><OfferSheet offer={{ ...offer, value: valueScore(offer) }} features={r.data.features} full /></div>
  </>;
}
