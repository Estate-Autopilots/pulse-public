// WL-FLOWS (owner order, 19 Nov 2026: "make Willow Lane automated and workflows tested"): Willow Lane's working day as journeys,
// nightly on DEV in the QA company (synthetic people; never production), each person in their own session and each AI
// employee with its own key, exactly as their screens and runtime call Pulse. The AI employees are the QA copies of Wise
// Life's bhrātā and Artha (ai-task-set.py --prepare: production's settings and access, a dev key). The journeys call
// their tools directly, as the runtime does after the model chose them, so they cost no tokens and fail only on Pulse.
// The model's choices are the AI task set's part (ai-tasks/wl-*.json).
//
//   wl-lead      bhrātā adds a new customer for a seller (create_quote_lead: name, phone, area, requirement, salesperson)
//   wl-quote     bhrātā drafts the quotation from the seller's words in the seller's chat; at catalogue prices within the
//                company's limit it is approved by the rule at once and its PDF is in the chat (QUOTE-FAST)
//   wl-approval  over the limit (₹10 lakh, as Willow Lane) it waits for the owner: the owner's bell has it, the owner approves,
//                and the PDF reaches the seller's chat by itself
//   wl-proforma  Artha makes the proforma from the approved quotation (create_proforma, "100% advance"); Finance issues it
//                (numbered, PDF)
//   wl-task      bhrātā gives the seller a task (call the customer); the seller sees it and finishes it; the reviewer accepts
//   wl-followup  the seller marks the quotation sent; its follow-up is scheduled for the seller; when due, the minute tick
//                gives the seller a follow-up task and a notice; the seller records the customer's answer
//   wl-reminder  the seller asks to be reminded about the quotation in the chat; it rings (notice) when due
//   wl-checkin   the seller checks in and out (attendance on, as at Willow Lane)
//
// Each journey is one line in journeys.json (and so one fingerprint in the ledger). A journey that needs an earlier one's
// result (the quotation) fails with "needs wl-quote" when that one failed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// In Willow Lane's order: the quotation is sent and followed up before the customer says yes and pays against the proforma
// (a proforma converts the quotation, which ends its follow-up).
export const WL_FLOWS = ["wl-lead", "wl-quote", "wl-approval", "wl-followup", "wl-reminder", "wl-proforma", "wl-task", "wl-checkin"];

const PY = fs.existsSync("/opt/ea-watchdog/venv/bin/python") ? "/opt/ea-watchdog/venv/bin/python" : "python3";
const HERE = path.dirname(new URL(import.meta.url).pathname);
// The QA company's catalogue item the journeys quote (Willow Lane sells "5 kW" systems; a GST rate Willow Lane uses).
const ITEM = { kind: "product", code: "QA-WL-5KW", name: "QA PuREPower 5 kW solar system (synthetic)", price: 25_000_000, gstRate: 12, unit: "Nos", status: "active" };
const LIMIT = 100_000_000; // ₹10,00,000 in paise: Willow Lane's auto-approve limit (erp_settings.quote_auto_limit)

/** The journeys, bound to journeys.mjs's people and helpers. */
export function wlFlows({ V, person, must, waitFor, Step, sleep, log, credentials }) {
  const state = {};
  const ok2 = (r) => r.status === 200 || r.status === 201;
  const day = (n = 0) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  const json = (x) => JSON.stringify(x ?? null);

  // ---- the AI employees: the QA copies, each with its own key (Authorization: Bearer, API v1) ----
  let copies;
  function ai(set) {
    copies = copies || (() => {
      const f = path.join(os.homedir(), ".config/vitals-qa/dev-agent-keys/copies.json");
      try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { throw new Step("the QA copies", `${f} missing: run ai-task-set.py --prepare wl-bhrata,wl-artha`); }
    })();
    const c = copies[set];
    if (!c) throw new Step("the QA copies", `${set} not prepared (ai-task-set.py --prepare ${set})`);
    const key = fs.readFileSync(c.keyFile, "utf8").trim();
    // API v1 wants a fresh Idempotency-Key on every write (the runtime sends one per tool call).
    const write = (o) => o.body !== undefined && (o.method || "POST") !== "GET";
    return { id: c.agentId, role: set, as: (p, o = {}) => V.call(p, { ...o, headers: { ...(o.headers || {}), authorization: `Bearer ${key}`, ...(write(o) ? { "idempotency-key": randomUUID() } : {}) } }) };
  }

  // ---- the QA company set up as Willow Lane works: auto-approve at ₹10 lakh, a catalogue item, attendance on ----
  async function setup() {
    if (state.setup) return state.setup;
    const owner = await person("owner");
    const s = must(await owner.as("/api/v0/erp/settings"), "owner reads Billing settings");
    if (!s.quoteAutoApprove || s.quoteAutoLimit !== LIMIT) {
      const { company, inventoryEnabled, dueDays, roundTotal, quoteApproval, costVisibility } = s;
      must(await owner.as("/api/v0/erp/settings", { body: { company, inventoryEnabled, dueDays, roundTotal, quoteApproval, costVisibility, quoteAutoApprove: true, quoteAutoLimit: LIMIT } }),
        "owner turns on auto-approve up to ₹10 lakh (as Willow Lane)");
    }
    const items = must(await owner.as("/api/v0/erp/items"), "owner reads the catalogue");
    let item = (items.items || items.rows || (Array.isArray(items) ? items : [])).find((i) => i.code === ITEM.code && i.status !== "archived");
    if (!item) item = must(await owner.as("/api/v0/erp/items", { body: ITEM }), "owner adds the catalogue item (once)", ok2);
    else if (Number(item.price) !== ITEM.price) throw new Step("the catalogue item", `${ITEM.code} costs ${item.price} paise, expected ${ITEM.price}`);
    const fx = JSON.parse(execFileSync(PY, ["-I", path.join(HERE, "wl-dev.py"), "fixture", ...(credentials ? ["--credentials", credentials] : [])], { encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop());
    if (!fx.ok) throw new Step("attendance on for the QA company", fx.error);
    return (state.setup = { itemId: item.id });
  }

  const messagesOf = async (p, chat) => { const r = must(await p.as(`/api/v0/chats/${chat}/messages`), `${p.role} reads the chat`); return Array.isArray(r) ? r : r.messages || r.items || []; };
  const pdfsFrom = (list, authorId, after) => list.filter((m) => (m.authorId || m.author?.id || m.personId) === authorId && Date.parse(m.createdAt || m.at || m.created_at || 0) >= after - 5_000
    && (m.attachments || []).some?.((a) => a?.mime === "application/pdf" || /\.pdf$/i.test(String(a?.name || ""))));
  const noticesOf = async (p) => json(must(await p.as("/api/v0/notices"), `${p.role} reads the bell`));
  const need = (k, from) => { if (!state[k]) throw new Step(`needs ${from}`, `${from} did not finish, so this journey has nothing to work on`); return state[k]; };

  async function fetchPdf(p, url, step) {
    const r = await p.as(url);
    if (r.status !== 200 || !r.text.startsWith("%PDF")) throw new Step(step, `${r.status} ${r.text.slice(0, 60).replace(/\s+/g, " ")}`);
    return r.text.length;
  }

  return {
    // A new customer, added by bhrātā for the seller (Willow Lane's sellers send a name, number and area in chat).
    "wl-lead": async () => {
      await setup();
      const seller = await person("seller"), bhrata = ai("wl-bhrata");
      const token = randomUUID().slice(0, 6), phone = `+9190${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
      const name = `QA WL Lead ${token} (synthetic)`;
      const t0 = Date.now();
      const lead = must(await bhrata.as("/api/v1/billing/quote-leads", { body: { name, phone, area: "Pune (QA)", requirement: "5 kW solar system for the roof (QA journey)", salespersonId: seller.id } }),
        "bhrātā adds the customer (create_quote_lead)", ok2);
      // The same number again is refused with the existing customer, not a second one.
      const again = await bhrata.as("/api/v1/billing/quote-leads", { body: { name: `${name} again`, phone, area: "Pune (QA)", salespersonId: seller.id } });
      if (again.status !== 409) throw new Step("one customer per phone number", `second add answered ${again.status}`);
      // The seller finds the customer to quote (Billing's client search, the seller's own seat).
      const found = must(await seller.as(`/api/v0/erp/parties?q=${encodeURIComponent(name)}`), "the seller finds the customer");
      if (!json(found).includes(lead.leadId)) throw new Step("the seller finds the customer", "not in the seller's client search");
      state.lead = { id: lead.leadId, name };
      return { leadId: lead.leadId, ms: Date.now() - t0 };
    },

    // The seller asks bhrātā in their chat; at catalogue prices within the limit the PDF is in the chat at once.
    "wl-quote": async () => {
      const { itemId } = await setup();
      const lead = need("lead", "wl-lead");
      const seller = await person("seller"), bhrata = ai("wl-bhrata");
      const chat = must(await seller.as("/api/v0/chats/direct", { body: { personId: bhrata.id } }), "the seller opens the chat with bhrātā").id;
      const t0 = Date.now();
      const q = must(await bhrata.as("/api/v1/billing/quotations/from-words", { body: { clientId: lead.id, items: [{ words: "5 kW QA PuREPower solar system", qty: 1 }], lang: "en", chatId: chat, askedById: seller.id } }),
        "bhrātā drafts the quotation from the seller's words (draft_quotation)");
      if (q.status !== "approved") throw new Step("approved by the company's rule (≤ ₹10 lakh, catalogue prices)", `status ${q.status}${q.questions?.length ? `; asked: ${q.questions.join(" | ").slice(0, 120)}` : ""}`);
      const line = q.quotation?.lines?.[0];
      if (!line || Math.round(line.rate) !== ITEM.price || q.quotation.lines.length !== 1) throw new Step("the catalogue item at its price", json(q.quotation?.lines).slice(0, 160));
      if (!q.quotation.number) throw new Step("numbered", "no quotation number");
      const pdf = await waitFor(async () => pdfsFrom(await messagesOf(seller, chat), bhrata.id, t0)[0], 20_000, "the PDF is in the seller's chat");
      const file = (pdf.v.attachments || []).find((a) => a.mime === "application/pdf" || /\.pdf$/i.test(a.name));
      const bytes = await fetchPdf(seller, `/api/v0/chats/files/${file.id}`, "the seller opens the PDF");
      state.quote = { id: q.quotation.id, number: q.quotation.number, total: q.quotation.total, chat, pdfMessage: pdf.v.id };
      return { number: q.quotation.number, total: q.quotation.total, itemId, pdfBytes: bytes, askToPdfMs: Date.now() - t0 };
    },

    // Over ₹10 lakh: it waits for the owner; the owner approves from the bell; the PDF reaches the seller's chat.
    "wl-approval": async () => {
      await setup();
      const lead = need("lead", "wl-lead"), q1 = need("quote", "wl-quote");
      const owner = await person("owner"), seller = await person("seller"), bhrata = ai("wl-bhrata");
      const t0 = Date.now();
      const q = must(await bhrata.as("/api/v1/billing/quotations/from-words", { body: { clientId: lead.id, items: [{ words: "5 kW QA PuREPower solar system", qty: 4 }], lang: "en", chatId: q1.chat, askedById: seller.id } }),
        "bhrātā drafts a quotation over the limit");
      if (q.quotation?.total <= LIMIT) throw new Step("over the limit", `total ${q.quotation?.total}`);
      if (q.status === "approved") throw new Step("over ₹10 lakh waits for the owner", "approved by the rule");
      if (q.status !== "submitted" && !q.quotation?.waitingFor) throw new Step("sent to the owner for approval", `status ${q.status}`);
      const docId = q.quotation.id;
      const asked = await waitFor(async () => (await noticesOf(owner)).includes(docId), 30_000, "the approval reaches the owner's bell");
      must(await owner.as(`/api/v0/erp/documents/${docId}/issue`, { body: {} }), "the owner approves");
      const pdf = await waitFor(async () => pdfsFrom(await messagesOf(seller, q1.chat), bhrata.id, t0).find((m) => m.id !== q1.pdfMessage), 30_000, "the approved PDF reaches the seller's chat by itself");
      return { docId, total: q.quotation.total, askedMs: asked.ms, approvedToPdfMs: pdf.ms, totalMs: Date.now() - t0 };
    },

    // "100% advance": Artha makes the proforma from the approved quotation; Finance issues it.
    "wl-proforma": async () => {
      const q1 = need("quote", "wl-quote");
      const finance = await person("finance"), artha = ai("wl-artha");
      const t0 = Date.now();
      const made = must(await artha.as("/api/v1/billing/proformas", { body: { quotationId: q1.id } }), "Artha makes the proforma (create_proforma)", ok2);
      const pf = made.proforma;
      if (!pf?.id || pf.status !== "draft") throw new Step("a draft proforma", json(pf).slice(0, 120));
      if (pf.total !== q1.total) throw new Step("the quotation's lines and total", `proforma ${pf.total} vs quotation ${q1.total}`);
      const again = must(await artha.as("/api/v1/billing/proformas", { body: { quotationId: q1.id } }), "asked again", ok2);
      if (again.proforma?.id !== pf.id) throw new Step("asked again opens the same proforma", `${again.proforma?.id} vs ${pf.id}`);
      // An AI employee never issues it (a person's step).
      const byAi = await artha.as(`/api/v1/billing/invoices/${pf.id}/issue`, { body: { confirm: true } });
      if (byAi.status < 400) throw new Step("only a person issues the proforma", `Artha's issue answered ${byAi.status}`);
      must(await finance.as(`/api/v0/erp/documents/${pf.id}/issue`, { body: {} }), "Finance issues the proforma");
      const d = must(await finance.as(`/api/v0/erp/documents/${pf.id}`), "Finance reads the proforma");
      const number = d.document?.number || d.number;
      if (!number) throw new Step("the proforma is numbered", `status ${d.document?.status || d.status}`);
      const bytes = await fetchPdf(finance, `/api/v0/erp/documents/${pf.id}/pdf`, "the proforma's PDF");
      // The customer said yes: the quotation is converted and nobody is asked to follow it up any more.
      if (state.followup) {
        const f = json(must(await (await person("seller")).as(`/api/v0/quotes/${q1.id}/follow-up`), "the seller reads the follow-up"));
        if (/"state":"scheduled"/.test(f)) throw new Step("the proforma ends the quotation's follow-up", f.slice(0, 160));
      }
      state.proforma = { id: pf.id, number };
      return { proforma: number, total: pf.total, pdfBytes: bytes, ms: Date.now() - t0 };
    },

    // bhrātā gives the seller a task; the seller sees it and finishes it; the reviewer accepts it.
    "wl-task": async () => {
      const owner = await person("owner"), seller = await person("seller"), bhrata = ai("wl-bhrata");
      const who = state.lead?.name || "the customer";
      const t0 = Date.now();
      const t = must(await bhrata.as("/api/v1/tasks", { body: { title: `QA WL: call ${who} about the quotation (synthetic)`, assigneeId: seller.id,
        dueAt: new Date(Date.now() + 2 * 3600_000).toISOString(), priority: "high" } }), "bhrātā gives the seller a task (create_task)", ok2);
      if (!t.assigned) throw new Step("the task is the seller's at once", t.askedId ? "the seller was asked to take it instead" : json(t).slice(0, 120));
      await waitFor(async () => (await noticesOf(seller)).includes(t.id), 30_000, "the seller is told (task.assigned)");
      const mine = must(await seller.as(`/api/v0/tasks?task=${t.id}`), "the seller opens the task");
      if (!json(mine).includes(t.id)) throw new Step("the seller sees the task", "not in the seller's tasks");
      const done = must(await seller.as(`/api/v0/tasks/${t.id}/move`, { body: { status: "done", note: "Called (QA journey)" } }), "the seller finishes it");
      let status = done.status;
      if (status === "in_review") status = must(await owner.as(`/api/v0/tasks/${t.id}/move`, { body: { status: "accepted" } }), "the reviewer (owner) accepts it").status;
      if (!["done", "accepted"].includes(status)) throw new Step("finished", `status ${status}`);
      return { taskId: t.id, status, ms: Date.now() - t0 };
    },

    // The seller marks the quotation sent; its follow-up is the seller's; when due, a task and a notice; the answer.
    "wl-followup": async () => {
      const q1 = need("quote", "wl-quote");
      const seller = await person("seller");
      const t0 = Date.now();
      must(await seller.as(`/api/v0/erp/documents/${q1.id}/mark`, { body: { action: "sent", note: "Sent on WhatsApp (QA journey)" } }), "the seller marks the quotation sent");
      const f = must(await seller.as(`/api/v0/quotes/${q1.id}/follow-up`), "the seller reads the follow-up");
      const s = json(f);
      if (!/scheduled/.test(s)) throw new Step("a follow-up is scheduled", s.slice(0, 160));
      if (!s.includes(seller.id)) throw new Step("the follow-up is the seller's", s.slice(0, 160));
      // Due now (dev only: the company's follow-up days are at least one), then the minute tick does the rest.
      const due = JSON.parse(execFileSync(PY, ["-I", path.join(HERE, "wl-dev.py"), "followup-due", q1.id, ...(credentials ? ["--credentials", credentials] : [])], { encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop());
      if (!due.ok) throw new Step("the follow-up made due (dev)", due.error);
      const task = await waitFor(async () => { const v = must(await seller.as(`/api/v0/quotes/${q1.id}/follow-up`), "the seller reads the follow-up"); return v.taskId || v.task?.id || v.followup?.taskId || null; },
        150_000, "the minute tick gives the seller a follow-up task");
      const told = await waitFor(async () => (await noticesOf(seller)).includes(task.v) || (await noticesOf(seller)).includes(q1.id), 60_000, "the seller is told (task.due_soon)");
      const answered = must(await seller.as(`/api/v0/quotes/${q1.id}/follow-up`, { body: { action: "replied", note: "Customer asked for the site visit (QA journey)" } }), "the seller records the customer's answer");
      if (!/answered/.test(json(answered))) throw new Step("the follow-up pauses on the answer", json(answered).slice(0, 160));
      state.followup = { task: task.v };
      return { followupTask: task.v, dueToTaskMs: task.ms, toldMs: told.ms, totalMs: Date.now() - t0 };
    },

    // "Remind me about this": the reminder rings when due.
    "wl-reminder": async () => {
      const q1 = need("quote", "wl-quote");
      const seller = await person("seller");
      const at = new Date(Date.now() + 35_000).toISOString(); // at least 30 s ahead (chat_remind)
      const r = must(await seller.as(`/api/v0/chats/messages/${q1.pdfMessage}/remind`, { body: { at } }), "the seller asks to be reminded about the quotation");
      const list = must(await seller.as("/api/v0/chats/reminders"), "the seller's reminders");
      if (!json(list).includes(r.id)) throw new Step("the reminder is listed", "not in the seller's reminders");
      const fired = await waitFor(async () => (must(await seller.as("/api/v0/chats/reminders"), "the seller's reminders").reminders || []).find((x) => x.id === r.id && x.fired), 90_000, "the reminder rings when due");
      // The bell shows it as a reminder on that chat (2404: before, notification_authorized hid it unless the message
      // mentioned the seller, and the card said "mentioned you").
      const told = await waitFor(async () => (must(await seller.as("/api/v0/notices"), "the seller reads the bell").rows || [])
        .find((x) => x.channelId === q1.chat && /^Reminder:/.test(String(x.title))), 30_000, "the reminder is in the seller's bell");
      return { reminderId: r.id, firedAfterDueMs: Math.max(0, Date.now() - Date.parse(at) - told.ms), toldMs: told.ms };
    },

    // Attendance as at Willow Lane: check in, then out (a weekly off or holiday is refused with its reason, and noted).
    "wl-checkin": async () => {
      await setup();
      const seller = await person("seller");
      const a0 = must(await seller.as("/api/v0/attendance"), "the seller's attendance");
      if (!a0.attendanceEnabled) throw new Step("attendance is on", "off for the QA company");
      if (a0.ownOpen) must(await seller.as("/api/v0/attendance/check-out", { body: {} }), "an earlier open check-in closed");
      const t0 = Date.now();
      const r = await seller.as("/api/v0/attendance/check-in", { body: { mode: "office", note: "QA journey", day: true } });
      if (r.status === 403 && /weekly off or holiday/i.test(r.text)) return { skipped: "today is a weekly off or holiday in the QA company: check-in refused with its reason, as it should be" };
      const inn = must(r, "the seller checks in");
      const a1 = must(await seller.as("/api/v0/attendance"), "the seller's attendance");
      if (!a1.ownOpen) throw new Step("checked in", "no open check-in after checking in");
      must(await seller.as("/api/v0/attendance/check-out", { body: {} }), "the seller checks out");
      const a2 = must(await seller.as("/api/v0/attendance"), "the seller's attendance");
      if (a2.ownOpen) throw new Step("checked out", "still open after checking out");
      return { entryId: inn.id, mode: inn.mode, ms: Date.now() - t0 };
    },
  };
}
