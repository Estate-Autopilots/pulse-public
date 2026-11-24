import Link from "next/link";
import { ScrollCurrent } from "./nav-scroll";
import css from "./nav.module.css";

/** ERP-INVOICE: the ERP area's sections, one row like Finance's. Inventory shows only when the company keeps stock.
 *  BILLING (18 Oct 2026): the area is called Billing (addresses stay under /erp; /billing leads here). */
export const ERP_SECTIONS = [
  { key: "overview", label: "Home", href: "/erp" },
  { key: "documents", label: "Documents", href: "/erp/documents" },
  { key: "catalog", label: "Catalogue", href: "/erp/catalog" },
  { key: "ratecards", label: "Rate cards", href: "/erp/rate-cards" },
  // KAZUK-V2 G12: how deals were negotiated (a salesperson's own; everyone's for the Sales Head, leadership and Finance).
  { key: "deals", label: "Deals", href: "/erp/deals" },
  { key: "inventory", label: "Stock", href: "/erp/inventory" },
  { key: "templates", label: "Templates", href: "/erp/templates" },
  { key: "settings", label: "Settings", href: "/erp/settings" },
  { key: "log", label: "Log", href: "/erp/log" },
  // OFFICE-PRINT (2503): the office printer: what was printed, paper and toner, and the agent that connects it.
  { key: "print", label: "Printer", href: "/erp/print" },
] as const;

/** KAZUK-FLOW (G1): a salesperson's seat works in Home, Documents and Catalogue; the rest is leadership's and Finance's. */
const OWN_SECTIONS: readonly string[] = ["overview", "documents", "catalog", "deals", "print"];
export function ErpNav({ current, inventory = true, own = false, detail = false }: { current: (typeof ERP_SECTIONS)[number]["key"]; inventory?: boolean; own?: boolean;
  /** POLISH-1115: on one record's page a phone shows its back link instead of the sections row (the row ran off the edge). */ detail?: boolean }) {
  return <nav className={css.sections} aria-label="Billing sections" data-billing-sections="" data-detail={detail ? "" : undefined}>
    {ERP_SECTIONS.filter((s) => (inventory || s.key !== "inventory" || current === "inventory") && (!own || OWN_SECTIONS.includes(s.key))).map((s) =>
      <Link key={s.key} href={s.href} className={css.section} aria-current={s.key === current ? "page" : undefined}>{s.label}</Link>)}
    <ScrollCurrent />
  </nav>;
}

export const STATUS_LABEL: Record<string, string> = { draft: "Draft", issued: "Issued", sent: "Sent", part_paid: "Part-paid", paid: "Paid", cancelled: "Cancelled", accepted: "Accepted", declined: "Declined", converted: "Converted" };
export const STATUS_TONE: Record<string, "neutral" | "warning" | "success" | "danger" | "accent"> = { draft: "neutral", issued: "accent", sent: "accent", part_paid: "warning", paid: "success", cancelled: "danger", accepted: "success", declined: "danger", converted: "neutral" };
export const TYPE_LABEL: Record<string, string> = { invoice: "Invoice", proforma: "Proforma", quotation: "Quotation", credit_note: "Credit note" };
