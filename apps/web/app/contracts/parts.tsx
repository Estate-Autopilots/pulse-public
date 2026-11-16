// CONNECTORS-CONTRACTS: the contract card and the data shapes, shared by the contracts page, a contract's page and My day.
// CONTRACTS-2 (owner, 8 Nov 2026): agreements people sign. A row says where each one is in plain words ("Ready to send",
// "Opened 2 hours ago", "Asked for a change", "Signed 4 Nov") with a Sent › Opened › Signed track (the chosen concept:
// one calm list, grouped by what needs you).
import Link from "next/link";
import { acceptanceWords, datesWords, KIND_WORDS, money, otherSide, STATUS_WORDS, totalsWords } from "../lib/contracts.mjs";
import { stageOf, trackOf } from "../lib/agreements.mjs";
import css from "./contracts.module.css";

export type Party = { id: string | null; key: string; kind: "company" | "person"; role: string; name: string; orgId: string | null; personId: string | null; onPulse: boolean;
  acceptedAt: string | null; acceptedVersion: number | null; acceptedBy: string | null; acceptedNote: string | null; current: boolean; mine: boolean;
  email: string | null; signer: string | null; signKind: string | null; signImage: string | null; declinedAt: string | null; declinedNote: string | null;
  poc?: { name: string | null; phone: string | null; email: string | null } };
export type Txn = { id: string | null; key: string; kind: string; payer: string; payee: string; label: string; amountMinor: number; currency: string; status: string;
  dueOn: string | null; paidOn: string | null; erpDocumentId: string | null; finEntryId: string | null };
export type Progress = { sentAt: string | null; openedAt: string | null; seenAt: string | null; changes: number; expiresAt: string | null };
export type Contract = { id: string | null; key: string; here: boolean; heldBy: string | null; status: string; version: number; kind: string; title: string; scope: string;
  deliverables: string[]; rates: { label: string; amountMinor: number; unit: string }[]; currency: string; schedule: string; startsOn: string | null; endsOn: string | null;
  noticeDays: number | null; template: string | null; endedOn: string | null; endReason: string | null; updatedAt: string; parties: Party[]; transactions: Txn[];
  totals: { currency: string; billedMinor: number; paidMinor: number; outstandingMinor: number }[]; canManage: boolean; canAccept: boolean; myParty: string | null;
  side: { notes: string | null; ownerId: string | null; owner: string | null; clientId: string | null } | null;
  body: string; signedAt: string | null; canRun: boolean; progress: Progress | null };
export type Template = { key: string; kind: string; name: string; summary: string; roles: [string, string] };
export type Choices = { canManage: boolean; canMake: boolean; us: { id: string; name: string }; people: { id: string; name: string }[]; templates: Template[]; signedThisMonth: number | null };
export type ContractsData = Choices & { company: Contract[]; mine: Contract[] };
export type AgreementEvent = { id: string; kind: string; party: string | null; version: number | null; clause: string | null; body: string | null; by: string | null; via: string;
  at: string; resolvedAt: string | null };
export type SignLink = { party: string; createdAt: string; expiresAt: string; revokedAt: string | null; openedAt: string | null; seenAt: string | null; answeredAt: string | null };
export type ContractDetail = Choices & { contract: Contract; versions: { version: number; terms: Record<string, unknown>; changedBy: string | null; changedAt: string }[];
  links: { id: string; kind: "project" | "task" | "invoice" | "goal"; refId: string; title: string; status: string | null }[];
  activity: { events: AgreementEvent[]; links: SignLink[]; source: { documentId: string | null; documentNumber: string | null; documentType: string | null;
    total?: number | null; dueDate?: string | null; documentStatus?: string | null } | null; canRun: boolean } | null;
  // CONTRACTS-3: drafts proposed through the screen, the API or an AI assistant, waiting for a person.
  proposals?: { id: string; baseVersion: number; title: string | null; body: string; note: string | null; via: string; by: string | null; at: string }[] };

export const contractHref = (c: Contract) => `/contracts/${c.id ?? c.key}`;
/** The agreement's amount: its rate lines added up (one-off and per-deliverable lines; a monthly fee shows as itself). */
export function amountOf(c: Contract) {
  if (!c.rates.length) return "";
  const once = c.rates.filter((r) => r.unit === "one_off" || r.unit === "deliverable");
  if (once.length === c.rates.length) return money(once.reduce((s, r) => s + r.amountMinor, 0), c.currency);
  const r = c.rates[0];
  return r.unit === "month" ? `${money(r.amountMinor, c.currency)} a month` : "";
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

export function StatusBadge({ status }: { status: string }) {
  return <span className={css.badge} data-tone={status}>{(STATUS_WORDS as Record<string, string>)[status] ?? status}</span>;
}

/** One agreement in the list: who it is with, what it is, where it is, the track and the amount. */
export function AgreementRow({ contract: c, us, now, zone }: { contract: Contract; us: string | null; now: number; zone: string }) {
  const stage = stageOf(c, us, now, zone);
  const them = otherSide(c.parties, us);
  return <Link href={contractHref(c)} className={css.row2} data-stage={stage.key}>
    <span className={css.avatar} aria-hidden="true">{initials(them)}</span>
    <span className={css.rowMain}>
      <strong>{them}</strong>
      <span>{c.title}</span>
    </span>
    <span className={css.rowState}>
      <span className={css.pill} data-tone={stage.tone}>{stage.label}</span>
      <ol className={css.track} aria-label="Progress">{trackOf(c).map((s) => <li key={s.key} data-done={s.done ? "" : undefined}>{s.label}</li>)}</ol>
    </span>
    <span className={css.rowAmount}>{amountOf(c)}</span>
  </Link>;
}

/** My day's card (a contract that names the person). */
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
