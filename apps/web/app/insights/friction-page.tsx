// BUGKIT-TELEMETRY (owner, 6 Nov 2026): Insights → App friction (?tab=friction&days=7|30&alert=<id>), loaded on its
// own: it reads telemetry, not the WhatsApp groups the other Insights tabs read. Adoption loads for admins only.
import { api } from "../lib/api";
import { Message, Page } from "../ui";
import { FrictionInsights, type AdoptionData, type FrictionData } from "./friction";

export async function FrictionPage({ q }: { q: Record<string, string | undefined> }) {
  const days = q.days === "30" ? "30" : "7";
  const r = await api<FrictionData>(`telemetry/friction?days=${days}`);
  if (r.error || !r.data) return <Message text={r.status === 403 ? "Insights are for leadership and admins" : r.error ?? "App friction could not load"} />;
  const adoption = r.data.canSeeAdoption ? (await api<AdoptionData>(`telemetry/adoption?days=${days}`)).data ?? null : null;
  return <Page><FrictionInsights data={r.data} adoption={adoption} highlight={q.alert} /></Page>;
}
