// CONNECTORS-CONTRACTS: My day's "Your contracts": every contract naming the person, in any company (the shared part),
// the ones waiting for their acceptance first. Nothing shows for someone no contract names.
import Link from "next/link";
import { FileSignature } from "lucide-react";
import { ContractCard, type Contract } from "./parts";
import css from "./contracts.module.css";

export function MyContracts({ mine }: { mine: Contract[] | null }) {
  if (!mine?.length) return null;
  const list = [...mine].sort((a, b) => Number(b.canAccept) - Number(a.canAccept)).slice(0, 4);
  return <section className={css.section} aria-label="Your contracts" style={{ marginTop: 16 }}>
    <div className={css.sectionHead}>
      <h2><FileSignature size={16} aria-hidden="true" /> Your contracts</h2>
      <Link href="/contracts">All contracts</Link>
    </div>
    <div className={css.grid}>{list.map((c) => <ContractCard key={c.key} contract={c} />)}</div>
  </section>;
}
