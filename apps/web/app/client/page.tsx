import { MessageCircle } from "lucide-react";
import { api } from "../lib/api";
import { Empty, Page } from "../ui";
import { ClientSpace, type Space } from "./view";

// CLIENT-PORTAL: a client's home at the organisation that serves them (their seat here). Staff never land here: the
// rail leaves it out for them and the API answers only a client's seat.
export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";
export default async function ClientHome() {
  const r = await api<Space>("client-portal");
  if (!r.data) return <Page><Empty icon={MessageCircle} first title="Your space is not ready" text={r.error ?? "Try again in a moment."} action={{ href: "/chats", label: "Open chats" }} /></Page>;
  return <Page><ClientSpace data={r.data} /></Page>;
}
