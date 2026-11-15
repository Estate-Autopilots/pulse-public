"use client";
// AGREEMENTS rounds 3–4 (owner, 14–15 Nov 2026: "quote → accepted → agreement → invoice"; "show me step by step how things
// work"). One card on the quotation's, the invoice's and the agreement's pages: the eight steps from lead to live (the
// kit's Stepper on a wide screen; on a phone the step now and the one after), a progress bar, who acts next, one sentence
// and one button. Making the agreement uses CONTRACTS-2's from-document; the invoice is Billing's own draft from the
// quotation (POST agreements/chain/invoice); the onboarding is the project and tasks from the quotation
// (POST agreements/chain/onboarding). Each links back to the agreement.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { celebrate, Stepper, toast } from "../kit/game";
import { chainStep } from "../lib/agreements.mjs";
import { post } from "../orgs/client";
import css from "./quote-chain.module.css";

export type QuoteChainData = {
  quote: { id: string; number: string | null; docType: string; status: string; total: number | null; client: string | null } | null;
  agreement: { id: string; title: string; status: string; signedAt: string | null; sentAt: string | null; seenAt: string | null; asks: number; clientSigned: boolean; waitingFor: string[] } | null;
  invoice: { id: string; number: string | null; docType: string; status: string; total: number | null } | null;
  onboarding: { projectId: string; title: string; tasks: number; done: number } | null;
  step: number;
  can: { agreement: boolean; invoice: boolean; onboarding: boolean; billing: boolean; make: boolean };
};
type Doing = "make-agreement" | "make-invoice" | "start-onboarding";
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const STATE: Record<string, string> = { draft: "Draft", issued: "Sent", sent: "Sent", accepted: "Accepted", paid: "Paid", partially_paid: "Part paid", overdue: "Overdue", cancelled: "Cancelled", void: "Cancelled", expired: "Expired", declined: "Declined" };
const BUSY: Record<Doing, string> = { "make-agreement": "Making the agreement…", "make-invoice": "Making the invoice…", "start-onboarding": "Starting the onboarding…" };

export function QuoteChain({ chain, page, compact = false }: { chain: QuoteChainData; page: "quote" | "agreement" | "invoice";
  /** POLISH-1115: beside a contract, the chain is a small reference: the step, its linked records and the one next step. */ compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = chainStep(chain, page);
  const done = s.current >= 8;
  // POLISH-1115 (the judge: "Live has no finish moment"): the first time someone sees the client live, a small burst.
  const liveId = chain.agreement?.id ?? chain.quote?.id ?? "";
  useEffect(() => { if (done && liveId) celebrate(null, { id: `chain-live:${liveId}` }); }, [done, liveId]);

  async function run(kind: Doing) {
    setBusy(true); setError(null);
    try {
      if (kind === "make-agreement") {
        const r = await post<{ id: string }>("contracts/from-document", { documentId: chain.quote!.id });
        toast("The agreement is made. Check the words, then send it to sign.");
        router.push(`/contracts/${r.id}`);
      } else if (kind === "make-invoice") {
        const r = await post<{ id: string; existing: boolean }>("agreements/chain/invoice", { contractId: chain.agreement!.id });
        if (!r.existing) celebrate(null, { id: `chain-invoice:${chain.agreement!.id}` });
        toast(r.existing ? "Opening the invoice." : "The invoice is ready as a draft. Check it and send it.");
        router.push(`/erp/documents/${r.id}`);
      } else {
        const r = await post<{ projectId: string; created: boolean; tasks: number }>("agreements/chain/onboarding", { contractId: chain.agreement!.id });
        celebrate(null, { id: `chain-onboarding:${chain.agreement!.id}` });
        toast(`Onboarding started: ${r.tasks} ${r.tasks === 1 ? "task" : "tasks"}.`);
        setBusy(false); router.refresh();
      }
    } catch (e) { setError(say(e)); setBusy(false); }
  }

  const a = s.action;
  const href = !a ? null
    : a.kind === "open-agreement" && chain.agreement ? `/contracts/${chain.agreement.id}`
    : a.kind === "open-invoice" && chain.invoice ? `/erp/documents/${chain.invoice.id}`
    : a.kind === "open-onboarding" && chain.onboarding ? `/tasks/projects/${chain.onboarding.projectId}` : null;
  const button = !a ? null
    // LAND-CAPTAIN-11: a quiet step (Start onboarding beside a draft invoice's own Issue) is an ordinary button.
    : href ? <Link className={css.btn} data-primary={s.quiet ? undefined : ""} href={href}>{a.label}</Link>
    : a.kind === "make-agreement" || a.kind === "make-invoice" || a.kind === "start-onboarding"
      ? <button type="button" className={css.btn} data-primary={s.quiet ? undefined : ""} disabled={busy} onClick={() => void run(a.kind as Doing)}>{busy ? BUSY[a.kind as Doing] : a.label}</button>
    : null;
  const side = page === "agreement" && chain.quote ? { href: `/erp/documents/${chain.quote.id}`, label: `${chain.quote.docType === "proforma" ? "Proforma" : "Quotation"} ${chain.quote.number ?? ""}`.trim() }
    : page !== "agreement" && chain.agreement ? { href: `/contracts/${chain.agreement.id}`, label: "The agreement" } : null;

  if (compact) {
    const refs = [
      chain.quote ? { href: `/erp/documents/${chain.quote.id}`, label: `${chain.quote.docType === "proforma" ? "Proforma" : "Quotation"} ${chain.quote.number ?? ""}`.trim(), state: STATE[chain.quote.status] ?? chain.quote.status } : null,
      chain.invoice ? { href: `/erp/documents/${chain.invoice.id}`, label: `Invoice ${chain.invoice.number ?? ""}`.trim(), state: STATE[chain.invoice.status] ?? chain.invoice.status } : null,
      chain.onboarding ? { href: `/tasks/projects/${chain.onboarding.projectId}`, label: "Onboarding", state: `${chain.onboarding.done} of ${chain.onboarding.tasks} tasks` } : null,
    ].filter(Boolean) as { href: string; label: string; state: string }[];
    return <section className={css.card} data-compact="" aria-label="From lead to live" data-done={done ? "" : undefined}>
      <div className={css.head}><h2>From lead to live</h2><span className={css.count}>{done ? "All done" : `Step ${s.current + 1} of 8`}</span></div>
      <div className={css.bar} role="progressbar" aria-label="Steps done" aria-valuemin={0} aria-valuemax={8} aria-valuenow={s.current} aria-valuetext={`${s.current} of 8 steps done`}>
        <span style={{ width: `${s.percent}%` }} />
      </div>
      {refs.length ? <ul className={css.refs}>{refs.map((r) => <li key={r.href}><Link href={r.href}>{r.label}</Link><span>{r.state}</span></li>)}</ul> : null}
      {!done && s.next ? <p className={css.then}>{`Next: ${s.next}${s.who ? ` (${s.who})` : ""}`}</p> : null}
      {button}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </section>;
  }

  return <section className={css.card} aria-label="From lead to live" data-done={done ? "" : undefined}>
    <div className={css.head}>
      <h2>From lead to live</h2>
      {side ? <Link className={css.quiet} href={side.href}>{side.label}</Link> : null}
    </div>
    <div className={css.where}>
      <p className={css.stepNow}>{done ? "All 8 steps done" : <>{`Step ${s.current + 1} of 8: `}<b>{s.next}</b></>}</p>
      {s.who && !done ? <span className={css.who}>{`Next: ${s.who}`}</span> : null}
    </div>
    <div className={css.bar} role="progressbar" aria-label="Steps done" aria-valuemin={0} aria-valuemax={8} aria-valuenow={s.current} aria-valuetext={`${s.current} of 8 steps done`}>
      <span style={{ width: `${s.percent}%` }} />
    </div>
    <div className={css.wide}><Stepper steps={s.steps} current={s.current} label="From lead to live" /></div>
    {s.then ? <p className={css.then}>{`Then: ${s.then}`}</p> : null}
    <div className={css.foot}>
      <p className={css.text}>{s.text}</p>
      {button}
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </section>;
}
