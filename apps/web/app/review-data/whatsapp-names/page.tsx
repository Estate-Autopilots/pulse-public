import { Lock } from "lucide-react";
import { api } from "../../lib/api";
import { Empty, Page, PageHeader } from "../../ui";
import { Matcher, type NamesData } from "./matcher";

export const metadata = { title: "WhatsApp names" };

/** EST-1542: the private screen where leadership and HR decide, once, who each WhatsApp sender name is, before group
 *  history comes into Pulse. Reached by its link from Review data; never listed in menus, search, chats or exports. */
export default async function WhatsAppNames() {
  const r = await api<NamesData>("chat-names");
  // A reload (after a load) is reconciled inside the matcher: the server's counts and order, answers being saved kept.
  return r.data ? <Matcher key={r.data.source} initial={r.data} /> : (
    <Page>
      <PageHeader title="WhatsApp names" back={{ href: "/review-data", label: "Review data" }} />
      <Empty icon={Lock} first title={r.status === 403 ? "Only leadership and HR match these names" : "The names could not be loaded"} text={r.status === 403 ? "Ask an admin if you should be doing this." : r.error ?? "Reload the page to try again."} />
    </Page>
  );
}
