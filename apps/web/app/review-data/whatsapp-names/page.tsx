import { Lock } from "lucide-react";
import { redirect } from "next/navigation";
import { api } from "../../lib/api";
import { Empty, Page, PageHeader } from "../../ui";
import type { NamesData } from "./matcher";

export const metadata = { title: "WhatsApp names" };

/** EST-1542: where leadership and HR decide, once, who each WhatsApp sender name is, before group history comes into
 *  Pulse. SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.3: "WhatsApp names is not a category to be listed as its own URL"):
 *  the names are a type of Review data's one queue now; this old address opens them there. */
export default async function WhatsAppNames() {
  const r = await api<NamesData>("chat-names");
  if (r.data) redirect("/review-data?type=whatsapp-names");
  return (
    <Page>
      {/* VISUAL-QA (D84): someone refused here is refused by Review data too; send them Home, not to a second refusal. */}
      <PageHeader title="WhatsApp names" back={r.status === 403 ? { href: "/", label: "Home" } : { href: "/review-data", label: "Review data" }} />
      <Empty icon={Lock} first title={r.status === 403 ? "Only leadership and HR match these names" : "The names could not be loaded"} text={r.status === 403 ? "Ask an admin if you should be doing this." : r.error ?? "Reload the page to try again."} />
    </Page>
  );
}
