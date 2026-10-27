import { ImageOff } from "lucide-react";
import { api } from "../../../lib/api";
import { Empty, Page } from "../../../ui";
import { Review, type Deliverable } from "../review";

// PORTAL-2: a deliverable shared with a client, to look at, comment on and approve or ask for changes.
export const metadata = { title: "Review" };
export const dynamic = "force-dynamic";
export default async function ClientReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<Deliverable>(`client-portal/deliverables/${encodeURIComponent(id)}`);
  if (!r.data) return <Page><Empty icon={ImageOff} title="This is no longer here" text={r.error ?? "It may have been withdrawn or replaced."} action={{ href: "/client", label: "Back to your space" }} /></Page>;
  return <Page><Review data={r.data} side="client" back={{ href: "/client", label: "Your space" }} /></Page>;
}
