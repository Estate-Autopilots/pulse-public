import Link from "next/link";
import { FileCheck2 } from "lucide-react";
import { styles } from "../ui";
import { payDocState, type PolicyList } from "../people/pay/policy-state";
import css from "./hr.module.css";

/** HR-PEOPLE (owner, 13 Nov 2026, T1.1.11: "why it is not connected to the HR desks"): HR desk → Pay & policy says where
 *  the pay policy stands (its version and how many accepted it) and opens it; its answers live in People & pay. */
export function PayPolicyStrip({ list }: { list: PolicyList | null | undefined }) {
  const s = payDocState(list);
  if (!s) return null;
  const left = s.published ? Math.max(0, s.of - s.accepted) : 0;
  return <section className={css.payStrip} aria-label="Pay policy">
    <FileCheck2 size={18} aria-hidden="true" />
    <p><b>Pay policy</b>{" · "}{s.published ? `version ${s.version}: ${s.accepted} of ${s.of} accepted${left ? `, ${left} still to read it` : ", everyone has"}` : s.draft ? "a draft, not published yet" : "not written yet. Answer five questions and Pulse writes it."}</p>
    {/* A status line, not the view's main action: Payroll's "Show figures" stays the one primary button. */}
    <Link href="/people/pay/settings" className={styles.btn}>{s.published ? "Open pay policy" : "Write the pay policy"}</Link>
  </section>;
}
