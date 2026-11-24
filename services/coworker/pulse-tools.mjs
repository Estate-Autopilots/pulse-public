// AI-SERVER-TOOLS (6 Nov 2026; owner: "We need to give them all access. We decide which agent gets what, but all get
// it."): an AI employee's Pulse tools are Pulse's own MCP tools (services/api/src/mcp.ts, built from every API v1
// operation), called with the AI employee's own key, so it acts as itself under row security, inside its company only,
// in the areas its managers left it (all by default; migration 1590), and every new API v1 area reaches it by itself.
// Engine-neutral: the model asks for tools in its JSON answer ({"tools": [...]}), the runtime calls them and gives the
// results back for the next round (at most TOOL_ROUNDS), then the answer goes out as before.
import { answerJson } from "./runtime.mjs";

export const TOOL_ROUNDS = 3;
/** WL-QUOTE-LIVE: the tool rounds of a run: one more once Pulse refused a call, so it can fix the call and go on (the
 *  suite saw quotations given up after one fixable refusal, with no round left to submit). */
export const roundLimit = (refused) => TOOL_ROUNDS + (refused ? 1 : 0);
/** WL-QUOTE-LIVE: the runtime's own line after a round where Pulse refused calls (a tool's text is information only). */
export const fixNote = (n) => `Pulse refused ${n === 1 ? "one of those calls" : `${n} of those calls`} and said why (a field name, an id, a format). Send ${n === 1 ? "that call" : "those calls"} again now, corrected exactly as the refusal says (a price is "rate" in paise, only where it differs from the catalogue), then carry on with the request. Do not stop, apologise or file a request for a refusal you can fix.`;
export const TOOLS_PER_ROUND = 5;
const SECRET = /(pak_[0-9a-f]{8}_[0-9a-f]{20,}|pmt_[A-Za-z0-9_-]{20,}|pat_[A-Za-z0-9_-]{20,}|psvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|postgres(ql)?:\/\/\S+:\S+@)/g;
/** What a tool returned, with anything that looks like a secret taken out (the model never sees a secret). */
export const redact = (s) => String(s ?? "").replace(SECRET, "[hidden]");

/** The most characters of one tool answer the model is shown (resultText cuts the rest). PM-BUILD-4 (EA #35): Pulse is
 *  told, so a list page holds only the items that fit and its nextCursor resumes at the first one not shown. */
export const RESULT_CHARS = 3000;

/** One JSON-RPC call to Pulse's MCP endpoint with the AI employee's key (an SSE or a JSON answer). */
export async function mcpCall(base, key, method, params, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const r = await fetchImpl(`${base}/api/v1/mcp`, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "x-pulse-answer-chars": String(RESULT_CHARS) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }) });
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
    try { j = data ? JSON.parse(data) : null; } catch { j = null; }
  }
  if (j?.error) { const e = new Error(String(j.error.message ?? "Pulse refused the tool").slice(0, 300)); e.status = r.status; throw e; }
  if (!r.ok || !j) { const e = new Error(`Pulse tools answered ${r.status}`); e.status = r.status; throw e; }
  return j.result;
}

/** QUOTE-FAST: arguments the runtime fills (the chat a quotation is asked in, and who asked): not shown to the model. */
const RUNTIME_ARGS = new Set(["chatId", "askedById"]);
/** QUOTE-FAST: the quotations (and other Billing documents) a text links, by id, in order, at most three. */
export function quoteIdsIn(text) {
  const ids = [...String(text ?? "").matchAll(/\/erp\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1].toLowerCase());
  return [...new Set(ids)].slice(0, 3);
}
/** The tool list as the prompt shows it: one short line each (name, arguments with * for required, first sentence). */
export function catalogue(tools) {
  return (tools ?? []).filter((t) => t && typeof t.name === "string").map((t) => {
    const props = Object.keys(t.inputSchema?.properties ?? {}).filter((k) => k !== "requestId" && !RUNTIME_ARGS.has(k) && !(k === "forPersonId" && isScreenTool(t.name))), req = new Set(t.inputSchema?.required ?? []);
    // AI-EMPLOYEE-POWER: one short clause each (the catalogue goes into every call with tools).
    // FIX-CHAT-AI: one short clause and the arguments (required with *, at most 8 named): the list is in every call.
    const first = String(t.description ?? t.title ?? "").replace(/\s+/g, " ").split(/(?<=\.)\s/)[0].slice(0, 80);
    const named = [...props.filter((k) => req.has(k)), ...props.filter((k) => !req.has(k))], shown = named.slice(0, 8);
    return `- ${t.name}(${shown.map((k) => `${k}${req.has(k) ? "*" : ""}`).join(", ")}${named.length > shown.length ? ", …" : ""}): ${first}`;
  }).join("\n");
}

/** The tools the model asked for in its answer: [{name, args}] (at most TOOLS_PER_ROUND), or []. */
export function toolCalls(text, known = null) {
  const j = answerJson(String(text ?? ""));
  const list = Array.isArray(j?.tools) ? j.tools : [];
  return list.filter((x) => x && typeof x === "object" && typeof (x.name ?? x.tool) === "string")
    .map((x) => ({ name: String(x.name ?? x.tool).slice(0, 80), args: x.args && typeof x.args === "object" && !Array.isArray(x.args) ? x.args : x.arguments && typeof x.arguments === "object" ? x.arguments : {} }))
    .filter((x) => !known || known.has(x.name)).slice(0, TOOLS_PER_ROUND);
}

/** FIX-CHAT-AI: a JSON answer without its padding: no indentation, and no empty, null or false-y bookkeeping fields
 *  (they cost tokens in every later round and tell the model nothing). Anything that is not JSON stays as it is. */
export function compactJson(text) {
  const t = String(text ?? "").trim();
  if (!/^[[{]/.test(t)) return String(text ?? "");
  let j; try { j = JSON.parse(t); } catch { return String(text ?? ""); }
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== "" && !(Array.isArray(x) && !x.length)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  // BUG-SWEEP-3 (Agent Lab #2): the answer's own top-level fields stay, empty or not. An empty page
  // {"items":[],"nextCursor":null} was cut to {}, which the AI read as a broken answer, not "none, and that is all".
  if (j && typeof j === "object" && !Array.isArray(j)) return JSON.stringify(Object.fromEntries(Object.entries(j).map(([k, x]) => [k, strip(x)])));
  return JSON.stringify(strip(j));
}

/** A tool's answer as text for the next round (its text content, refusals said as such), at most `max` characters. */
export function resultText(call, result, max = RESULT_CHARS) {
  const text = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n")
    || (result?.structuredContent ? JSON.stringify(result.structuredContent) : "");
  const t = redact(compactJson(text)).trim();
  return `${call.name}(${redact(JSON.stringify(call.args)).slice(0, 300)}) ${result?.isError ? "was refused" : "returned"}: ${t.length > max ? `${t.slice(0, max)} … (cut)` : t || "(nothing)"}`;
}

/** BHARATA-CORE: the quotation a create_quotation / revise_quotation answer names ({id, url}), or null. */
export function quoteOf(result) {
  let j = result?.structuredContent ?? null;
  if (!j) { try { j = JSON.parse((result?.content ?? []).find((c) => c?.type === "text")?.text ?? "null"); } catch { j = null; } }
  const d = j?.document ?? j?.quotation ?? j;
  const id = typeof d?.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id) ? d.id : null;
  const url = typeof d?.url === "string" && /^https:\/\/[^\s/]+\/erp\/documents\/[0-9a-f-]{36}$/.test(d.url) ? d.url : null;
  return id && url && url.endsWith(id) ? { id, url } : null;
}

/** The job a run_on_server answer holds (id and whether it has ended), or null. */
export function jobOf(result) {
  const j = result?.structuredContent?.job ?? (() => { try { return JSON.parse((result?.content ?? []).find((c) => c?.type === "text")?.text ?? "null")?.job; } catch { return null; } })();
  return j && typeof j.id === "string" ? { id: j.id, final: j.final === true, kind: j.kind } : null;
}

/** AGENT-UI-CONTROL: the screen tools (screen_open_side_panel, screen_sidebar, screen_show_card, …). */
export const isScreenTool = (name) => /^screen_/.test(String(name ?? ""));
/** Whose screen a screen tool drives: the person who wrote the message it answers (never one of its own messages, never a
 *  task's: a task has no one at a screen). */
/** ARTHA-FIX: the chat a doc written now is shared with: the chat it is answering in (a group: its people; a direct
 *  chat: the person who asked). Not a task run, its own message, a consult's answer or a client's conversation. */
export function docChat(ctx) {
  const m = ctx?.message;
  if (!m || m.mine || ctx?.task || ctx?.clientFacing || ctx?.kind === "consult.answer") return null;
  return typeof m.channelId === "string" && /^[0-9a-f-]{36}$/i.test(m.channelId) ? m.channelId : null;
}
const OPEN_WORDS = /\b(open|show)\b|side\s?(browser|panel|bar|view)|beside/i;
/** ARTHA-FIX: the person asked to see what it makes ("make a doc and open it in the side browser"), in this message or
 *  their last few lines (the ask is often a message before "@artha"). */
export function wantsOpen(ctx) {
  if (!ctx?.message || ctx.message.mine || ctx.task) return false;
  const by = ctx.message.authorId ?? ctx.message.author_id;
  const lines = [ctx.message.body, ...(ctx.recent ?? []).slice(-3).filter((x) => !x.mine && (!by || (x.authorId ?? x.author_id ?? by) === by)).map((x) => x.body)];
  return OPEN_WORDS.test(lines.filter(Boolean).join("\n"));
}
export function screenTarget(ctx) {
  const m = ctx?.message;
  if (!m || m.mine || ctx?.task) return null;
  const by = m.authorId ?? m.author_id;
  return typeof by === "string" && /^[0-9a-f-]{36}$/i.test(by) ? by : null;
}
/** What the prompt says about the screen tools, when it has them (one short paragraph). */
export const SCREEN_PART = `Their screen: with the screen_* tools you work Pulse's screen for the person you are answering, as a colleague sitting next to them would: open a page (screen_open_page), open a quotation, doc, file, page or link beside the chat (screen_open_side_panel; a quotation is "quote:<id>" or its /erp/documents/<id> address; a doc is /docs/<id>, create_doc's openBeside), close it, open or close the sidebar, open a tab, point at a button, type a draft or an emoji into their message box (never sends), open a form filled in, ask them for a file, start or stop the microphone. Use them when it helps them see or do the thing now ("open the quotation" means open it beside the chat). Within your screen level it happens at once; above it they get a prompt to allow it (the tool says "asked"): say so in one line. When something you need is missing (a client is not in Clients, a task or project does not exist yet, several match), do not stop or fail: use screen_show_card (client.add, task.add, project.add or choice) with what you know filled in, and say in one line what you need. Several clients match: a choice card with their names (and "A new client") rather than a typed list. When create_task or create_project is not among your tools, a task or project you would make (a follow-up, a site visit) is a task.add or project.add card: they add it in one click. Working a page step by step: screen_read, then screen_click / screen_fill by its ids, screen_upload_file to put a chat file into the page's file field, screen_download_file to bring a file the page links to into the chat. A click that sends, pays, deletes or approves always asks them first: say you asked and wait. A step that fails is reported as a bug by itself: do not report it again; try another way once, then tell them what is left. They ask how to do something in Pulse ("how do I add a bank statement?"): show them with screen_show_me_how (the steps play on their screen, with the buttons lit); "do it" or "Do it for me" then means you do those steps yourself with screen_read, screen_click and screen_fill.`;

// FIX-CHAT-AI (owner, 10 Nov 2026: "give the agent typed, cheap tools ... instead of dumping big context"): every call
// used to carry the whole catalogue (154 tools, ~7,000 tokens on production) in every tool round. Now a request carries
// only the tools of the areas it is about (by its words), plus an index of the other areas; "more_tools" (answered by the
// runtime, no Pulse call) lists one area's tools when the model needs another. Tools it may use are unchanged.
export const AREAS = [
  // WL-QUOTE-LIVE: Hindi and Marathi words too (a salesperson types or says them; JS \b does not see Devanagari letters).
  ["quotes", /quot|catalog|client|billing_document|getQuote|listQuotes|createQuote|proforma/i, /\b(quot\w*|kotation|price\w*|rate\w*|catalog\w*|client\w*|customer\w*|gst|proforma|estimate\w*|line|lines|item\w*|amount|total|discount\w*|warrant\w*|kw)\b|कोटेशन|कोटेसन|क्वोटेशन|क्वोट|दरपत्रक|अंदाजपत्रक|एस्टिमेट|एस्टीमेट|इस्टिमेट|कीमत|किंमत|ग्राहक|क्लाइंट|छूट|सूट|वारंटी|वॉरंटी/i],
  // ARTHA-FIX: Money records, finance numbers and bank statements are this area too (bank, statement, GST, ledger …).
  ["money", /invoice|payment|stock|expense|finance|money|statement/i, /\b(invoice\w*|bill|bills|billing|payment\w*|paid|pay|stock|expense\w*|finance|money|cash|receiv\w*|due|bank\w*|statement\w*|gst|tds|ledger\w*|reconcil\w*|account\w*|tax\w*|salar\w*|payroll)\b/i],
  ["contacts", /contact|lead/i, /\b(lead\w*|contact\w*|prospect\w*|enquir\w*|inquir\w*)\b/i],
  ["tasks", /task|comment|merge|stage/i, /\b(task\w*|to-?do\w*|assign\w*|due|deadline|follow[- ]?up\w*|remind\w*|done|complete\w*|stage)\b/i],
  ["projects", /project|goal|workflow/i, /\b(project\w*|goal\w*|workflow\w*|run|runs|process\w*)\b/i],
  ["people", /person|people|ai_employee|whoami|organisation/i, /\b(people|person|team\w*|colleague\w*|employee\w*|staff|who|manager\w*|hire\w*)\b/i],
  ["hr", /leave|attendance|calendar/i, /\b(leave\w*|attendance|holiday\w*|absent|check[- ]?in\w*|calendar|meeting\w*)\b/i],
  ["chats", /chat|message|send_message/i, /\b(chat\w*|message\w*|tell|send|group\w*|dm|whatsapp)\b/i],
  ["docs", /doc|folder/i, /\b(doc|docs|document\w*|file\w*|folder\w*|sop\w*|note\w*|write[- ]?up)\b/i],
  ["contracts", /contract/i, /\b(contract\w*|agreement\w*|nda|offer letter|sign\w*)\b/i],
  ["pr", /pr_/i, /\b(pr|post\w*|linkedin|story|stories|brief\w*|audience\w*)\b/i],
  ["servers", /server|webhook|connector|fetch|run_on_server/i, /\b(server\w*|command\w*|run|bash|shell|deploy\w*|webhook\w*|connector\w*|url|http\S*)\b/i],
  ["screen", /^screen_/i, /\b(screen|open|show|close|click|press|tap|fill|type|point|sidebar|tab|page|panel|side|remove|delete|scroll|go to|take me|upload|download|attach)\b/i],
];
// DOCS-HUB (owner, 21 Nov 2026): "find last month's invoices for Willow Lane over 1 lakh" names invoices (money), a quote
// (quotes), a doc or a contract: find_documents answers all of them, so it is always shown (when the caller may read Billing).
const GENERAL = new Set(["search", "whoami", "find_documents"]);
/** BHARATA-2: with draft_quotation (one call drafts, copies, changes or submits a quotation from the request's words), a
 *  quotation request shows these few; the other quote-area tools stay one more_tools("quotes") away (each listed tool
 *  is in every model call). */
// The suite (17:28, en-08 and en-12) saw "change it" and "then submit it" go to revise_quotation and submit_quotation:
// two to three model rounds instead of one; draft_quotation does both (draftId, submit).
// WL-AGENTS (19 Nov 2026): get_client too: "find the client X and tell me what we have on them" (a seller's everyday ask)
// took search_clients, then more_tools("quotes") for get_client, then get_client: one round and ~20k tokens more (45k on
// bhrātā's QA copy). get_client reads the client with its contacts, projects and latest quotations and invoices.
export const QUOTE_CORE = new Set(["draft_quotation", "list_quotations", "get_billing_document", "send_quotation", "search_catalogue", "search_clients", "get_client"]);
// FIN-AGENT-2: the learned-skill tools (list_skills, run_skill, get_job) come with the money tools.
const MONEY_TOOLS = new Set(["list_skills", "run_skill", "get_job"]);
export const areaOf = (name) => MONEY_TOOLS.has(String(name)) ? "money" : (AREAS.find(([, byName]) => byName.test(String(name))) ?? ["other"])[0];
/** The tools a request shows: the areas its words name (all of them when it names none and is long, the general ones
 *  when it is short), always search and whoami; and the other areas by name with how many tools each has. */
export function pickTools(tools, text, { all = false, also = [] } = {}) {
  const list = (tools ?? []).filter((t) => t && typeof t.name === "string");
  const words = String(text ?? "");
  const named = new Set(AREAS.filter(([, , byWords]) => byWords.test(words)).map(([a]) => a));
  if (all || (!named.size && words.length > 400)) return { shown: list, others: [] };
  for (const a of also) named.add(a);
  const words1 = list.some((t) => t.name === "draft_quotation");
  const shown = list.filter((t) => GENERAL.has(t.name) || (named.has(areaOf(t.name)) && !(words1 && areaOf(t.name) === "quotes" && !QUOTE_CORE.has(t.name))));
  const others = {};
  for (const t of list) if (!shown.includes(t)) { const a = areaOf(t.name); others[a] = (others[a] ?? 0) + 1; }
  return { shown, others: Object.entries(others).map(([area, n]) => ({ area, n })) };
}
/** The runtime's own answer to more_tools: the catalogue lines of one area (or of every tool whose name has the word). */
export function moreTools(tools, area) {
  const a = String(area ?? "").toLowerCase().trim();
  const hit = (tools ?? []).filter((t) => areaOf(t.name) === a || (a.length >= 3 && t.name.toLowerCase().includes(a)));
  return hit.length ? `Tools for "${a}" (call them by name next round):\n${catalogue(hit)}` : `No tools for "${a}". Areas: ${[...new Set((tools ?? []).map((t) => areaOf(t.name)))].join(", ")}.`;
}

const TIER_WORDS = { "read-only": "read-only", sandboxed: "read-write in a sandbox", root: "root, unsandboxed", none: "none" };

/** AI-EMPLOYEE-POWER: "run <command> on <server>" asked plainly: the shell job it needs, so the runtime runs it before the
 *  first model call (one model call instead of two). Only for a server it may use; never at root (that stays the model's
 *  explicit choice). */
export function directRun(text, servers = []) {
  const m = String(text ?? "").trim().replace(/^\(test\)\s*/i, "").match(/^(?:please\s+)?run\s+[`"']?(.+?)[`"']?\s+on\s+([A-Za-z0-9._-]+)\s*[?.!]*$/i);
  if (!m) return null;
  const s = servers.find((x) => x.mayUse && String(x.name).toLowerCase() === m[2].toLowerCase());
  return s && m[1].trim() ? { name: "run_on_server", args: { server: s.name, mode: "shell", command: m[1].trim(), level: "read-only" } } : null;
}

/** BHARATA-CORE (7 Nov 2026): how a quotation is made with Pulse's tools, for an AI employee that has them: few model
 *  rounds (independent reads together), the client found before anyone is added, catalogue prices only, the open draft
 *  reused instead of a second one, approval by a person. Tenant-neutral: the company's catalogue says what is sold. */
const QUOTE_ASK = /\b(quot\w*|estimate\w*|proforma|price\w*|discount\w*|line|lines|item\w*|approv\w*|pending|same as last)\b|मंज़ूरी|मंजूरी|मंजुरी|पिछली बार|मागच्या/i;
export const QUOTE_PLAYBOOK = `Quotations (someone asks you to make, change or check a quote):
- Do the reads together in your first round: find_or_create_client (the client's name exactly as written, phone or city if given; create true only when they clearly named one client), search_catalogue for each thing asked (the product or system size, any warranty or add-on, installation), and list_quotations with that name as query and status draft.
- Exact fields (WL-QUOTE-LIVE: most refused quotations had an extra field): each line is only {itemId, qty} plus rate (paise) or discountPercent when they differ from the catalogue, and details for a reason; never code, name, price, unit price or total on a line. With a clientId send no buyer; a buyer is only {name, phone, email, gstin, contactName, address}. find_or_create_client takes name, company, phone, email, city; leave its type out. Find clients and products with find_or_create_client and search_catalogue, not search (it refuses AI employees). submit_quotation: leave approverId out to ask the usual approver; it is a person's id, never a name.
- Pulse refused a call with a reason you can fix (a field, an id, a format, a name it suggests): fix it and call again in your next round, then carry on; do not stop, report or file a request for that.
- "ambiguous" with a near name ("Did you mean …"): a voice note may have misheard the name; ask which, as a numbered list plus "a new client". If they say new, add it with create_client.
- A client's earlier quotations: list_quotations with that clientId (status issued, sent or accepted for an approved one); not listQuotes or getQuote. "Same as last time": take the newest approved one and create_quotation with its lines (itemId, qty, and rate only where it differed).
- "Submit it to the owner / for approval" with no person named: submit_quotation with the quotation's id only (no approverId). "Already waiting for approval" means it is submitted: say so, with its link.
- Whenever you talk about a quotation (a draft you made, reused, found waiting for approval or already approved), put its link in your answer, so it opens beside the chat.
- "found" or "created": use that client.id. "ambiguous": do not draft; ask which client, as a short numbered list of the candidates (name, company or city, last 4 digits of the phone) plus "a new client". No client named at all: ask "Which client is this for?" and offer up to 5 recent ones from list_quotations or search_clients as a numbered list.
- Never a second draft for the same client and request: if list_quotations shows a draft for that client, reuse it (revise_quotation only when the lines differ) and say it is the existing draft. Each create or change carries a requestId of 8 to 80 characters built from the client and the item codes (for example "q-" + the first 8 characters of the client id + "-" + the codes joined by "-", cut to 80), so a repeat changes nothing.
- Lines are catalogue items only (itemId and qty; leave rate out so the catalogue price applies). search_catalogue matches names and codes, not sentences: search short words (a size such as "5.0", a product family, "warranty", "installation"), several at once; when your instructions name item codes, search those exact codes in your first round. Read words like "5 kW" or "10-year warranty" against item names (the product of that size, an extended warranty item for it); your instructions may say how the company names its products. When one product clearly fits, draft it and say what you assumed; ask only when two or more fit equally. When nothing in the catalogue fits, say exactly what is missing and ask; never invent or guess a price, and never ask a colleague for a price the catalogue holds. A catalogue price written by the tool is written by our side: telling a colleague the draft's lines and total is not a "money" risk; agreeing a discount or another price is.
- create_quotation, then answer in a few lines: the client, each line with its price, the total, that it is a draft (not sent), and its link. For a named client with every line at its catalogue price, submit_quotation in the same turn (unless they asked only for a draft) and say so; otherwise offer "Submit it for approval?" and submit_quotation when they ask (approverId only if they name the approver). An approved quotation's PDF comes to this chat by itself; a person approves in Pulse, you never approve or send to the client unless asked.
- Price changes and extras: to raise or lower a price, revise_quotation with all the lines (the changed one with its new rate, or discountPercent for a percentage) and the reason in "reason"; it takes no confirm argument. A person who states the change and its amount has confirmed it: make it on the draft (it is not sent), and say the approver sees and approves it. GST is per line (the item's gstRate; 0 for exempt items); say whether totals include GST. An extra such as transport "as an add-on" is a line on the quotation (the delivery or transport item, at the amount they give); "billed separately" stays off the quotation: a small separate invoice to the same client (create_invoice, linked to the same project when there is one), made when they ask for it.
- "What is pending for approval": list_tasks (who anyone, query "Approve quotation", status open) and list_quotations status draft; "my open quotes": list_quotations (draft, issued and sent). A follow-up or site visit: create_task with the date worked out from today (the next such weekday) and the client in the title.`;

/** BHARATA-2: the quotation playbook when Pulse has draft_quotation: one call, its reply posted as it is (one model round
 *  instead of four to six; WL-QUOTE-LIVE measured ~95k tokens a quotation with the step-by-step tools). */
export const QUOTE_WORDS_PLAYBOOK = `Quotations (make, copy, change, check or submit one): call draft_quotation, alone in its round, once per request. Only for a quotation: a request to give, assign or remind someone of a task ("assign <name> a task …", "<name> ko task do") is a task (create_task), never a quotation, and a colleague is never a client. Give client (the name as written or heard; clientId when you know it), newClient true only when they say it is a new client, city and phone if said; items: each thing to put on it in short English words with its size and qty (for example {"words": "5 kW system", "qty": 2}, {"words": "10-year warranty", "qty": 2}, {"words": "ACDB"}, {"words": "installation"}, {"words": "transport", "priceRupees": 2500}); include what your instructions say every quotation gets; priceRupees only for a price the person stated or your instructions' rate card gives, never a guess; discountPercent on that item with the reason in notes; sameAsLast true for "same as last time" / "पिछली बार जैसा" / "मागच्या वेळेसारखे" (no items); draftId (the id in the draft's link) to change a draft from earlier in this conversation, with all its items; submit true when they ask to send it for approval (with draftId alone to submit an earlier draft; a known client's quotation at catalogue prices goes for approval by itself, so submit false only when they ask for just a draft); lang: "en", "hi" or "mr", the language they used. Pulse matches the catalogue (catalogue prices), finds or adds the client, reuses an identical draft, and its reply (or its question, when something is unclear) goes to the person as it is: you need no other tool. When they answer its question (which client, a spelling, a price, a size), call draft_quotation again with everything from the conversation plus their answer (confirmNewClient true when they confirm or correct a new client's name). For pending approvals or open quotes use list_quotations. Asked for a quotation that is approved already ("has he approved it", "give me the final quotation"): find it with list_quotations and put its link in your answer; Pulse then posts its PDF in this chat itself.`;
const WORDS_FINAL = new Set(["drafted", "updated", "existing", "submitted", "approved", "ask"]); // QUOTE-FAST: approved by the company's rule
/** BHARATA-2: the answer draft_quotation wrote for the person (its reply), or null: then the model answers as usual. */
export function wordsReply(result) {
  const j = result?.structuredContent ?? (() => { try { return JSON.parse((result?.content ?? []).find((c) => c?.type === "text")?.text ?? "null"); } catch { return null; } })();
  return !result?.isError && j && WORDS_FINAL.has(j.status) && typeof j.reply === "string" && j.reply.trim() ? { reply: j.reply.trim(), status: j.status, quote: !!j.quotation?.id } : null;
}
/** BHARATA-2: a message asking for a quotation (made, copied, changed or submitted), in English, Hindi or Marathi. */
export const quoteAsk = (text) => QUOTE_ASK.test(String(text ?? "")) || /कोटेशन|क्वोटेशन|दरपत्रक|अंदाजपत्रक|एस्टिमेट|kotation/i.test(String(text ?? ""));
/** BHARATA-2: a voice note's transcript or a Listen window (both start with 🎙): names and numbers there were heard. */
export const heardByVoice = (body) => /^\s*🎙/u.test(String(body ?? ""));

/** BHARATA-3: the words a task run picks its tools by: its title, notes and the newest comments of its thread. Production's
 *  bhrātā spent its whole day (1,026,868 of 1,000,000 tokens, 16 Nov) on ten task runs, each carrying every tool
 *  (~7,400 tokens) in every round; then no quotation could be made. The tasks area always comes along (TASK_AREAS). */
export const TASK_AREAS = ["tasks"];
export function taskWords(ctx) {
  const t = ctx?.task ?? {};
  return [t.title, t.notes, ...(ctx?.thread ?? []).slice(-3).map((c) => c?.body)].filter(Boolean).map(String).join("\n").slice(0, 3000);
}

/** What the prompt says about its tools (and how to ask for them). */
export function toolsPart(allTools, { name, servers = [], asker = null, text = null, also = [] } = {}) {
  // FIX-CHAT-AI: only the tools this request is about (text null: all of them, as before).
  const { shown: tools, others: hiddenAreas } = text === null ? { shown: allTools ?? [], others: [] } : pickTools(allTools, text, { also });
  const usable = servers.filter((s) => s.mayUse), others = servers.filter((s) => !s.mayUse);
  const serverWords = !servers.length ? "Your company has not connected a server to Pulse yet (an organisation admin does that in Settings → Servers)."
    : `Your company's connected servers: ${servers.map((s) => `${s.name} (${s.online ? "online" : "offline"}, ${s.mayUse ? `your tier: ${TIER_WORDS[s.tier] ?? s.accessLevel}${s.tier === "root" ? `, up to ${Math.round((s.timeLimitSec ?? 600) / 60)} min a command` : ""}` : "AI employees may not use it yet"}${s.claude ? ", Claude Code signed in" : ""}${s.codex ? ", Codex signed in" : ""})`).join("; ")}.`
      + (usable.length ? " You may run work on the ones you may use, up to their access level." : "")
      + (others.length ? ` For the others an organisation admin turns on "AI employees may use this server" in Settings → Servers.` : "");
  return `Your Pulse tools. You act in Pulse yourself, as ${name ?? "yourself"}, within your company only, through these tools: tasks, projects, people, HR (leave, attendance), finance, billing (quotes, invoices), companies and clients, chats, documents, search and your company's servers.${tools.some((t) => t?.name === "run_on_server") ? ` ${serverWords}` : ""}
Never say you have no access, cannot see settings or servers, or only see chats when a tool below covers it: use the tool, then answer from what it returned. If a tool refuses, say plainly what it said and who can change it.
To use tools, answer with JSON only: {"tools": [{"name": "tool_name", "args": {…}}]} (up to ${TOOLS_PER_ROUND} at a time). You then get their results and answer again, either with more tools or with your final answer in the usual JSON. At most ${TOOL_ROUNDS} rounds of tools.
${tools.some((t) => t?.name === "run_on_server") ? `For a server: run_on_server (server by name; mode "shell" with command: any bash command line, run at once on the server; or "claude"/"codex" with task). level: "read-only" to look, "write" when the work must change files in your sandbox, "root" only where your tier is root (then it runs as root: installs, docker, services, downloads, ssh/scp to the company's own servers, any file). The runtime waits for the job and gives you its output; a long job keeps running in the background (get_server_job / get_server_job_output later). Quote the real output; never claim a level or limit the job did not have.
` : ""}Writes (creating or changing tasks, invoices, leave, server work at write or full) are real: do them when the person asked for them or your role clearly needs them, and say what you did. Money and destructive actions ask for confirm: true; ask the person first.
${(tools ?? []).some((t) => t?.name === "draft_quotation") && (text === null || QUOTE_ASK.test(text) || AREAS[0][2].test(text)) ? `${QUOTE_WORDS_PLAYBOOK}
` : (tools ?? []).some((t) => t?.name === "create_quotation") && (tools ?? []).some((t) => t?.name === "find_or_create_client") && (text === null || QUOTE_ASK.test(text) || AREAS[0][2].test(text)) ? `${QUOTE_PLAYBOOK}
` : ""}${asker?.id && /^[0-9a-f-]{36}$/.test(asker.id) ? `The person you are answering is ${String(asker.name ?? "the asker").slice(0, 80)} (person id ${asker.id}): use this id when they ask for themselves as the assignee, reviewer or approver.\n` : ""}${(tools ?? []).some((t) => isScreenTool(t?.name)) ? `${SCREEN_PART}\n` : ""}Tools (name(arguments, * required): what it does):
${catalogue(tools)}${hiddenAreas.length ? `
More tools, by area (not listed here to keep this short): ${hiddenAreas.map((o) => `${o.area} (${o.n})`).join(", ")}. To see an area's tools: {"tools": [{"name": "more_tools", "args": {"area": "billing"}}]}.` : ""}`;
}
