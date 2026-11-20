import { api, getMe, holdAtGate } from "../lib/api";
import { Message } from "../ui";
import { MineView, type MineData } from "./mine";

export const dynamic = "force-dynamic";

/** CONNECTIONS (owner, 16-17 Nov 2026; spec reports/CONNECT-MAP.md §3.5): everyone you work with, across every company
 *  and your personal space, read per seat (services/api/src/connections-mine.ts). */
export const metadata = { title: "Connections" };
export default async function Connections() {
  await holdAtGate();
  const [r, me] = await Promise.all([api<MineData>("connections/mine"), getMe()]);
  if (!r.data) return <Message text={r.error ?? "Your connections could not be read just now."} />;
  return <MineView data={r.data} me={me.data?.account?.account?.id ?? null} />;
}
