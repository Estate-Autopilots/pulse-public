import Link from "next/link";
import { api } from "../../lib/api";
import { Page } from "../../ui";
import type { ContractDetail } from "../parts";
import { ContractView } from "./contract-view";
import type { QuoteChainData } from "../quote-chain";
import css from "../contracts.module.css";

export const dynamic = "force-dynamic";
const clock = () => Date.now();

/** CONNECTORS-CONTRACTS: one contract. CONTRACTS-2: one agreement, around its next step (contract-view.tsx). "now" is the
 *  server's, so "opened 2 hours ago" reads the same on the server and in the browser. */
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const missing = <Page><div className={css.wrap}><div className={css.problem} role="alert"><strong>We could not find this agreement.</strong>
    <span>It may have been stopped, or it belongs to another company.</span><Link className={css.btn} href="/contracts">Back to Agreements</Link></div></div></Page>;
  if (!/^[0-9a-f-]{36}$/.test(id)) return missing;
  const [r, ch] = await Promise.all([api<ContractDetail>(`contracts/${id}`), api<QuoteChainData>(`agreements/chain?contractId=${id}`)]);
  if (!r.data) return r.status === 404 ? missing : <Page><div className={css.wrap}><div className={css.problem} role="alert"><strong>We could not load this agreement.</strong>
    <span>{r.error ?? "Please try again in a moment."}</span><Link className={css.btn} href={`/contracts/${id}`}>Try again</Link></div></div></Page>;
  // AGREEMENTS round 3: an agreement made from a quotation shows the quotation → agreement → invoice chain.
  const chain = ch.data?.quote ? ch.data : null;
  return <Page><ContractView initial={r.data} now={clock()} chain={chain} /></Page>;
}
