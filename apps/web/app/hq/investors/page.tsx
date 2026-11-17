import { api } from "../../lib/api";
import type { InvestorData } from "../../lib/investors.mjs";
import { Message } from "../../ui";
import { InvestorView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Investor numbers" };

/** GROWTH-LOOP slice 1 (owner, 8 Nov 2026): how the whole Vitals network grows, for the platform owner only. Every
 *  number is counted from live data across every company (pulse.investor_metrics, 1894); no company is named. */
export default async function InvestorNumbers() {
  const r = await api<InvestorData>("hq/investors?weeks=12");
  if (r.status === 403) return <Message notice="Investor numbers are for the platform owner only. Ask them for the deck." />;
  if (r.error || !r.data) return <Message text={r.error ?? "The investor numbers are unavailable."} />;
  return <InvestorView data={r.data} />;
}
