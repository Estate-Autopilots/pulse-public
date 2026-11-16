import Link from "next/link";
import { headers } from "next/headers";
import { Pencil } from "lucide-react";
import { api } from "../../lib/api";
import { day } from "../../lib/format";
import { Message, Page, PageHeader, styles } from "../../ui";
import { flowSummary } from "../../lib/sop-flow.mjs";
import { SopView } from "../view";
import type { SopDetail } from "../types";

/** SOP-WORKFLOW: one SOP, drawn: who does what, in what order, where the work changes hands and where it is checked. */
export default async function SopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<SopDetail>(`sops/${id}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!, s = d.sop;
  // Phones open on the steps as a list; the flow is one tap away.
  const phone = /Mobi|Android|iPhone|PulseShell/i.test((await headers()).get("user-agent") ?? "");
  return <Page fit>
    <PageHeader title={s.title} back={{ href: "/processes", label: "Processes" }} recent={{ title: s.title }}
      context={[flowSummary(s.doc.steps), s.status === "active" ? (s.confirmedAt ? `Active since ${day(s.confirmedAt)}` : "Active") : s.status === "draft" ? "Draft" : "Archived", `Version ${s.version}`]}
      actions={d.canEdit && s.status !== "archived" ? <Link className={styles.btn} href={`/sops/${s.id}/edit`}><Pencil size={14} aria-hidden="true" />Edit</Link> : undefined} />
    <SopView data={d} initial={phone ? "steps" : "flow"} />
  </Page>;
}
