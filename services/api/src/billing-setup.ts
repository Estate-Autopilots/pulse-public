// BILLING-SETUP (18 Oct 2026, EST-1359/1360): what Billing asks for, per company. An industry pack (Dealer & installer,
// Marketing & service agency first) is the starting shape: which optional fields show, the document chain's words,
// the item kinds and whether stock is kept. The company's own switches win over the pack. The database stores the pack
// and the switches on erp_settings and decides who may change them (Billing writers; 0540_billing_setup_stock_out.sql);
// this file holds the list itself, the same list as apps/web/app/erp/settings/fields.ts (test/billing-setup.test.mjs
// keeps them equal).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Tx } from "./routes.js";

type Body = Record<string, unknown>;
export type FieldGroup = "documents" | "lines" | "catalogue";
export type BillingField = { key: string; label: string; group: FieldGroup; shows: string; hint: string; base: boolean };
/** The optional fields: where each shows, and whether it shows for a company that picked no pack (today's screens). */
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

export type ChainStep = "quotation" | "proforma" | "invoice" | "delivery" | "booking" | "demand" | "receipt" | "order" | "estimate";
export type BillingPack = {
  id: string; name: string; example: string; ready: boolean; chain: { step: ChainStep; label: string }[];
  itemKinds: ("product" | "service" | "consumable" | "package")[]; defaultKind: "product" | "service" | "consumable" | "package"; inventory: boolean;
  line: string; extras: string; on: string[];
};
/** The packs. `on` lists the fields switched on; every other field starts off. Not-ready packs are shown as coming. */
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

/** The switches a company sees: the pack's starting set (or today's screens without one), then its own choices. */
export function effectiveFields(pack: string | null, saved: Record<string, unknown>) {
  const p = BILLING_PACKS.find((x) => x.id === pack && x.ready);
  return Object.fromEntries(BILLING_FIELDS.map((f) => [f.key, typeof saved[f.key] === "boolean" ? saved[f.key] as boolean : p ? p.on.includes(f.key) : f.base]));
}

async function setup(c: PoolClient) {
  const s = (await c.query(`select s.pack,s.pack_at "packAt",p.display_name "packBy",s.fields,s.inventory_enabled "inventoryEnabled" from pulse.erp_settings s
    left join pulse.person p on p.id=s.pack_by`)).rows[0] ?? { pack: null, packAt: null, packBy: null, fields: {}, inventoryEnabled: false };
  const write = (await c.query("select pulse.erp_can(true) w")).rows[0].w as boolean;
  const pack = BILLING_PACKS.some((x) => x.id === s.pack && x.ready) ? s.pack as string : null;
  return { pack, packAt: s.packAt, packBy: s.packBy, fields: effectiveFields(pack, s.fields ?? {}), saved: s.fields ?? {}, inventoryEnabled: !!s.inventoryEnabled,
    canWrite: write, catalogue: BILLING_FIELDS, packs: BILLING_PACKS };
}

export function registerBillingSetupRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Anyone who reads Billing reads its setup (the composer and the catalogue hide fields by it); Billing writers change it.
  app.get("/api/v0/erp/setup", (req) => tx(req, async (c) => {
    await c.query("select pulse.erp_require(false)"); await c.query("select pulse.erp_bootstrap()");
    return setup(c);
  }));
  app.post<{ Body: Body }>("/api/v0/erp/setup", (req) => tx(req, async (c) => {
    await c.query("select pulse.erp_require(true)");
    const b = req.body ?? {};
    const pack = b.pack === null || b.pack === undefined || b.pack === "" ? null : String(b.pack);
    if (pack !== null && !BILLING_PACKS.some((x) => x.id === pack && x.ready)) fail(400, "Choose the Dealer & installer or the Marketing & service agency pack");
    const given = b.fields && typeof b.fields === "object" && !Array.isArray(b.fields) ? b.fields as Body : {};
    const stray = Object.keys(given).find((k) => !FIELD_KEYS.includes(k));
    if (stray) fail(400, "That field is not on the list; reload the page");
    if (Object.values(given).some((v) => typeof v !== "boolean")) fail(400, "Each field is switched on or off");
    const fields = effectiveFields(pack, given);
    await c.query("select pulse.erp_setup_save($1)", [{ pack, fields, ...(typeof b.inventoryEnabled === "boolean" ? { inventoryEnabled: b.inventoryEnabled } : {}) }]);
    return setup(c);
  }));
}
