// CONNECTORS-CONTRACTS: the contract card and the data shapes, shared by the contracts page, a contract's page and My day.
import Link from "next/link";
import { acceptanceWords, datesWords, KIND_WORDS, otherSide, STATUS_WORDS, totalsWords } from "../lib/contracts.mjs";
import css from "./contracts.module.css";

export type Party = { id: string | null; key: string; kind: "company" | "person"; role: string; name: string; orgId: string | null; personId: string | null; onPulse: boolean;
  acceptedAt: string | null; acceptedVersion: number | null; acceptedBy: string | null; acceptedNote: string | null; current: boolean; mine: boolean };
export type Txn = { id: string | null; key: string; kind: string; payer: string; payee: string; label: string; amountMinor: number; currency: string; status: string;
  dueOn: string | null; paidOn: string | null; erpDocumentId: string | null; finEntryId: string | null };
export type Contract = { id: string | null; key: string; here: boolean; heldBy: string | null; status: string; version: number; kind: string; title: string; scope: string;
  deliverables: string[]; rates: { label: string; amountMinor: number; unit: string }[]; currency: string; schedule: string; startsOn: string | null; endsOn: string | null;
  noticeDays: number | null; template: string | null; endedOn: string | null; endReason: string | null; updatedAt: string; parties: Party[]; transactions: Txn[];
  totals: { currency: string; billedMinor: number; paidMinor: number; outstandingMinor: number }[]; canManage: boolean; canAccept: boolean; myParty: string | null;
  side: { notes: string | null; ownerId: string | null; owner: string | null; clientId: string | null } | null };
export type Template = { key: string; kind: string; name: string; summary: string; roles: [string, string] };
export type Choices = { canManage: boolean; us: { id: string; name: string }; people: { id: string; name: string }[]; templates: Template[] };
export type ContractsData = Choices & { company: Contract[]; mine: Contract[] };
export type ContractDetail = Choices & { contract: Contract; versions: { version: number; terms: Record<string, unknown>; changedBy: string | null; changedAt: string }[];
  links: { id: string; kind: "project" | "task" | "invoice" | "goal"; refId: string; title: string; status: string | null }[] };

export const contractHref = (c: Contract) => `/contracts/${c.id ?? c.key}`;

export function StatusBadge({ status }: { status: string }) {
  return <span className={css.badge} data-tone={status}>{(STATUS_WORDS as Record<string, string>)[status] ?? status}</span>;
}

export function ContractCard({ contract: c, us }: { contract: Contract; us?: string | null }) {
  return <Link href={contractHref(c)} className={css.card}>
    <span className={css.cardTop}>
      <h3 className={css.cardTitle}>{c.title}</h3>
      <StatusBadge status={c.status} />
    </span>
    <span className={css.meta}>
      <span>{(KIND_WORDS as Record<string, string>)[c.kind] ?? c.kind}</span>
      <span>With {otherSide(c.parties, us ?? null)}</span>
      {c.heldBy && !c.here ? <span>Held by {c.heldBy}</span> : null}
    </span>
    <span className={css.meta}>
      <span>{datesWords(c)}</span>
      {c.status === "proposed" ? <span>{acceptanceWords(c.parties)}</span> : <span>{totalsWords(c.totals)}</span>}
    </span>
  </Link>;
}
