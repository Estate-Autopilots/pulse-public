// BILLING-SETUP (18 Oct 2026): which optional fields a company's Billing shows, and the industry packs that set the
// starting list. The same list as services/api/src/billing-setup.ts (tests/core/test_billing_setup.py keeps the two
// equal). Screens read GET /api/v0/erp/setup → `fields` (every key, true or false) and hide what is off:
//   const setup = await api<BillingSetup>("erp/setup");   // a server page
//   const show = showField(setup.data, "deliveryBasis");  // true while the route is missing (no setup yet)
// Server- and client-safe: no hooks, no imports.

export type FieldGroup = "documents" | "lines" | "catalogue";
export type BillingField = { key: FieldKey; label: string; group: FieldGroup; shows: string; hint: string; base: boolean };
export type FieldKey = "validity" | "deliveryBasis" | "poNumber" | "project" | "siteAddress" | "ewayBill" | "serials" | "sitePhoto" | "blockShortStock" | "discount" | "addOns"
  | "openAmounts" | "months" | "costMargin" | "modelNumber" | "warranty" | "deliverables" | "team" | "partSetup";

/** The optional fields: where each shows, and `base`: whether it shows for a company that chose no pack (today's screens). */
export const BILLING_FIELDS: readonly BillingField[] = [
  { key: "validity", label: "Valid until", group: "documents", shows: "Quotations", hint: "How long a quote holds", base: true },
  { key: "deliveryBasis", label: "Delivery basis", group: "documents", shows: "Quotations and proformas", hint: "Ex-works, delivered to site", base: false },
  { key: "poNumber", label: "Client's PO number", group: "documents", shows: "Invoices", hint: "Printed beside the invoice number", base: true },
  { key: "project", label: "Project or campaign", group: "documents", shows: "Quotations and invoices", hint: "Which project the document is for", base: true },
  { key: "siteAddress", label: "Site or delivery address", group: "documents", shows: "Quotations, invoices, deliveries", hint: "Where the goods go", base: false },
  { key: "ewayBill", label: "E-way bill prompt", group: "documents", shows: "Invoices for goods above ₹50,000", hint: "A reminder with the number box", base: false },
  { key: "serials", label: "Serial numbers", group: "documents", shows: "Invoices and deliveries", hint: "One per unit handed over", base: false },
  { key: "sitePhoto", label: "Site photo", group: "documents", shows: "Quotations", hint: "A photo of the site with the quote", base: false },
  { key: "blockShortStock", label: "Refuse an invoice when stock is short", group: "documents", shows: "Issuing invoices, while stock is kept", hint: "Off: the invoice goes out and stock shows below zero", base: false },
  { key: "discount", label: "Discount column", group: "lines", shows: "Lines on every document", hint: "Off: prices stay as in the catalogue", base: true },
  { key: "addOns", label: "Add-on chips", group: "lines", shows: "Quotation lines", hint: "One tap adds an item's usual extras", base: false },
  { key: "openAmounts", label: "Installation and transport amounts", group: "lines", shows: "Quotations", hint: "Filled in or marked not needed", base: false },
  { key: "months", label: "Months and milestone plan", group: "lines", shows: "Packages on quotes and invoices", hint: "50% at start, 50% after 30 days", base: true },
  { key: "costMargin", label: "Cost and margin", group: "catalogue", shows: "Catalogue and packages", hint: "Seen by Billing writers only", base: true },
  { key: "modelNumber", label: "Model number", group: "catalogue", shows: "Products", hint: "Printed under the item name", base: false },
  { key: "warranty", label: "Warranty in months", group: "catalogue", shows: "Products", hint: "Printed on the invoice line", base: false },
  { key: "deliverables", label: "Deliverables per part", group: "catalogue", shows: "Package parts", hint: "Filled from the part name", base: true },
  { key: "team", label: "Team per part", group: "catalogue", shows: "Package parts", hint: "Who delivers each part", base: false },
  { key: "partSetup", label: "Where it lives, setup, what it feeds", group: "catalogue", shows: "Package parts", hint: "Behind More details", base: true },
];
export const FIELD_KEYS = BILLING_FIELDS.map((f) => f.key);
export const FIELD_GROUPS: { key: FieldGroup; label: string }[] = [
  { key: "documents", label: "On documents" }, { key: "lines", label: "On lines" }, { key: "catalogue", label: "In the catalogue" }];

export type ItemKind = "product" | "service" | "consumable" | "package";
export type ChainStep = "quotation" | "proforma" | "invoice" | "delivery" | "booking" | "demand" | "receipt" | "order" | "estimate";
export type PackId = "dealer" | "agency" | "developer" | "trader" | "professional";
export type BillingPack = {
  id: PackId; name: string; example: string; ready: boolean; chain: { step: ChainStep; label: string }[];
  itemKinds: ItemKind[]; defaultKind: ItemKind; inventory: boolean; line: string; extras: string; on: FieldKey[];
};
/** The packs: the document chain's words, the item kinds, stock, and the fields switched on (`on`; the rest start off). */
export const BILLING_PACKS: readonly BillingPack[] = [
  { id: "dealer", name: "Dealer & installer", example: "Solar, lithium backup, appliances, equipment", ready: true,
    chain: [{ step: "quotation", label: "Quotation" }, { step: "proforma", label: "Proforma" }, { step: "invoice", label: "Tax invoice" }, { step: "delivery", label: "Delivery challan" }],
    itemKinds: ["product", "service", "consumable"], defaultKind: "product", inventory: true,
    line: "Model, quantity +/−, add-ons, installation and transport", extras: "Serial numbers at delivery, an e-way bill prompt above ₹50,000, a site photo",
    on: ["validity", "deliveryBasis", "poNumber", "siteAddress", "ewayBill", "serials", "sitePhoto", "discount", "addOns", "openAmounts", "costMargin", "modelNumber", "warranty"] },
  { id: "agency", name: "Marketing & service agency", example: "Marketing, design, media and IT services", ready: true,
    chain: [{ step: "quotation", label: "Proposal" }, { step: "invoice", label: "Invoices by milestone" }],
    itemKinds: ["package", "service"], defaultKind: "service", inventory: false,
    line: "Package, months, milestone plan", extras: "Deliverables, team and cost per part behind More details, margin",
    on: ["validity", "poNumber", "project", "months", "costMargin", "deliverables", "team", "partSetup"] },
  { id: "developer", name: "Real-estate developer", example: "Units, charges, construction stages", ready: false,
    chain: [{ step: "booking", label: "Booking" }, { step: "demand", label: "Demand letter per stage" }, { step: "receipt", label: "Receipt" }],
    itemKinds: ["product", "service"], defaultKind: "product", inventory: false, line: "Unit, area, rate, stage %", extras: "Payment plan, interest on late payment", on: [] },
  { id: "trader", name: "Trader & distributor", example: "Products with variants", ready: false,
    chain: [{ step: "quotation", label: "Quotation" }, { step: "order", label: "Sales order" }, { step: "invoice", label: "Invoice" }, { step: "delivery", label: "Delivery" }],
    itemKinds: ["product", "consumable"], defaultKind: "product", inventory: true, line: "SKU, quantity, rate, discount", extras: "Stock per godown, batch and expiry", on: [] },
  { id: "professional", name: "Professional services", example: "Consultants, CAs, studios", ready: false,
    chain: [{ step: "estimate", label: "Estimate" }, { step: "invoice", label: "Invoice" }],
    itemKinds: ["service"], defaultKind: "service", inventory: false, line: "Service, hours, rate", extras: "Timesheet import, TDS", on: [] },
];

/** What GET /api/v0/erp/setup answers. */
export type BillingSetup = {
  pack: PackId | null; packAt: string | null; packBy: string | null; fields: Record<FieldKey, boolean>; saved: Partial<Record<FieldKey, boolean>>;
  inventoryEnabled: boolean; canWrite: boolean; catalogue: BillingField[]; packs: BillingPack[];
};

export const packOf = (id: string | null | undefined) => BILLING_PACKS.find((p) => p.id === id && p.ready) ?? null;
/** The switches a company sees: the pack's starting set (or today's screens without one), then its own choices. */
export function effectiveFields(pack: string | null | undefined, saved: Partial<Record<string, boolean>> = {}): Record<FieldKey, boolean> {
  const p = packOf(pack);
  return Object.fromEntries(BILLING_FIELDS.map((f) => [f.key, typeof saved[f.key] === "boolean" ? saved[f.key]! : p ? p.on.includes(f.key) : f.base])) as Record<FieldKey, boolean>;
}
/** Whether a screen shows a field. Without a setup (the route not deployed yet, or no access) every field shows as today. */
export const showField = (setup: Pick<BillingSetup, "fields"> | null | undefined, key: FieldKey) => setup?.fields?.[key] ?? BILLING_FIELDS.find((f) => f.key === key)?.base ?? true;
/** A document type's word in this company's chain: "Proposal" for an agency's quotation. */
export const chainWord = (pack: string | null | undefined, step: ChainStep, fallback: string) => packOf(pack)?.chain.find((c) => c.step === step)?.label ?? fallback;

/** These options have no consuming field yet. Stored choices are retained but never offered as working switches. */
export const UNAVAILABLE_FIELDS: readonly FieldKey[] = ["deliveryBasis", "siteAddress", "ewayBill", "serials", "sitePhoto", "openAmounts", "modelNumber", "warranty", "team"];
