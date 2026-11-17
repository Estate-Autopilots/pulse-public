import { api, getMe, holdAtGate } from "../../lib/api";
import { Message } from "../../ui";
import { ConnectionPage, type Detail } from "./view";

export const dynamic = "force-dynamic";

/** CONNECTIONS (spec reports/CONNECT-MAP.md §3.5): one connection: its sentence, agreement, the tasks and docs shared both
 *  ways, money and activity, read from the seat that may act on it (services/api/src/connections-mine.ts). */
export const metadata = { title: "Connection" };
export default async function ConnectionDetail({ params }: { params: Promise<{ id: string }> }) {
  await holdAtGate();
  const { id } = await params;
  const [r, me] = await Promise.all([api<Detail>(`connections/${encodeURIComponent(id)}/detail`), getMe()]);
  if (!r.data) return <Message text={r.error ?? "This connection could not be read just now."} />;
  return <ConnectionPage key={r.data.id} initial={r.data} me={me.data?.account?.account?.id ?? null} />;
}
