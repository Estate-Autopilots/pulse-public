// ERP-INVOICE: issued documents in the shapes the books want. Zoho Books stays a mirror while EA keeps it (its invoice
// import CSV, one row per line); the CA keeps the books in Tally (sales and credit-note vouchers as Tally import XML);
// and a plain sales register (CSV) for anyone else. Pure functions over issued documents; figures are paise.
import { STATES } from "@pulse/invoice-doc";

export type ExportLine = { description: string; details?: string | null; sac: string | null; unit: string | null; qty: number; rate: number; discount: number; gstRate: number; taxable: number; cgst: number; sgst: number; igst: number; total: number };
export type ExportDoc = {
  docType: string; number: string; status: string; issueDate: string; dueDate: string | null; against: string | null;
  buyer: { name?: string; gstin?: string | null; stateCode?: string | null }; placeOfSupply: string; taxMode: string;
  taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number; paid: number; credited: number;
  notes: string | null; terms: string | null; lines: ExportLine[];
};

const rupees = (paise: number) => (paise / 100).toFixed(2);
/** A CSV cell that a spreadsheet will not run as a formula. */
export function csvCell(x: unknown): string {
  let text = x === null || x === undefined ? "" : String(x);
  if (/^[=+@-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const xml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TYPE: Record<string, string> = { invoice: "Invoice", proforma: "Proforma", quotation: "Quotation", credit_note: "Credit note" };

/** Zoho Books' two-letter place-of-supply codes. */
export const ZOHO_STATE: Record<string, string> = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UT", "06": "HR", "07": "DL", "08": "RJ", "09": "UP", "10": "BR", "11": "SK", "12": "AR",
  "13": "NL", "14": "MN", "15": "MZ", "16": "TR", "17": "ML", "18": "AS", "19": "WB", "20": "JH", "21": "OR", "22": "CG", "23": "MP", "24": "GJ",
  "26": "DN", "27": "MH", "29": "KA", "30": "GA", "31": "LD", "32": "KL", "33": "TN", "34": "PY", "35": "AN", "36": "TS", "37": "AD", "38": "LA", "97": "OT",
};

/** Every issued document in a period, one row each, with what is still due. */
export function salesRegisterCsv(docs: ExportDoc[]): string {
  return csv(["Date", "Number", "Type", "Against", "Client", "Client GSTIN", "Place of supply", "Taxable value", "CGST", "SGST/UTGST", "IGST", "Round off", "Total", "Received", "Credited", "Balance", "Status"],
    docs.map((d) => [d.issueDate, d.number, TYPE[d.docType] ?? d.docType, d.against ?? "", d.buyer.name ?? "", d.buyer.gstin ?? "", `${STATES[d.placeOfSupply]?.name ?? ""} (${d.placeOfSupply})`,
      rupees(d.taxable), rupees(d.cgst), rupees(d.sgst), rupees(d.igst), rupees(d.roundOff), rupees(d.total),
      d.docType === "invoice" ? rupees(d.paid) : "", d.docType === "invoice" ? rupees(d.credited) : "",
      d.docType === "invoice" ? rupees(Math.max(0, d.total - d.paid - d.credited)) : "", d.status]));
}

/** Zoho Books → Sales → Invoices → Import: one row per line; tax names follow Zoho's GST defaults (GST18 / IGST18). */
export function zohoInvoicesCsv(docs: ExportDoc[]): string {
  const rows: unknown[][] = [];
  for (const d of docs.filter((x) => x.docType === "invoice" && x.status !== "cancelled")) {
    for (const l of d.lines) {
      const tax = l.gstRate ? (d.taxMode === "intra" ? `GST${l.gstRate}` : `IGST${l.gstRate}`) : "";
      rows.push([d.issueDate, d.number, "Sent", d.buyer.name ?? "", d.buyer.gstin ? "business_gst" : "consumer", d.buyer.gstin ?? "", ZOHO_STATE[d.placeOfSupply] ?? "",
        d.dueDate ?? "", "INR", l.description, l.details ?? "", l.sac ?? "", l.qty, rupees(l.rate), rupees(l.discount), tax, l.gstRate, l.unit ?? "", "false", d.notes ?? "", d.terms ?? ""]);
    }
  }
  return csv(["Invoice Date", "Invoice Number", "Invoice Status", "Customer Name", "GST Treatment", "GST Identification Number (GSTIN)", "Place of Supply",
    "Due Date", "Currency Code", "Item Name", "Item Desc", "HSN/SAC", "Quantity", "Item Price", "Discount Amount", "Item Tax", "Item Tax %", "Usage unit", "Is Inclusive Tax", "Notes", "Terms & Conditions"], rows);
}

export type TallyLedgers = { sales: string; cgst: string; sgst: string; igst: string; roundOff: string };
export const TALLY_LEDGERS: TallyLedgers = { sales: "Sales - Services", cgst: "Output CGST", sgst: "Output SGST", igst: "Output IGST", roundOff: "Round Off" };
/** Tally Prime → Import → Vouchers: invoices as Sales and credit notes as Credit Note vouchers (accounting view). Debits
 *  are negative with ISDEEMEDPOSITIVE Yes, as Tally writes them. */
export function tallyXml(company: string, docs: ExportDoc[], ledgers: TallyLedgers = TALLY_LEDGERS): string {
  const entry = (ledger: string, paise: number) => paise === 0 ? "" :
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${paise < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${rupees(paise)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const vouchers = docs.filter((d) => ["invoice", "credit_note"].includes(d.docType) && d.status !== "cancelled").map((d) => {
    const sign = d.docType === "credit_note" ? -1 : 1; // a credit note reverses the sale
    const type = d.docType === "credit_note" ? "Credit Note" : "Sales";
    const party = d.buyer.name ?? "Customer";
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">`
      + `<DATE>${d.issueDate.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(d.number)}</VOUCHERNUMBER>`
      + `<REFERENCE>${xml(d.against ?? d.number)}</REFERENCE><PARTYLEDGERNAME>${xml(party)}</PARTYLEDGERNAME>${d.buyer.gstin ? `<PARTYGSTIN>${xml(d.buyer.gstin)}</PARTYGSTIN>` : ""}`
      + `<PLACEOFSUPPLY>${xml(STATES[d.placeOfSupply]?.name ?? "")}</PLACEOFSUPPLY><NARRATION>${xml(`${TYPE[d.docType]} ${d.number}${d.against ? ` against ${d.against}` : ""}`)}</NARRATION>`
      + `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`
      + entry(party, -sign * d.total) + entry(ledgers.sales, sign * d.taxable) + entry(ledgers.cgst, sign * d.cgst) + entry(ledgers.sgst, sign * d.sgst)
      + entry(ledgers.igst, sign * d.igst) + entry(ledgers.roundOff, sign * d.roundOff)
      + `</VOUCHER></TALLYMESSAGE>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>`
    + `<STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${vouchers.join("")}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
}
