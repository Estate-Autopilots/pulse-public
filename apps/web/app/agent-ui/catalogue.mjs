// AGENT-UI-CONTROL (7 Nov 2026): the screen actions an AI employee may send, as the browser names and words them. The
// same names and levels as services/api/data/agent-ui-actions.json (catalogue.test.mjs keeps them equal); the database
// decides the level of each call. Pure, so it is tested on its own.

/** @typedef {"view" | "act" | "admin" | "confirm"} Level */
/** @type {Record<string, { level: Level, asks: string, did: string }>} */
export const ACTIONS = {
  "page.open": { level: "view", asks: "open {path}", did: "Opened {path}" },
  "panel.open": { level: "view", asks: "open {target} beside the chat", did: "Opened {target} beside the chat" },
  "panel.close": { level: "view", asks: "close the side panel", did: "Closed the side panel" },
  "sidebar.set": { level: "view", asks: "{open:open|close} the sidebar", did: "{open:Opened|Closed} the sidebar" },
  "tab.open": { level: "view", asks: "open {path} in a new tab", did: "Opened {path} in a new tab" },
  "point.at": { level: "view", asks: "point at “{text}”", did: "Pointed at “{text}”" },
  "mic.stop": { level: "view", asks: "stop the microphone", did: "Stopped the microphone" },
  "composer.insert": { level: "act", asks: "type in your message box", did: "Typed in your message box" },
  "emoji.insert": { level: "act", asks: "add {emoji} to your message", did: "Added {emoji} to your message" },
  "form.open": { level: "act", asks: "open the {form} form", did: "Opened the {form} form" },
  "file.pick": { level: "act", asks: "ask you for a file: {purpose}", did: "Asked you for a file" },
  "mic.start": { level: "act", asks: "start the microphone", did: "Asked to start the microphone" },
  // FIX-CHAT-AI: the screen as a short map, and a visible click or fill (the AI cursor glides there first).
  "screen.read": { level: "view", asks: "look at your screen", did: "Looked at your screen" },
  "element.click": { level: "act", asks: "click “{text}”", did: "Clicked “{text}”" },
  "field.fill": { level: "act", asks: "fill in “{field}”", did: "Filled in “{field}”" },
  // AGENT-OPERATOR: uploads and downloads through the page's own form and links.
  "file.upload": { level: "act", asks: "add a file to the page", did: "Added a file to the page" },
  "file.download": { level: "act", asks: "download “{text}” into the chat", did: "Downloaded “{text}” into the chat" },
  // DOCS-EDITOR-8: "how do I …" played as a walkthrough on the page (it points and shows the steps; it never clicks).
  "guide.play": { level: "view", asks: "show you how, step by step: “{question}”", did: "Showed you how: “{question}”" },
};
/** Each kind of action in a few words, for what it may always do ("Pip won't ask again to add emoji"). */
export const KINDS = { "page.open": "open pages", "panel.open": "open things beside the chat", "panel.close": "close the side panel", "sidebar.set": "open and close the sidebar",
  "tab.open": "open new tabs", "point.at": "point at buttons", "mic.stop": "stop the microphone", "composer.insert": "type in the message box", "emoji.insert": "add emoji",
  "form.open": "open forms", "file.pick": "ask for files", "mic.start": "ask to start the microphone", "screen.read": "look at your screen", "element.click": "click buttons", "field.fill": "fill in fields",
  "file.upload": "add files to pages", "file.download": "download files into the chat", "guide.play": "show you how, step by step" };
export const FORMS = { task: "a new task", project: "a new project", client: "a new client", quote: "a new quotation", person: "a new team member", ai_employee: "a new AI employee" };
export const LEVELS = [
  { key: "off", label: "Off", says: "It never drives the screen." },
  // AI-AGENTS-3 (judge: "the long 'Act' text"): one short line each; a click that sends, pays, deletes or approves
  // still always asks first (the catalogue's `asks`, unchanged).
  { key: "view", label: "View", says: "It shows you things: opens pages and files beside the chat, and points at buttons." },
  { key: "act", label: "Act", says: "It also clicks, fills in forms and adds files for you. Sending, paying, deleting or approving always asks you first." },
  { key: "admin", label: "Admin", says: "It also opens Settings and admin screens, and forms that add people." },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACES = [[/^\/erp\/documents\//, "the quotation"], [/^\/api\/v0\/erp\/documents\/.+\/pdf$/, "the quotation PDF"], [/^\/tasks\/projects\//, "the project"], [/^\/tasks\/[\w-]+$/, "the task"],
  [/^\/tasks/, "Work"], [/^\/clients\/[\w-]+/, "the client"], [/^\/clients/, "Clients"], [/^\/erp\/new/, "a new quotation"], [/^\/erp/, "Billing"], [/^\/settings/, "Settings"],
  [/^\/people\/[\w-]+/, "a profile"], [/^\/people/, "Team"], [/^\/docs/, "Docs"], [/^\/me/, "My desk"], [/^\/chats/, "Chats"], [/^\/(dashboard|home)?$/, "Home"]];

/** A place said plainly: "the quotation", "Clients", "a Google Doc", "docs.google.com" (never a raw id). */
export function placeName(raw, title) {
  if (typeof title === "string" && title.trim()) return `“${title.trim().slice(0, 60)}”`;
  const s = String(raw ?? "").trim();
  if (/^quote:/i.test(s)) return "the quotation";
  if (/^file:/i.test(s)) return "a file";
  if (/^https?:\/\/docs\.google\.com\//i.test(s)) return "a Google Doc";
  if (/^https?:\/\/drive\.google\.com\//i.test(s)) return "a Drive file";
  if (/^https?:\/\//i.test(s)) { try { return new URL(s).hostname.replace(/^www\./, ""); } catch { return "a link"; } }
  const path = s.split(/[?#]/)[0];
  for (const [re, name] of PLACES) if (re.test(path)) return name;
  return path && !UUID.test(path) ? path.slice(0, 60) : "a page";
}

/** Fills a template's {key} (and {key:yes|no} for a true/false) from an action's details, in plain words. */
function fill(template, args) {
  return template.replace(/\{(\w+)(?::([^|}]*)\|([^}]*))?\}/g, (_, key, yes, no) => {
    const v = args?.[key];
    if (yes !== undefined) return v === true ? yes : no;
    if (key === "path" || key === "target") return placeName(v, args?.title);
    if (key === "form") return FORMS[v] ? FORMS[v].replace(/^an? new /, "") : "the";
    return String(v ?? "").slice(0, 80);
  });
}
/** "open the quotation beside the chat": what the prompt says the AI employee wants to do. */
export const asks = (action, args = {}) => ACTIONS[action] ? fill(ACTIONS[action].asks, args) : "use your screen";
/** "Opened the quotation beside the chat": what the activity line says it did. */
export const did = (action, args = {}) => ACTIONS[action] ? fill(ACTIONS[action].did, args) : "Used your screen";
/** FIX-CHAT-AI: a click whose words delete, send, pay, approve or sign is risky. AGENT-OPERATOR (2080): it needs "confirm":
 *  asked every time, whatever the AI employee's level, and only the person whose screen it is says yes. */
export const RISKY = /\b(delete|remove|discard|cancel|pay|send|submit|approve|reject|sign|archive|revoke|disable|log ?out|sign ?out|transfer|refund|issue)\b/i;
/** The level a call needs, as the database decides it (Settings and admin screens, and forms adding people, need admin). */
export function levelOf(action, args = {}) {
  const a = ACTIONS[action]; if (!a) return null;
  if (["page.open", "panel.open", "tab.open"].includes(action) && /^(https?:\/\/[^/]+)?\/(settings|admin|platform)(\/|\?|#|$)/i.test(String(args.path ?? args.target ?? ""))) return "admin";
  if (action === "form.open" && ["person", "ai_employee"].includes(args.form)) return "admin";
  if (action === "element.click" && RISKY.test(String(args.text ?? ""))) return "confirm";
  return a.level;
}
/** A one-emoji string (what emoji.insert takes): no letters, digits, spaces or markup. */
export const isEmoji = (s) => typeof s === "string" && s.length >= 1 && s.length <= 16 && /^[^\sA-Za-z0-9<>]+$/.test(s) && /\p{Extended_Pictographic}/u.test(s);
