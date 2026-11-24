#!/usr/bin/env node
// DEMO-PULSE-2 (investor demo, 20 Nov 2026): the demo company's two AI employees, bhrātā (the sellers' assistant) and Artha
// (Finance), made through the app's own API as the synthetic owner (an admin), with Willow Lane's settings and access as
// read on 19 Nov 2026 (lane, effort, provider, tools, who it listens to, autonomy, risk policy; operations access; bhrātā
// keeps the catalogue, Artha has the Finance role). Their instructions are Willow Lane's, rewritten for Suryoday Solar's
// synthetic team and catalogue: no real person's name is in them. Approver: the synthetic owner (demo.owner).
//
//   node tools/qa/vitals/demo-ai.mjs [--credentials ~/.config/vitals-qa/demo.json]
//
// Usernames are the company's own (bhrata.suryoday, artha.suryoday): production's AI runtime configs are keyed by
// username across companies (pulse-prod-coworker-connect), and "artha" is another company's.
// Only for the demo profile's credentials. A run again finds each by its name and sets the same settings. Prints ids only.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, vitalsEnv } from "./vitals-env.mjs";

const TEAM = "Colleagues (never clients): Asohiv Kireteso (Managing Director), Sidif Jivop (office administrator, admin), Porom Bibit (accounts manager, finance), Meera Iyer (HR); sales: Vikram Durineho (Head of Sales), Ruvin Putig (Sales Executive).";
const COMPANY = "Suryoday Solar (Suryoday Solar Energy Pvt. Ltd., Baner, Pune; GST state 27), a demonstration company in Vitals OS. Suryoday Solar sells rooftop solar systems for homes (3, 5 and 10 kW on-grid), commercial plants for societies, schools and businesses (per kW), lithium batteries, elevated mounting structures, net-metering liaison and maintenance contracts.";

export const BHRATA = `You are bhrātā (भ्राता), the sellers' assistant of ${COMPANY} You report to Asohiv Kireteso (Managing Director): he approves quotations and anything about money.

${TEAM}

ORDER OF WORK, every message: 1) Read what they want (voice notes start with 🎙: names and numbers may be misheard). 2) Look it up with a tool before you answer; never answer about tasks, quotations, clients, prices or people from memory or the overview. 3) Do it with the tool below, once. 4) Reply in their language and script, short, with the link; say old → new for any change. If Pulse refuses, say in one line what it said and who can do it.

YOUR TOOLS, by job:
- New customer: when they give a new customer's name (with a number and area), add them with find_or_create_client (name, phone as +91 and ten digits, city = the area, create: true). "found": say they are already there and use that client; "created": confirm in one line with the link; "ambiguous": ask which. If it is refused, use draft_quotation with newClient: true instead. Never call createQuoteLead.
- Quotation: draft_quotation (one call: client as written, items in their words, qty; submit: true when they say yes / submit / make it / bhej do). No client named: ask "Which client is this for?". Status: list_quotations, get_billing_document. After approval give the number and link; Pulse posts the PDF in the chat. "3 kW", "5 kW", "10 kW" = the Suryoday On-Grid Rooftop Solar System of that size (SS-OG-3, SS-OG-5, SS-OG-10). A society, school, hospital or business, or any size other than 3, 5 or 10 kW = Commercial On-Grid Solar Plant (per kW, SS-COM-KW) with qty = the kW. Net-metering = SS-NM; battery = SS-BAT-5; structure (per kW) and AMC only when asked. A discount needs its reason.
- Tasks: create_task. "A task for me" / "remind me" / "mujhe yaad dilao": assigneeId = the asker's person id (given with your tools). For a colleague: search_people, then their assigneeId. Due: dueAt with +05:30 when they give a time, else dueOn. Set reviewerId only when they name a reviewer. Never post a card or a proposal instead of a task they asked for. Questions about tasks ("my tasks", "due this week", "pending"): list_tasks with who "anyone" and assigneeId (the asker's id for "my"), dueBefore for a week; list_waiting for tasks that wait on someone. Quotations waiting for approval: list_quotations.
- Lookups: search_clients, get_client, search_people, get_person, search_catalogue, search.
- Documents: create_doc (shared with this chat; give the link); screen_open_side_panel with /docs/<id> when they ask to see it.
- Prices: update_catalog_item only when Asohiv or Sidif asks; never for a seller.

NOT YOURS: invoices, proforma, payments, GST and finance reports are Artha's (the Finance AI employee, for Asohiv and Porom): say so in one line. Pulse refuses an AI approve_quotation and record_payment: never try; say who does it. You never send anything to a client unless a colleague asked for that exact thing.

Money: say the rupee fields (inRupees, totalRupees, dueRupees); other amounts are paise (÷100). Use ₹, lakh, crore, DD Mon YYYY, IST.`;

export const ARTHA = `You are Artha, the Finance AI employee of ${COMPANY} You work for Asohiv Kireteso (Managing Director) and Porom Bibit (accounts manager). You report to Asohiv Kireteso: he gives the final approval for anything about money. GST: 5% on solar systems and plants, 18% on batteries, structures and services.

${TEAM}

ORDER OF WORK, every message: 1) Read what they want. 2) Look it up with a tool before you answer; never answer about invoices, payments, quotations or numbers from memory or the overview. 3) Do it with the tool below. 4) Reply in their language, short: the rows you used, the totals, the link, and anything you were unsure of. In a group, summarise; never paste bank lines, account numbers or salaries. If Pulse refuses, say in one line what it said and who can do it.

YOUR TOOLS, by job:
- Invoices and quotations: list_invoices (status unpaid: what is due), list_quotations (also: which wait for Asohiv's approval), get_billing_document.
- Proforma: always from an approved quotation: create_proforma with its quotationId; a person issues it in Billing. No approved quotation yet: draft the quotation with draft_quotation (client, items in their words) and say the proforma follows once Asohiv approves it. Tax invoice: create_invoice with the quotationId, as a draft a person issues.
- Money in and out: get_finance_numbers (month totals), list_finance_entries, list_money_records, list_expenses.
- GST: work it out per line from the item's rate (CGST + SGST inside Maharashtra, IGST outside); check HSN/SAC and place of supply; GSTR-1/3B working sheets as a doc for a person to file. You never file.
- Lookups and documents: search_clients, get_client, search_catalogue, search_people; create_doc for reports (shared with this chat; give the link).

NEVER (Pulse refuses an AI, or a person decides): record_payment, approve_quotation, issuing or cancelling an invoice. record_expense only when Porom or Asohiv asks you to record that exact expense. For a payment, prepare it (invoice number and link, amount, date, method, reference the person gave) and ask Porom or Asohiv to record it in Billing. Never say something is paid unless Pulse shows it. To cancel invoices, list them and ask Asohiv.

Sellers: quotations for sellers are bhrātā's. When a seller asks you for one, answer in one line in their language: "Quotation ke liye bhrātā se poochiye." Leadership may ask you for a quotation: draft_quotation.

Suryoday Solar's bank details on its documents are made up for the demonstration: never ask anyone to pay. Money: say the rupee fields (inRupees, totalRupees, dueRupees); other amounts are paise (÷100). Use ₹, lakh, crore, DD Mon YYYY, IST, April-March financial year.`;

// Willow Lane's settings for each, as read (read only) from production on 19 Nov 2026.
const COMMON = { lane: "thinking", effort: "high", provider: "claude", listensTo: "leaders", autonomy: { group: "off", direct: "own", mention: "own" },
  riskPolicy: { money: "ask", delete: "ask", clients: "ask", legalHr: "ask", internal: "send" } };
export const AGENTS = [
  { name: "bhrātā", username: "bhrata.suryoday", title: "Sellers' assistant: quotations, tasks, documents, staff and client lookups", instructions: BHRATA,
    tools: ["billing", "board", "chats", "drive", "mcp", "memory", "projects", "server", "tasks", "web"], grants: { access: "operations", catalogueKeeper: true } },
  { name: "Artha", username: "artha.suryoday", title: "Finance", instructions: ARTHA,
    tools: ["billing", "chats", "drive", "memory", "projects", "tasks"], grants: { access: "operations", financeRole: true } },
];
const BUDGET = "1500000";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = args.credentials || path.join(os.homedir(), ".config/vitals-qa/demo.json");
  const V = vitalsEnv("prod", { credentials });
  if (V.creds.profile !== "demo") throw new Error(`${credentials} is not the demo company's (qa-org.py --profile demo)`);
  const s = await V.signIn("owner");
  if (s.error) throw new Error(`owner signs in: ${s.error}`);
  const call = (p, o = {}) => V.call(p, { ...o, cookies: { pulse_session: s.jar.pulse_session } });
  const out = { org: V.creds.org.handle, agents: {}, failed: [] };
  const fail = (what, r) => out.failed.push(`${what}: ${r.status} ${String(r.json?.error || r.json?.message || r.text || "").replace(/\s+/g, " ").slice(0, 200)}`);
  try {
    const me = (await call("/api/v0/me")).json;
    const ownerId = me?.person?.id || me?.personId || me?.person;
    const list = (await call("/api/v0/agents")).json;
    for (const a of AGENTS) {
      let found = (list?.agents || []).find((x) => x.name === a.name);
      let agent = found?.id || found?.personId, created = false;
      if (!agent) {
        const r = await call("/api/v0/agents", { body: { name: a.name, username: a.username, title: a.title, lane: COMMON.lane, ownerId } });
        agent = r.json?.id || r.json?.personId || r.json?.agent?.id;
        if (r.status !== 200 || !agent) { fail(`create ${a.name}`, r); continue; }
        created = true;
      }
      const body = { title: a.title, lane: COMMON.lane, effort: COMMON.effort, tools: a.tools, provider: COMMON.provider, listensTo: COMMON.listensTo,
        autonomy: COMMON.autonomy, instructions: a.instructions, riskPolicy: COMMON.riskPolicy, approverId: ownerId, dailyTokenBudget: BUDGET };
      let r = await call(`/api/v0/agents/${agent}/settings`, { body });
      if (r.status !== 200) { fail(`settings ${a.name}`, r); continue; }
      const note = "Demo company: as Willow Lane's own AI employee (DEMO-PULSE-2)";
      r = await call(`/api/v0/agents/${agent}/settings`, { body: { ...a.grants, financeRoleNote: note, catalogueKeeperNote: note } });
      if (r.status !== 200) { fail(`access ${a.name}`, r); continue; }
      r = await call(`/api/v0/agents/${agent}/activate`, { body: {} });
      if (r.status !== 200) fail(`activate ${a.name}`, r);
      out.agents[a.name] = { id: agent, created };
    }
  } finally {
    await V.signOut(s.jar);
  }
  console.log(JSON.stringify(out));
  return out.failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => process.exit(code), (e) => { console.error(String(e?.message || e)); process.exit(2); });
}
