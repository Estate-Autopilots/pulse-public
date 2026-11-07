import { api, holdAtGate } from "../lib/api";
import { Message, Page, PageHeader } from "../ui";
import { AppointmentsView, type ApptData } from "./view";

export const metadata = { title: "Appointments" };
export const dynamic = "force-dynamic";

/** SELF-SERVE (owner, 4 Nov 2026: a professional's clients see their appointments in their own space): the team's
 *  appointments, and booking one. The words for the people served are the space's own (Settings → Industry & roles). */
export default async function AppointmentsPage() {
  await holdAtGate();
  const [r, about] = await Promise.all([api<ApptData>("appointments"), api<{ words: Record<string, string> | null }>("account/about")]);
  if (!r.data) return <Message text={r.error ?? "Appointments are unavailable."} />;
  const w = about.data?.words ?? {};
  const word = { one: w.client ?? "Client", many: w.clients ?? "Clients" };
  return <Page><PageHeader title="Appointments" context={[`${r.data.upcoming.length} coming up`]} /><AppointmentsView initial={r.data} clientWord={word} /></Page>;
}
