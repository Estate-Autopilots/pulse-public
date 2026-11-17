// IA-NAV (owner, 10 Nov 2026: "I don't even see where PR Studio is … when I go looking for PR and many other updated
// features, I don't know where to look"). One map of Pulse, grouped by what people do, that the rail (the ribbon of
// icons), the sidebar beside it, the All apps launcher, the phone's More sheet and Ctrl+K all read, so they always match.
// Plain data and pure functions, no React: the web's unit tests import it (apps/web/app/lib/nav-catalog.test.mjs).

/** The nine groups, in the rail's order. Settings stays at the rail's foot. */
export const NAV_GROUPS = [
  { key: "home", label: "Home", blurb: "Your day and what changed" },
  { key: "work", label: "Work", blurb: "Tasks, projects, docs and meetings" },
  // FIX-CHAT-AI (owner: "a Chat inside Chat"): the group is Messages; inside it Chats (with its Chats · Groups · Calls tabs) and Calls.
  { key: "chat", label: "Messages", blurb: "Chats, groups and calls" },
  { key: "sales", label: "Sales & clients", short: "Sales", blurb: "Leads, clients, quotes and agreements" },
  { key: "money", label: "Money", blurb: "Billing, finance and goals" },
  { key: "people", label: "People", blurb: "Your team, check-in, leave and pay" },
  { key: "growth", label: "Growth", blurb: "PR Studio, other companies and investors" },
  { key: "ai", label: "AI", blurb: "AI employees and your own AI" },
  { key: "settings", label: "Settings", blurb: "Your account, the company and admin" },
] as const;
export type NavGroupKey = typeof NAV_GROUPS[number]["key"];
export const GROUP_KEYS: readonly NavGroupKey[] = NAV_GROUPS.map((g) => g.key);

/** One short plain line under each page in the launcher, and the other words people use for it (Ctrl+K and the
 *  launcher's search find a page by any of them). Keyed by the entry's href. */
export const ABOUT: Readonly<Record<string, { blurb: string; words?: readonly string[] }>> = {
  "/dashboard": { blurb: "Your company at a glance", words: ["home", "overview", "start", "numbers"] },
  "/client": { blurb: "Your work with the team", words: ["home", "my space"] },
  "/my-day": { blurb: "What to do today, in order", words: ["today", "my tasks today", "plan my day", "agenda"] },
  "/founder": { blurb: "Every company you run, on one screen", words: ["all companies", "founder", "my companies", "overview", "owner view", "portfolio"] },
  "/connections": { blurb: "People and companies you work with", words: ["clients", "partners", "freelancers", "contracts", "agreements", "shared", "network", "who I work with"] },
  "/updates": { blurb: "News and posts from the company", words: ["announcements", "news", "notice board", "feed"] },
  "/whats-new": { blurb: "What changed in Pulse lately", words: ["new features", "release notes", "changelog", "latest"] },
  "/learn": { blurb: "Short how-to videos and guides", words: ["help", "tutorial", "training", "how do i", "videos", "guide"] },
  "/tasks": { blurb: "Your to-do list and your team's", words: ["work", "to do", "todo", "my tasks", "assignments", "kanban", "projects"] },
  "/tasks?view=projects": { blurb: "Your company's own projects", words: ["work projects", "internal projects"] },
  "/docs": { blurb: "Write, store and share documents", words: ["documents", "files", "drive", "notes", "wiki", "folders"] },
  "/processes": { blurb: "Step-by-step ways we do things", words: ["sops", "procedures", "workflows", "checklists", "how we work", "boards"] },
  "/runs": { blurb: "Projects going through a process", words: ["process runs", "pipeline", "stages"] },
  "/calendar": { blurb: "Everything with a date, in one place", words: ["calendar", "my calendar", "schedule", "agenda", "what is on", "who is on leave", "due dates", "meetings this week", "milestones", "google calendar", "my companies", "time by company"] },
  "/meetings": { blurb: "Transcripts and recordings, the tasks", words: ["meeting", "minutes", "mom", "notes", "transcript", "record", "action items", "loom", "otter", "wispr", "captions", "narrate a problem"] },
  "/creative": { blurb: "Plan ad ideas in short sprints", words: ["creative strategy", "ads", "creatives", "sprints", "concepts"] },
  "/product-map": { blurb: "Screens and journeys of an app", words: ["product map", "screens", "user journeys", "app map"] },
  "/chats": { blurb: "Messages with your team and clients", words: ["messages", "chat", "whatsapp", "dm", "inbox", "groups", "conversation"] },
  "/calls": { blurb: "Calls you made, got or missed", words: ["calls", "call log", "missed calls", "phone", "video call"] },
  "/sales": { blurb: "Your leads, quotes and deals", words: ["my sales", "my deals", "pipeline", "targets", "commission"] },
  "/acquisition": { blurb: "New enquiries and ad campaigns", words: ["leads", "acquisition", "enquiries", "ads", "campaigns", "marketing", "prospects"] },
  "/clients": { blurb: "Everyone you work for", words: ["customers", "accounts", "client list", "buyers"] },
  "/contacts": { blurb: "Phone book of people outside", words: ["phone book", "vendors", "partners", "suppliers", "people outside"] },
  "/contacts/companies": { blurb: "Businesses you work with", words: ["companies", "businesses", "organisations", "firms", "brands"] },
  "/erp/documents?view=quotation": { blurb: "Make and send price quotes", words: ["quotes", "quotation", "estimate", "proposal", "price", "quote"] },
  "/contracts": { blurb: "Deals your clients sign", words: ["agreements", "contracts", "sign", "e-sign", "signature", "deal"] },
  "/map": { blurb: "Clients and sites on a map", words: ["map", "locations", "sites", "places"] },
  "/insights": { blurb: "What client chats are saying", words: ["client operations", "whatsapp insights", "complaints", "signals"] },
  "/apps/sales-xray": { blurb: "Check a sales call, get tips", words: ["sales x-ray", "xray", "call review", "sales coaching"] },
  "/erp": { blurb: "Invoices, payments and products", words: ["billing", "invoice", "invoices", "bills", "payments", "gst", "erp", "receipts"] },
  "/finance": { blurb: "Money in, money out, profit", words: ["finance", "accounts", "expenses", "cash", "profit", "p&l", "bank"] },
  "/finance/desk": { blurb: "Check the books for your CA", words: ["ca", "accountant", "ca check", "books"] },
  "/goals": { blurb: "Big targets and how far you are", words: ["goals", "okr", "okrs", "targets", "objectives", "key results"] },
  "/funding": { blurb: "Investors and funding talks", words: ["funding", "investors", "fundraise", "raise money", "vc"] },
  // HR-PEOPLE (owner, 13 Nov 2026: "it says everyone in the company… where is this everyone?"): the blurb names what the page shows.
  "/people": { blurb: "Your team: who they are and their roles", words: ["team", "staff", "employees", "colleagues", "people", "org chart"] },
  "/me": { blurb: "Check in, leave, requests and pay", words: ["check in", "checkin", "attendance", "leave", "my desk", "payslip", "requests", "punch in"] },
  "/cover": { blurb: "Who covers while someone is away", words: ["cover", "leave cover", "wfh cover", "who covers", "backup", "handover"] },
  "/learn/training": { blurb: "Courses for the team", words: ["training", "courses", "quiz", "onboarding videos"] },
  "/tasks/map": { blurb: "What is blocking what", words: ["blockers", "dependencies", "what is blocking", "waiting on"] },
  "/tasks/merge": { blurb: "Merge duplicate tasks", words: ["merge tasks", "duplicates", "tidy up"] },
  "/erp/rate-cards": { blurb: "Your price list per service", words: ["rate card", "price list", "pricing"] },
  "/orgs/resume": { blurb: "Your resume", words: ["resume", "cv", "work history"] },
  "/orgs/career": { blurb: "Your career across companies", words: ["career", "my profile", "work history"] },
  "/chats/whatsapp/review": { blurb: "Check voice-note transcripts", words: ["whatsapp voice notes", "transcripts", "check transcripts"] },
  "/people/pay": { blurb: "Pay, offers and the pay policy", words: ["pay", "salary", "payroll", "pay policy", "offers", "probation", "claims"] },
  "/hr": { blurb: "Attendance, leave and HR work", words: ["hr", "human resources", "attendance", "leave approvals", "policies", "onboarding", "payroll"] },
  "/leadership": { blurb: "How each team is doing", words: ["leadership", "pods", "managers", "team health"] },
  "/pr": { blurb: "Plan and post on LinkedIn and Instagram", words: ["pr", "pr studio", "posts", "post", "content calendar", "calendar", "social media", "linkedin", "instagram", "brand", "my brand", "marketing", "content", "personal brand"] },
  "/directory": { blurb: "Find other companies and people", words: ["find companies", "company search", "directory", "gstin", "find people", "other companies"] },
  "/network": { blurb: "Companies on Pulse Network", words: ["network", "partners", "pulse network"] },
  "/hq": { blurb: "Pulse's own business: offers and licences", words: ["pulse hq", "hq", "catalogue", "licences", "offers"] },
  "/case-studies": { blurb: "Partner businesses on the 45-day journey", words: ["case studies", "case study", "success stories", "pilots", "partners", "journey", "before and after"] },
  "/hq/investors": { blurb: "Numbers to show investors", words: ["investor metrics", "investor numbers", "mrr", "arr", "growth numbers", "kpis"] },
  "/people/ai": { blurb: "What your AI helpers did today", words: ["ai employees", "ai workload", "agents", "bots", "ai staff", "ai workers"] },
  "/settings?tab=connect-ai": { blurb: "Use Pulse from Claude or ChatGPT", words: ["connect ai", "claude", "chatgpt", "gemini", "mcp", "connector", "my ai"] },
  "/listen": { blurb: "Let your AI listen and take notes", words: ["listen", "live transcript", "listening", "dictation"] },
  "/focus": { blurb: "Your AI capacity and today's plan", words: ["focus", "ai capacity", "quota", "limits", "codex", "claude usage"] },
  "/settings": { blurb: "Your account, alerts and the company", words: ["settings", "preferences", "profile", "password", "notifications", "company settings"] },
  "/review-data": { blurb: "Fix names and data people sent", words: ["review data", "data cleanup", "data health"] },
  "/audit": { blurb: "Who changed what, and when", words: ["audit", "audit log", "history", "changes"] },
  "/telemetry": { blurb: "Where Pulse is slow", words: ["telemetry", "speed", "performance", "errors"] },
  "/admin": { blurb: "Pulse's back office", words: ["admin console", "platform", "organisations"] },
  "/bug-reports": { blurb: "Problems people reported", words: ["bugs", "bug reports", "issues", "problems"] },
  "/features": { blurb: "Everything Pulse can do", words: ["features", "what pulse can do", "catalogue"] },
};

/** Role defaults (owner: "salespeople don't see admin clutter"): which groups start open, what starts pinned and what
 *  starts hidden from the sidebar. Hidden pages stay in All apps and Ctrl+K; a person changes all of it with Edit menu. */
export type NavDefaults = Readonly<{ open: readonly NavGroupKey[]; pins: readonly string[]; hide: readonly string[] }>;
const MEMBER: NavDefaults = { open: ["home", "work"], pins: [], hide: ["/product-map", "/runs"] };
export const ROLE_DEFAULTS: Readonly<Record<string, NavDefaults>> = {
  "Organisation owner/admin": { open: ["home", "work"], pins: [], hide: [] },
  Leadership: { open: ["home", "work"], pins: [], hide: [] },
  "HR and leadership": { open: ["home", "people"], pins: [], hide: [] },
  HR: { open: ["home", "people"], pins: [], hide: [] },
  Sales: { open: ["home", "sales"], pins: ["/sales", "/clients", "/erp/documents?view=quotation"], hide: ["/product-map", "/runs", "/processes", "/creative", "/map"] },
  Finance: { open: ["home", "money"], pins: [], hide: ["/product-map", "/runs"] },
  "Manager / PGS": { open: ["home", "work"], pins: [], hide: ["/product-map"] },
  Member: MEMBER,
};
export const defaultsFor = (role: string | undefined): NavDefaults => ROLE_DEFAULTS[role ?? ""] ?? MEMBER;

/** What a person changed (Edit menu), kept in this browser: pinned and hidden entries, the group order, open groups. */
export type NavPrefs = Readonly<{ pins?: readonly string[]; hide?: readonly string[]; order?: readonly NavGroupKey[]; open?: Readonly<Record<string, boolean>> }>;
export const NAV_PREFS_KEY = "pulse.nav.v1";
const strings = (v: unknown, max = 60) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.startsWith("/") && x.length < 200).slice(0, max) : undefined;
/** Reads saved preferences leniently: anything malformed is ignored. */
export function prefsFrom(raw: unknown): NavPrefs {
  const d = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const order = Array.isArray(d.order) ? d.order.filter((k): k is NavGroupKey => (GROUP_KEYS as readonly unknown[]).includes(k)) : undefined;
  const open = d.open && typeof d.open === "object" ? Object.fromEntries(Object.entries(d.open as Record<string, unknown>).filter(([k, v]) => (GROUP_KEYS as readonly string[]).includes(k) && typeof v === "boolean")) as Record<string, boolean> : undefined;
  return { pins: strings(d.pins, 12), hide: strings(d.hide), order: order?.length ? order : undefined, open };
}
/** The group order: the person's own first (every group once), Settings always last. */
export function groupOrder(prefs: NavPrefs): NavGroupKey[] {
  const own: NavGroupKey[] = (prefs.order ?? []).filter((k, i, all) => k !== "settings" && all.indexOf(k) === i);
  return [...own, ...GROUP_KEYS.filter((k) => k !== "settings" && !own.includes(k)), "settings"];
}
/** Moves a group one place up or down (never past Settings). */
export function moveGroup(prefs: NavPrefs, key: NavGroupKey, by: -1 | 1): NavPrefs {
  const order: NavGroupKey[] = groupOrder(prefs).filter((k) => k !== "settings");
  const at = order.indexOf(key); const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return prefs;
  [order[at], order[to]] = [order[to], order[at]];
  return { ...prefs, order };
}
export const pinsOf = (prefs: NavPrefs, role?: string) => prefs.pins ?? defaultsFor(role).pins;
export const hiddenOf = (prefs: NavPrefs, role?: string) => prefs.hide ?? defaultsFor(role).hide;
/** Open: the person's own choice, else the group of the page they are on; on Home's pages the role's everyday groups
 *  open too (away from Home only the current group opens, so the sidebar stays short). */
export const groupOpen = (prefs: NavPrefs, role: string | undefined, key: NavGroupKey, active: boolean, onHome = true) =>
  prefs.open?.[key] ?? (active || (onHome && defaultsFor(role).open.includes(key)));
const toggle = (list: readonly string[], href: string) => list.includes(href) ? list.filter((h) => h !== href) : [...list, href];
export const togglePin = (prefs: NavPrefs, role: string | undefined, href: string): NavPrefs => ({ ...prefs, pins: toggle(pinsOf(prefs, role), href).slice(-12) });
export const toggleHidden = (prefs: NavPrefs, role: string | undefined, href: string): NavPrefs => ({ ...prefs, hide: toggle(hiddenOf(prefs, role), href) });

/** Plain-text search over the launcher's entries: a name that starts with the words wins, then a name that holds them,
 *  then one of its other words, then its short line and group. Every word typed must match somewhere. */
export type Findable = { label: string; href: string; group: string; blurb?: string; words?: readonly string[]; parent?: string };
export const normal = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").replace(/[^a-z0-9&+]+/g, " ").trim();
export function findApps<T extends Findable>(items: readonly T[], query: string): T[] {
  const q = normal(query);
  if (!q) return [...items];
  const terms = q.split(" ");
  const scored = items.map((item, i) => {
    const label = normal(item.label), words = (item.words ?? []).map(normal), rest = normal(`${item.blurb ?? ""} ${item.group} ${item.parent ?? ""}`);
    const all = `${label} ${words.join(" ")} ${rest}`;
    if (!terms.every((t) => all.split(" ").some((w) => w.startsWith(t)) || all.includes(t))) return null;
    // A whole name or one of its words said exactly beats a name that only starts with the letters ("pr" → PR Studio,
    // not Processes).
    const score = label === q ? 100 : words.some((w) => w === q) ? 90 : label.split(" ").includes(q) ? 85 : label.startsWith(q) ? 80
      : label.split(" ").some((w) => w.startsWith(q)) ? 60 : words.some((w) => w.startsWith(q)) ? 50 : label.includes(q) ? 40 : words.some((w) => w.includes(q)) ? 30 : 10;
    return { item, score: score - (item.parent ? 5 : 0) - i / 10000 };
  }).filter((x): x is { item: T; score: number } => x !== null);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.item);
}
