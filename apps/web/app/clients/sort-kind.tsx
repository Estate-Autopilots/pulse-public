"use client";
// COMPANIES-MODEL: a client the move to companies could not sort (no company name, no telling type): one tap says who it is.
import { Building2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import styles from "../ui.module.css";
import css from "../contacts/book.module.css";

export function SortKind({ id, name }: { id: string; name: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const say = async (kind: "company" | "person") => {
    setBusy(true);
    try {
      const r = await post<{ companyId?: string }>(`clients/${id}/kind`, { kind });
      notify({ id: "client-kind", tone: "success", title: kind === "company" ? `${name} is in Companies now` : `${name} is one person`, timeout: 3000 });
      if (r.companyId) router.push(`/contacts/companies/${r.companyId}`); else router.refresh();
    } catch (e) { notify({ id: "client-kind", tone: "error", title: e instanceof Error ? e.message : "That did not save", timeout: 4000 }); setBusy(false); }
  };
  return <div className={css.sort} role="group" aria-label={`Is ${name} a company or one person?`}>
    <p>Is {name} a company or one person?</p>
    <div className={css.actions}>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => void say("company")}><Building2 size={14} aria-hidden="true" />A company</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => void say("person")}><UserRound size={14} aria-hidden="true" />One person</button>
    </div>
  </div>;
}
