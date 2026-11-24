#!/usr/bin/env node
// DEMO-PULSE-2 (investor demo, 20 Nov 2026; the orchestrator for the owner, 19 Nov 05:45 IST: "a separate demo company with
// a believable name ... seeded with realistic fake data"): fills the demo company "Suryoday Solar (Demo)" (@suryodaydemo,
// made by qa-org.py --profile demo) through the app's own API, as its synthetic people would type it: a rooftop-solar
// installer in Pune with Billing set up (made-up company details, a template with plainly made-up bank details, quotations
// approved by themselves up to ₹10 lakh as Willow Lane has it), a catalogue, customers, quotations in their stages, an issued
// proforma, two unpaid tax invoices, a project, tasks and a few chats.
//
//   1. python3 tools/admin/qa-org.py --profile demo --dsn-env /etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE \
//        --approver "…" --words "…" --apply                      (the company and its demo.* logins)
//   2. node tools/qa/vitals/demo-org.mjs [--credentials ~/.config/vitals-qa/demo.json] [--dry-run]
//
// Only for the demo profile's credentials (a test + rehearsal company: synthetic people, no e-mail, it never sends). Every
// name, address and number is made up; no phone numbers at all. A run again adds only what is missing (records are found
// by their names, a quotation by its customer). Prints counts only: never a password, a cookie or a key.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, vitalsEnv } from "./vitals-env.mjs";

const R = 100; // paise in a rupee (the API's amounts are paise)

export function demoFixture() {
  const settings = {
    company: { legalName: "Suryoday Solar Energy Pvt. Ltd. (Demo)", tradeName: "Suryoday Solar", stateCode: "27",
      address: ["Office 402, Sunshine Business Park, Baner Road", "Baner, Pune 411045, Maharashtra"] },
    dueDays: 15, roundTotal: true, inventoryEnabled: false,
    // As Willow Lane has it: no approval step for people; an AI employee's catalogue-price quotation approves itself up to ₹10 lakh.
    quoteApproval: false, quoteAutoApprove: true, quoteAutoLimit: 10_00_000 * R, costVisibility: "finance",
  };
  const template = {
    name: "Suryoday Solar",
    design: { style: "band", accent: "#e8711a", fontScale: 1,
      terms: "1. Price includes supply, installation and commissioning unless stated otherwise.\n2. Payment: 70% advance with the order, 25% on installation, 5% after net-meter commissioning.\n3. Any government subsidy, where eligible, is credited by the government directly to the customer.\n4. This quotation is valid for 30 days. Subject to Pune jurisdiction.",
      // Plainly made-up: a demo company takes no money.
      bank: { accountName: "Suryoday Solar Energy Pvt. Ltd. (Demo)", bankName: "Demo Bank Ltd.", branch: "Baner, Pune", accountNumber: "0000 0000 1234 (demo)", ifsc: "DEMO0000001", upi: "" },
      signature: { label: "Authorised Signatory", name: "Asohiv Kireteso", title: "Managing Director", showImage: false },
      footer: "Suryoday Solar (Demo) is a demonstration company in Vitals OS, not a real business. Do not pay against this document." },
    defaultFor: ["quotation", "proforma", "invoice"],
  };
  // [code, name, kind, unit, price ₹, GST %, HSN/SAC, description]
  const items = [
    ["SS-OG-3", "Suryoday 3 kW On-Grid Rooftop Solar System", "product", "Nos", 1_89_000, 5, "8541", "3 kW mono-PERC panels, 3 kW on-grid inverter, GI structure, DC/AC wiring, earthing and installation."],
    ["SS-OG-5", "Suryoday 5 kW On-Grid Rooftop Solar System", "product", "Nos", 2_95_000, 5, "8541", "5 kW mono-PERC panels, 5 kW on-grid inverter, GI structure, DC/AC wiring, earthing and installation."],
    ["SS-OG-10", "Suryoday 10 kW On-Grid Rooftop Solar System", "product", "Nos", 5_65_000, 5, "8541", "10 kW mono-PERC panels, 10 kW three-phase on-grid inverter, GI structure, wiring, earthing and installation."],
    ["SS-COM-KW", "Commercial On-Grid Solar Plant (per kW)", "product", "kW", 46_500, 5, "8541", "For societies, schools and businesses: panels, string inverters, structure, wiring and installation, per kW."],
    ["SS-BAT-5", "Lithium-Ion Battery Bank 5 kWh", "product", "Nos", 1_35_000, 18, "8507", "5 kWh LiFePO4 battery with BMS for backup during power cuts."],
    ["SS-STR-KW", "Elevated GI Mounting Structure (per kW)", "product", "kW", 5_500, 18, "7308", "Hot-dip galvanised elevated structure for terraces, per kW."],
    ["SS-NM", "Net-Metering Application & DISCOM Liaison", "service", "Nos", 12_000, 18, "9983", "Application, documents and follow-up until the net meter is installed."],
    ["SS-AMC", "Annual Maintenance Contract (per year)", "service", "Year", 9_500, 18, "9987", "Quarterly panel cleaning, inverter health check and generation report."],
  ].map(([code, name, kind, unit, price, gstRate, sac, description]) => ({ code, name, kind, unit, price: price * R, gstRate, sac, description }));
  // Customers in Pune (no phone numbers: nobody can be reached by mistake).
  const clients = [
    { key: "amafot", kind: "person", displayName: "Amafot Dorugohum", city: "Aundh, Pune" },
    { key: "sunrise", kind: "company", companyName: "Sunrise Apartments Co-op Housing Society", contact: { name: "Prakash Gokhale" }, city: "Wakad, Pune" },
    { key: "kedab", kind: "person", displayName: "Kedab Jivop", city: "Kothrud, Pune" },
    { key: "greenfield", kind: "company", companyName: "Greenfield Dairy Farms", contact: { name: "Sadafu Podinifaba" }, city: "Hinjawadi, Pune" },
    { key: "neha", kind: "person", displayName: "Neha Kapoor", city: "Viman Nagar, Pune" },
    { key: "lotus", kind: "company", companyName: "Lotus Care Clinic", contact: { name: "Dr. Amit Bapubos" }, city: "Pimple Saudagar, Pune" },
    { key: "arvind", kind: "person", displayName: "Arvind Rane", city: "Hadapsar, Pune" },
    { key: "meadow", kind: "company", companyName: "Meadowbrook School", contact: { name: "Sunita Rao" }, city: "Bavdhan, Pune" },
    { key: "vivek", kind: "person", displayName: "Vivek Soniba", city: "Pashan, Pune" },
  ];
  // Quotations, each drafted by the seller: [client, stage, [item code, qty, discount reason?]...]. Stages: draft, approval
  // (waits on the owner), issued (approved), sent, negotiating, accepted; "proforma" and "invoice" are accepted ones
  // turned into an issued proforma or an issued (unpaid) tax invoice.
  const quotes = [
    { client: "amafot", stage: "sent", lines: [["SS-OG-5", 1], ["SS-NM", 1]] },
    { client: "kedab", stage: "issued", lines: [["SS-OG-3", 1], ["SS-STR-KW", 3], ["SS-NM", 1]] },
    { client: "greenfield", stage: "proforma", lines: [["SS-COM-KW", 25], ["SS-STR-KW", 25], ["SS-NM", 1], ["SS-AMC", 1]] },
    { client: "neha", stage: "draft", lines: [["SS-OG-5", 1], ["SS-BAT-5", 1]] },
    { client: "lotus", stage: "approval", lines: [["SS-OG-10", 1], ["SS-AMC", 1]] },
    { client: "arvind", stage: "negotiating", lines: [["SS-OG-3", 1], ["SS-NM", 1]] },
    { client: "meadow", stage: "invoice", lines: [["SS-OG-10", 1], ["SS-STR-KW", 10], ["SS-NM", 1], ["SS-AMC", 1]] },
    { client: "vivek", stage: "invoice", lines: [["SS-OG-5", 1], ["SS-NM", 1]] },
  ];
  const project = { title: "Greenfield Dairy Farms – 25 kW rooftop plant", client: "greenfield" };
  // [title, who (role key), due in days, priority, on the project?]
  const tasks = [
    ["Site survey at Amafot Dorugohum's home, Aundh", "seller", 1, "high", false],
    ["Call Kedab Jivop about the approved 3 kW quotation", "seller", 0, "high", false],
    ["Follow up Lotus Care Clinic on the 10 kW proposal", "seller", 2, "normal", false],
    ["Panel cleaning visit for Vivek Soniba, Pashan", "seller", 5, "low", false],
    ["Roof layout for Sunrise Apartments (40 kW)", "sales_head", 3, "high", false],
    ["Update the price list for 10 kW systems", "sales_head", -1, "normal", false],
    ["Weekly sales review with the team", "sales_head", 4, "normal", false],
    ["Collect the advance from Meadowbrook School", "finance", 2, "high", false],
    ["Submit the net-metering file for Greenfield Dairy Farms", "admin", 3, "normal", true],
    ["Inverter commissioning at Greenfield Dairy Farms", "sales_head", 6, "urgent", true],
  ];
  // Direct chats: [from, to, message].
  const chats = [
    ["owner", "seller", "Ruvin, please do the site survey at Amafot Dorugohum's place tomorrow morning."],
    ["seller", "owner", "Sure sir, 10:30 slot is fixed. I'll share the roof photos after the visit."],
    ["sales_head", "seller", "Sunrise Apartments wants a 40 kW quote this week. Let's take the roof measurements on Friday."],
    ["finance", "owner", "Meadowbrook School's invoice is due in two weeks. I'll remind them on Monday."],
  ];
  // The doc the demo opens (Docs): big numbers, a chart from its own data table, a table by salesperson, next steps.
  const block = (b) => `<div data-type="pulse-block" data-kind="${b.kind}" data-id="${b.id}" data-block="${JSON.stringify(b).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`;
  const doc = { title: "November sales review", access: "company", html: [
    "<h1>November sales review</h1>",
    "<p>Suryoday Solar · sales team · 1 to 18 November 2026. Numbers for the demonstration.</p>",
    block({ kind: "stat", id: "b_novstat1", title: "This month so far", items: [
      { value: "₹48.6 L", label: "Quoted", delta: "+18% vs October", tone: "good" }, { value: "₹24.3 L", label: "Won", delta: "+9% vs October", tone: "good" },
      { value: "38%", label: "Win rate", delta: "-2 pts", tone: "bad" }, { value: "62 kW", label: "Solar sold", delta: "+14 kW", tone: "good" }] }),
    "<h2>Quoted and won by week (₹ lakh)</h2>",
    block({ kind: "chart", id: "b_novchart1", type: "bar", title: "Quoted and won by week (₹ lakh)", columns: ["Week", "Quoted", "Won"],
      rows: [["Week 1", 9.8, 4.2], ["Week 2", 14.5, 6.4], ["Week 3", 12.1, 7.9], ["Week 4", 12.2, 5.8]] }),
    "<h2>By salesperson</h2>",
    block({ kind: "chart", id: "b_novtable1", type: "table", title: "By salesperson", columns: ["Salesperson", "Quotations", "Won", "Won (₹ lakh)"],
      rows: [["Ruvin Putig", 9, 4, 11.6], ["Vikram Durineho", 5, 2, 12.7]] }),
    "<h2>Next steps</h2>",
    "<ul><li>Sunrise Apartments: 40 kW proposal to the society committee by Friday.</li><li>Lotus Care Clinic: approval of the 10 kW quotation.</li><li>Meadowbrook School: collect the advance on INV/26-27/0001.</li></ul>",
  ].join("") };
  return { settings, template, items, clients, quotes, project, tasks, chats, doc };
}

const listOf = (j, ...keys) => (Array.isArray(j) ? j : keys.map((k) => j?.[k]).find(Array.isArray) || []);
const day = (n) => new Date(Date.now() + n * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
const clientName = (c) => c.displayName || c.companyName;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = args.credentials || path.join(os.homedir(), ".config/vitals-qa/demo.json");
  const fx = demoFixture();
  if (args["dry-run"]) {
    console.log(JSON.stringify({ dryRun: true, items: fx.items.length, clients: fx.clients.length, quotes: fx.quotes.length, tasks: fx.tasks.length, chats: fx.chats.length }));
    return 0;
  }
  const V = vitalsEnv("prod", { credentials });
  if (V.creds.profile !== "demo") throw new Error(`${credentials} is not the demo company's (qa-org.py --profile demo)`);
  const out = { org: V.creds.org.handle, made: {}, existed: {}, failed: [] };
  const count = (k, made) => { const o = made ? out.made : out.existed; o[k] = (o[k] || 0) + 1; };
  const fail = (what, r) => out.failed.push(`${what}: ${r.status} ${String(r.json?.error || r.json?.message || r.text || "").replace(/\s+/g, " ").slice(0, 160)}`);
  const ok = (r) => r.status === 200 || r.status === 201;
  const sessions = [];
  const people = {};
  const as = async (role) => {
    const s = await V.signIn(role);
    if (s.error) throw new Error(`${role} signs in: ${s.error}`);
    sessions.push(s.jar);
    const call = (p, o = {}) => V.call(p, { ...o, cookies: { pulse_session: s.jar.pulse_session } });
    const me = await call("/api/v0/me");
    const who = { call, id: me.json?.person?.id || me.json?.personId || me.json?.person };
    people[role] = who;
    return who;
  };
  try {
    const owner = await as("owner");
    const seller = await as("seller");
    for (const r of ["sales_head", "finance", "admin"]) await as(r);

    // Billing: bootstrap, the company's details and approval rules, then the template (default for quotation/proforma/invoice).
    await owner.call("/api/v0/erp/setup");
    const st = await owner.call("/api/v0/erp/settings");
    const want = fx.settings;
    const co = st.json?.company || {};
    if (co.legalName !== want.company.legalName || st.json?.quoteAutoApprove !== true || st.json?.quoteAutoLimit !== want.quoteAutoLimit) {
      const r = await owner.call("/api/v0/erp/settings", { body: { ...want, company: { ...co, ...want.company } } });
      ok(r) ? count("settings", true) : fail("Billing settings", r);
    } else count("settings", false);
    const tl = await owner.call("/api/v0/erp/templates");
    let tpl = listOf(tl.json, "templates", "items").find((t) => t.name === fx.template.name);
    if (!tpl) {
      const r = await owner.call("/api/v0/erp/templates", { body: { name: fx.template.name } });
      if (ok(r) && r.json?.id) { tpl = { id: r.json.id }; count("template", true); } else fail("template", r);
    } else count("template", false);
    if (tpl) {
      const r = await owner.call(`/api/v0/erp/templates/${tpl.id}`, { body: { design: fx.template.design, defaultFor: fx.template.defaultFor } });
      if (!ok(r)) fail("template design", r);
    }

    // Catalogue (the owner adds the items, active at once: no item approval in this company).
    const haveItems = new Map(listOf((await owner.call("/api/v0/erp/items?size=200")).json, "items").map((i) => [i.code, i.id]));
    for (const it of fx.items) {
      if (haveItems.has(it.code)) { count("items", false); continue; }
      const r = await owner.call("/api/v0/erp/items", { body: { ...it, status: "active", trackStock: false } });
      const iid = r.json?.id || r.json?.item?.id;
      if (ok(r) && iid) { haveItems.set(it.code, iid); count("items", true); } else fail(`item ${it.code}`, r);
    }

    // Customers.
    const haveClients = new Map(listOf((await owner.call("/api/v0/clients")).json, "clients").map((c) => [c.displayName || c.name || c.companyName, c.id]));
    const clientId = {};
    for (const c of fx.clients) {
      const name = clientName(c);
      if (haveClients.has(name)) { clientId[c.key] = haveClients.get(name); count("clients", false); continue; }
      const body = c.kind === "company" ? { kind: "company", companyName: c.companyName, contact: { ...c.contact, city: c.city }, city: c.city }
        : { kind: "person", displayName: c.displayName, city: c.city };
      const r = await owner.call("/api/v0/clients", { body });  // People → Clients is an admin's (a seller gets 403)
      if (ok(r) && r.json?.id) { clientId[c.key] = r.json.id; haveClients.set(name, r.json.id); count("clients", true); } else fail(`client ${name}`, r);
    }

    // Quotations: the seller drafts each; the owner approves (issues) and marks what the customer did.
    const docs = listOf((await owner.call("/api/v0/erp/documents?type=quotation&size=200")).json, "documents", "items", "docs");
    const quoted = new Set(docs.map((d) => d.clientId || d.client?.id).filter(Boolean));
    const byCode = new Map(fx.items.map((i) => [i.code, i]));
    for (const [n, q] of fx.quotes.entries()) {
      const cid = clientId[q.client];
      if (!cid) { out.failed.push(`quote for ${q.client}: no client`); continue; }
      if (quoted.has(cid)) { count("quotes", false); continue; }
      const c = fx.clients.find((x) => x.key === q.client);
      const made = await seller.call("/api/v0/erp/documents", { body: { docType: "quotation", clientId: cid, siteLocation: c.city } });
      const docId = made.json?.id || made.json?.document?.id;
      if (!ok(made) || !docId) { fail(`quote ${q.client} draft`, made); continue; }
      const lines = q.lines.map(([code, qty]) => { const it = byCode.get(code); return { itemId: haveItems.get(code), description: it.name, details: it.description,
        sac: it.sac, unit: it.unit, qty, rate: it.price, gstRate: it.gstRate }; });
      const draft = { issueDate: day(-(12 - n)), validUntil: day(18 + n), buyer: { name: clientName(c), stateCode: "27", address: [c.city, "Maharashtra"] }, lines,
        notes: "Thank you for considering Suryoday Solar. Generation estimate: about 4 units per kW per day.", siteLocation: c.city };
      const steps = [];
      if (q.stage === "draft") steps.push(["save", seller, `/api/v0/erp/documents/${docId}`, draft]);
      else if (q.stage === "approval") steps.push(["ask", seller, `/api/v0/erp/documents/${docId}/approval`, { to: owner.id, note: "Please approve: clinic wants it before month end.", draft }]);
      else {
        steps.push(["save", seller, `/api/v0/erp/documents/${docId}`, draft], ["issue", owner, `/api/v0/erp/documents/${docId}/issue`, {}]);
        if (q.stage !== "issued") steps.push(["sent", seller, `/api/v0/erp/documents/${docId}/mark`, { action: "sent" }]);
        if (q.stage === "negotiating") steps.push(["negotiating", seller, `/api/v0/erp/documents/${docId}/mark`, { action: "negotiating", note: "Customer asked for a better price on the structure." }]);
        if (["proforma", "invoice"].includes(q.stage)) steps.push(["accepted", seller, `/api/v0/erp/documents/${docId}/mark`, { action: "accepted", note: "Customer confirmed on call." }]);
      }
      let good = true;
      for (const [name, who, p, body] of steps) {
        const r = await who.call(p, { body });
        if (!ok(r)) { fail(`quote ${q.client} ${name}`, r); good = false; break; }
      }
      if (good && ["proforma", "invoice"].includes(q.stage)) {
        // Finance turns the accepted quotation into an issued proforma, or an issued tax invoice left unpaid.
        const fin = people.finance;
        const conv = await fin.call("/api/v0/erp/documents", { body: { docType: q.stage, sourceId: docId } });
        const cidoc = conv.json?.id || conv.json?.document?.id;
        if (!ok(conv) || !cidoc) { fail(`${q.stage} for ${q.client}`, conv); good = false; }
        else {
          const r = await fin.call(`/api/v0/erp/documents/${cidoc}/issue`, { body: {} });
          if (!ok(r)) { fail(`${q.stage} for ${q.client} issue`, r); good = false; } else count(q.stage, true);
        }
      }
      if (good) { count("quotes", true); quoted.add(cid); }
    }

    // The project, then the tasks (as the owner, an admin), spread over the team.
    const haveProjects = new Map(listOf((await owner.call("/api/v0/projects")).json, "projects").map((p) => [p.title || p.name, p.projectId || p.id]));
    let projectId = haveProjects.get(fx.project.title);
    if (!projectId) {
      const r = await owner.call("/api/v0/projects", { body: { title: fx.project.title, clientId: clientId[fx.project.client] || null } });
      if (ok(r) && r.json?.id) { projectId = r.json.id; count("projects", true); } else fail("project", r);
    } else count("projects", false);
    const haveTasks = new Set(listOf((await owner.call("/api/v0/tasks?size=400")).json, "rows").map((t) => t.title));
    for (const [title, who, due, priority, onProject] of fx.tasks) {
      if (haveTasks.has(title)) { count("tasks", false); continue; }
      const body = { title, assigneeId: people[who]?.id, priority, dueOn: day(due) };
      if (onProject && projectId) body.projectId = projectId;
      const r = await owner.call("/api/v0/tasks", { body });
      if (ok(r)) { haveTasks.add(title); count("tasks", true); } else fail(`task ${title}`, r);
    }

    // A few direct chats, so the seller's and the owner's Chats are not empty (once: skipped when the chat has messages).
    for (const [from, to, text] of fx.chats) {
      const a = people[from], b = people[to];
      const d = await a.call("/api/v0/chats/direct", { body: { personId: b.id } });
      const ch = d.json?.id;
      if (!ok(d) || !ch) { fail(`chat ${from}→${to}`, d); continue; }
      const msgs = listOf((await a.call(`/api/v0/chats/${ch}/messages`)).json, "messages", "rows");
      if (msgs.some((m) => (m.body || m.text) === text)) { count("chats", false); continue; }
      const r = await a.call(`/api/v0/chats/${ch}/messages`, { body: { body: text, clientId: crypto.randomUUID() } });
      ok(r) ? count("chats", true) : fail(`chat ${from}→${to} message`, r);
    }

    // The demo doc, written by the owner and open to the whole company (found again by its title).
    const haveDocs = listOf((await owner.call("/api/v0/docs")).json, "docs", "items", "rows");
    if (haveDocs.some((d) => d.title === fx.doc.title)) count("docs", false);
    else {
      const r = await owner.call("/api/v0/docs", { body: { title: fx.doc.title, html: fx.doc.html, access: fx.doc.access } });
      ok(r) && r.json?.doc?.id ? count("docs", true) : fail("doc", r);
    }
  } finally {
    for (const jar of sessions) await V.signOut(jar);
  }
  console.log(JSON.stringify(out));
  return out.failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => process.exit(code), (e) => { console.error(String(e?.message || e)); process.exit(2); });
}
