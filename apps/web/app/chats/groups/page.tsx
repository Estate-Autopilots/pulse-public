import { api } from "../../lib/api";
import { Message, Page } from "../../ui";
import { GroupsHub } from "./hub";
import type { HubData } from "./model";

export const dynamic = "force-dynamic";

/** GROUPS-HUB (owner, 25 Oct 2026): all of the agency's groups in one place (?q= and the filters live in the address). */
export default async function GroupsHubPage() {
  const r = await api<HubData>("chats/hub");
  if (r.status === 403 || (!r.data && /individual employee account/i.test(r.error ?? ""))) return <Message text="The groups hub needs your individual employee account. Ask HR to link your People record." />;
  if (r.error || !r.data) return <Message text={r.error ?? "The groups hub is unavailable."} />;
  return <Page><GroupsHub initial={r.data} /></Page>;
}
