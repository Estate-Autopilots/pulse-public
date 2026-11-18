import Link from "next/link";
import { FileText } from "lucide-react";
import { api } from "../lib/api";
import { Page, PageHeader } from "../ui";
import type { ContractsData } from "./parts";
import { AgreementList } from "./agreement-list";
import css from "./contracts.module.css";

export const dynamic = "force-dynamic";
const clock = () => Date.now();

/** CONNECTORS-CONTRACTS (owner, 6 Nov 2026): contracts between companies and people (services/api/src/contracts.ts).
 *  CONTRACTS-2 (owner, 8 Nov 2026): "Agreements": one calm list grouped by what needs you (the chosen design), one main
 *  button (New agreement), how many were signed this month, and the templates one tap away. A person who is only named in
 *  agreements sees theirs. */
export default async function ContractsPage() {
  const r = await api<ContractsData>("contracts");
  if (!r.data) return <Page><div className={css.wrap}>
    <PageHeader title="Agreements" />
    <div className={css.problem} role="alert"><strong>We could not load your agreements.</strong><span>{r.error ?? "Please try again in a moment."}</span>
      <Link className={css.btn} href="/contracts">Try again</Link></div>
  </div></Page>;
  const d = r.data;
  const mine = d.mine.filter((c) => !d.company.some((x) => x.key === c.key));
  return <Page>
    <div className={css.wrap}>
      <PageHeader title="Agreements" context={[d.canMake ? (d.signedThisMonth ? `${d.signedThisMonth} signed this month` : "Send an agreement, the client signs on their phone") : "Agreements that name you"]}
        actions={d.canMake ? <>
          {d.canManage ? <Link href="/contracts/templates" className={`${css.btn} ${css.quiet}`}><FileText size={16} aria-hidden="true" />Templates</Link> : null}
          <Link href="/contracts/new" className={`${css.btn} ${css.primary}`}>New agreement</Link>
        </> : undefined} />
      <AgreementList company={d.canMake ? d.company : []} mine={mine} us={d.us.id} canMake={d.canMake} canManage={d.canManage} now={clock()} signedThisMonth={d.signedThisMonth} />
    </div>
  </Page>;
}
