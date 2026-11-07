import { Badge, styles } from "../ui";
import type { Doc } from "./types";
import css from "./erp.module.css";

export function ServiceQuoteAttribution({ document: d }: { document: Doc }) {
  if (d.docType !== "quotation" || !d.fromServiceKey) return null;
  return <section className={css.card} aria-label="Quotation approval">
    {d.status !== "draft" && d.ownerApproval ? <span className={styles.inline}><Badge tone={d.ownerApproval === "needed" ? "warning" : "neutral"}>
      {d.ownerApproval === "needed" ? "Owner approval needed" : "Approved by owner"}
    </Badge></span> : null}
    <p className={css.note}>Salesperson: {d.salespersonName ?? "Unassigned"} · drafted by an agent key</p>
  </section>;
}
