import { Layers, Package, PackageCheck } from "lucide-react";
import css from "./create.module.css";

/** The three kinds of project, told apart the same way everywhere: the package a client bought, the work that delivers
 *  it, and the company's own work. */
export type WorkKind = "client" | "fulfilment" | "internal";
const KIND: Record<WorkKind, { label: string; Icon: typeof Layers; title: string }> = {
  client: { label: "Client package", Icon: Package, title: "What the client bought: scope, value, dates and contacts. Lives under Clients." },
  fulfilment: { label: "Fulfilment", Icon: PackageCheck, title: "The work that delivers a client package: its tasks and people. Lives under Work." },
  internal: { label: "Internal", Icon: Layers, title: "The company's own work. Lives under Work." },
};
/** `label` carries the business model's word (Release, Release work) where the page knows it. */
export function KindChip({ kind, short, label }: { kind: WorkKind; short?: boolean; label?: string }) {
  const k = KIND[kind];
  return <span className={css.kind} data-kind={kind} title={k.title}><k.Icon size={11} aria-hidden="true" />{label ?? (short && kind === "client" ? "Package" : k.label)}</span>;
}
export const kindOf = (kind: string | null | undefined): WorkKind => kind === "internal" ? "internal" : kind === "client" || kind === "client_work" ? "client" : "fulfilment";
