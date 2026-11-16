import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import type { RateCardPick } from "../../lib/rate-card.mjs";
import { RateCards, type Service } from "./rate-cards";

export const metadata = { title: "Rate cards · Billing" };

/** KAZUK-REST (6 Nov 2026; Kazuk's Quotation Builder v2, A8): each service's rate card (base × X × talent × period, plus
 *  add-ons). Leadership and admins edit them (their prices are approved prices); everyone in Billing reads them, and the
 *  composer builds quotation lines from them. */
export default async function RateCardsPage() {
  const r = await api<{ cards: RateCardPick[]; services: Service[]; canEdit: boolean }>("erp/rate-cards");
  if (!r.data) return <Message text={r.error ?? "Rate cards are unavailable"} />;
  const live = r.data.cards.filter((c) => c.status !== "archived").length;
  return <Page>
    <PageHeader title="Rate cards" context={["Billing", `${live} rate card${live === 1 ? "" : "s"}`]} />
    <ErpNav current="ratecards" />
    <RateCards cards={r.data.cards} services={r.data.services} canEdit={r.data.canEdit} />
  </Page>;
}
