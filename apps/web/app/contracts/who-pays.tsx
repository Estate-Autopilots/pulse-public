// CONTRACTS-3 (owner, 8 Nov: "from that flow a diagram forms: who pays whom, for what"): the read-only money picture of
// an agreement, on its page and in the builder. The chosen concept: two party cards joined by a "Pays ₹…" arrow, the
// parts with when and where each is, how much is paid, the next payment and the document it comes from (desktop: side
// by side, concept 2); in a narrow box the cards stack with the arrow pointing down and the parts as a list (concept 1).
// It reads the width of its own box, so it fits a phone at 363 px and the builder's column alike.
import Link from "next/link";
import { ArrowDown, ArrowRight, FileText } from "lucide-react";
import type { moneyFlow } from "../lib/agreements.mjs";
import { money } from "../lib/contracts.mjs";
import css from "./who-pays.module.css";

export type Flow = ReturnType<typeof moneyFlow>;
type Side = { name: string; role: string; key: string };
type Poc = { name: string | null; phone: string | null } | null | undefined;

const initials = (name: string) => name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
const STATE = { paid: "Paid", due: "Due", late: "Late", billed: "Billed", later: "Later" } as const;
const roleWords = (side: Side, pays: boolean) => pays ? "The client" : side.role === "provider" || side.role === "employee" ? "Does the work, gets paid" : "Gets paid";

function PartyCard({ side, pays, poc, you }: { side: Side; pays: boolean; poc: Poc; you: boolean }) {
  return <div className={css.party} data-pays={pays ? "" : undefined}>
    <span className={css.mark} aria-hidden="true">{initials(side.name)}</span>
    <span className={css.partyText}>
      <strong>{side.name}</strong>
      <span className={css.role}>{you ? <span className={css.you}>You</span> : null}{roleWords(side, pays)}</span>
      {poc?.name || poc?.phone ? <span className={css.poc}>{poc?.name}{poc?.phone ? <span className={css.phone}>{poc.phone}</span> : null}</span> : null}
    </span>
  </div>;
}

export function WhoPays({ flow, pocs, us, title = "Who pays whom", hint, gets, bare, noDoc, noGets }: { flow: Flow; pocs?: Record<string, Poc>; us?: (key: string) => boolean; title?: string; hint?: string; gets?: string | null;
  /** Inside another card: no frame of its own. */ bare?: boolean; /** The page already shows the document. */ noDoc?: boolean;
  /** A summary beside a form: no "In return" line (the form says what it is for). */ noGets?: boolean }) {
  if (!flow.payer || !flow.payee) return null;
  const total = flow.totalMinor ? `${money(flow.totalMinor, flow.currency)}${flow.per ? " a month" : ""}` : "";
  const recorded = flow.parts.some((p) => p.state !== "later");
  return <section className={bare ? `${css.box} ${css.bare}` : css.box} aria-label={title}>
    <div className={css.head}><h2>{title}</h2>{hint ? <span>{hint}</span> : null}</div>
    <div className={css.flow}>
      <PartyCard side={flow.payer} pays poc={pocs?.[flow.payer.key]} you={!!us?.(flow.payer.key)} />
      <div className={css.arrow} aria-label={total ? `${flow.payer.name} pays ${flow.payee.name} ${total}` : `${flow.payer.name} pays ${flow.payee.name}`}>
        {total ? <span className={css.pay}>{`Pays ${total}`}</span> : bare ? null : <span className={css.payLater}>No price yet</span>}
        <span className={css.line} aria-hidden="true"><ArrowRight className={css.right} size={22} /><ArrowDown className={css.down} size={22} /></span>
        {flow.parts.length > 1 ? <span className={css.sub}>{`in ${flow.parts.length} parts`}</span> : flow.per ? <span className={css.sub}>every month</span> : null}
      </div>
      <PartyCard side={flow.payee} pays={false} poc={pocs?.[flow.payee.key]} you={!!us?.(flow.payee.key)} />
    </div>
    {noGets ? null : <p className={css.gets}><span>In return:</span> {gets || flow.gets}</p>}

    {flow.parts.length > 1 || flow.parts.some((p) => p.state !== "later" || (p.when && p.when !== "The full amount")) ? <ol className={css.parts} aria-label="The parts">
      {flow.parts.map((p, i) => <li key={`${p.label}-${i}`} data-state={p.state}>
        <span className={css.amount}>{money(p.amountMinor, flow.currency)}</span>
        <span className={css.partText}><span>{p.label}</span>{p.when ? <span className={css.when}>{p.when}</span> : null}</span>
        {p.state === "later" ? <span /> : <span className={css.chip} data-state={p.state}>{STATE[p.state]}</span>}
      </li>)}
    </ol> : flow.totalMinor || bare ? null : <p className={css.quiet}>The price is not in the agreement yet.</p>}

    {recorded ? <div className={css.progress}>
      <span className={css.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={flow.paidPct} aria-label="Paid so far">
        <span style={{ width: `${flow.paidPct}%` }} />
      </span>
      <span className={css.pct}>{`${flow.paidPct}% paid`}</span>
    </div> : null}
    {flow.next ? <p className={css.next} data-late={flow.next.late ? "" : undefined}>{flow.next.full ? `The full ${money(flow.next.amountMinor, flow.currency)} is ${flow.next.when}` : `Next: ${money(flow.next.amountMinor, flow.currency)} ${flow.next.when}`}</p> : null}
    {flow.document && !noDoc ? flow.document.id
      ? <Link className={css.doc} href={`/erp/documents/${flow.document.id}`}><FileText size={16} aria-hidden="true" />{`From ${flow.document.label}`}</Link>
      : <span className={css.doc}><FileText size={16} aria-hidden="true" />{`From ${flow.document.label}`}</span> : null}
  </section>;
}
