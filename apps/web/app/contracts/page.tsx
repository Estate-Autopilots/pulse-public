import { api } from "../lib/api";
import { Message, Page, PageHeader } from "../ui";
import { ContractCard, type ContractsData } from "./parts";
import { NewContract } from "./new-contract";
import css from "./contracts.module.css";

export const dynamic = "force-dynamic";

/** CONNECTORS-CONTRACTS (owner, 6 Nov 2026): contracts between companies and people (services/api/src/contracts.ts).
 *  Your contracts in every company where you are a party; this company's contracts for admins, leadership and Finance. */
export default async function ContractsPage() {
  const r = await api<ContractsData>("contracts");
  if (!r.data) return <Message text={r.error ?? "Contracts are unavailable."} />;
  const d = r.data;
  const mine = d.mine.filter((c) => !d.company.some((x) => x.key === c.key));
  return <Page>
    <PageHeader title="Contracts" context={["Agreements with companies and people: the terms, who accepted, and what is billed and paid"]}
      actions={d.canManage ? <NewContract choices={d} /> : undefined} />
    <div className={css.wrap}>
      <section className={css.section} aria-label="Your contracts">
        <div className={css.sectionHead}><h2>Your contracts</h2><span>{mine.length ? `${mine.length}` : ""}</span></div>
        {mine.length ? <div className={css.grid}>{mine.map((c) => <ContractCard key={c.key} contract={c} />)}</div>
          : <p className={css.empty}>No contract names you yet. When a company sends you one (as an employee, partner or provider), it shows here, whichever company holds it.</p>}
      </section>
      {d.canManage ? <section className={css.section} aria-label={`${d.us.name}'s contracts`}>
        <div className={css.sectionHead}><h2>{`${d.us.name}'s contracts`}</h2><span>{d.company.length ? `${d.company.length}` : ""}</span></div>
        {d.company.length ? <div className={css.grid}>{d.company.map((c) => <ContractCard key={c.key} contract={c} us={d.us.id} />)}</div>
          : <p className={css.empty}>No contracts yet. Start one from a template: a retainer, a services agreement, employment or a revenue share.</p>}
      </section> : null}
    </div>
  </Page>;
}
