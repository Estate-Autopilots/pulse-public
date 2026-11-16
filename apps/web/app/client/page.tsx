import { MessageCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { api, getMe } from "../lib/api";
import { WhatIsVitals } from "../growth/what-is-vitals";
import { Empty, Page } from "../ui";
import { ClientSpace, type Space } from "./view";

// CLIENT-PORTAL: a client's home at the organisation that serves them (their seat here). Staff never land here: the
// rail leaves it out for them and the API answers only a client's seat.
export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";
export default async function ClientHome({ searchParams }: { searchParams: Promise<{ digest?: string }> }) {
  const [r, q, me] = await Promise.all([api<Space>("client-portal"), searchParams, getMe()]);
  // A client's seat with no space here (an ORG client invitation, not a client record's) works on its shared tasks.
  if (!r.data && r.status === 403) redirect("/tasks");
  if (!r.data) return <Page><Empty icon={MessageCircle} first title="Your space is not ready" text={r.error ?? "Try again in a moment."} action={{ href: "/chats", label: "Open chats" }} /></Page>;
  // GROWTH-LOOP: "Powered by <company> · Vitals" and the "What is Vitals?" card (the client's own company pre-fills Start free).
  const company = me.data?.orgName ?? "";
  return <Page><WhatIsVitals company={company} source="portal" signedIn via={me.data?.orgHandle ?? null} video={process.env.PULSE_EXPLAINER_VIDEO_URL ?? null} />
    <ClientSpace data={r.data} digestOff={q.digest === "off"} /></Page>;
}
