import { getMe } from "../lib/api";
import { Message, Page, PageHeader } from "../ui";
import { CallLog } from "./log";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calls" };

/** FEATURES-1024 (J8; CHAT-VOICE "a Calls tab listing calls across chats"): every call from the person's chats in the
 *  last 90 days, newest first, missed ones marked, with call back and the conversation one tap away. */
export default async function Calls() {
  const me = await getMe();
  if (!me.data?.person) return <Message text="Calls need your own employee account." />;
  return <Page fit>
    <PageHeader title="Calls" context={["Voice and video calls from your chats, the last 90 days"]} recent={{ title: "Calls" }} />
    <CallLog me={me.data.person} />
  </Page>;
}
