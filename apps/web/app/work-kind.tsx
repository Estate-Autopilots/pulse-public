import { Layers, Package, PackageCheck, UserRound } from "lucide-react";
import css from "./create.module.css";

/** The three kinds of project, told apart the same way everywhere: the package a client bought, the work that delivers
 *  it, and the company's own work. */
export type WorkKind = "client" | "fulfilment" | "internal" | "personal";
const KIND: Record<WorkKind, { label: string; Icon: typeof Layers; title: string }> = {
  client: { label: "Client package", Icon: Package, title: "What the client bought: scope, value, dates and contacts. Lives under Clients." },
  // WORK-SPINE (owner, 10 Nov 2026): two plain types, Client and Internal, each with its own words and sections.
  fulfilment: { label: "Client", Icon: PackageCheck, title: "Client work: what you deliver for a client, with its package, plan and handover." },
  internal: { label: "Internal", Icon: Layers, title: "The company's own work: no client, no package." },
  // PERSONAL-WORKSPACE (1640): your own project (a personal workspace's, or one a company person keeps as personal).
  personal: { label: "Personal", Icon: UserRound, title: "Your own project: no client, no delivery package. Lives under Work." },
};
/** `label` carries the business model's word (Release, Release work) where the page knows it. */
export function KindChip({ kind, short, label }: { kind: WorkKind; short?: boolean; label?: string }) {
  const k = KIND[kind];
  return <span className={css.kind} data-kind={kind} title={k.title}><k.Icon size={11} aria-hidden="true" />{label ?? (short && kind === "client" ? "Package" : k.label)}</span>;
}
/** PERSONAL-WORKSPACE / WORK-SPINE (1990): the project's one type (client_delivery | internal | personal) decides; the
 *  older kinds only answer when the type is not known (a client package, which has no work type of its own). */
export function kindOf(kind: string | null | undefined, projectType?: string | null): WorkKind {
  if (projectType === "personal") return "personal";
  if (kind === "client" || kind === "client_work") return projectType === "internal" ? "internal" : "client";
  if (projectType === "internal") return "internal";
  if (projectType === "client_delivery") return "fulfilment";
  return kind === "internal" ? "internal" : "fulfilment";
}
