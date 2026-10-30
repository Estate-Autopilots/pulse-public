// UX-5B: the destinations registry. Every page, tab, settings section and important control Pulse can send someone to:
// an id, a route, the anchor on the page (`data-dest="<id>"`), a label and synonyms people use, who can see it, and the
// events (packages/schemas/registry.yaml) that mean "this was changed". Plain data with no React and no server-only
// imports: the task page, "Go there", the task companion and Ctrl+K (UX-5A) all read this one list.
//
// Rules: ids are dotted and stable (links and tasks keep them); `href` is the exact route with its query, never a
// #hash (`goHref()` adds `go=<id>`, which the spotlight answers); a section or control must be marked on its page with
// `{...dest(id)}` or `data-dest="<id>"` (destinations.test.mjs fails when an anchor disappears); every event must be a
// registered type.

// ------------------------------------------------------------------------------------------------------- the events
/** Registered event types the database emits when something people can be sent to changes (registry.yaml). */
export const EVENTS = {
  "office.added": "An office was added",
  "office.network.saved": "An office's Wi-Fi or public IP was saved",
  "attendance.checked_in": "Someone checked in",
  "attendance.office.arrived": "Someone's phone checked them in on arriving at an office",
  "checkin.arrival.saved": "What arriving at the office does was saved",
  "checkin.reminders.saved": "Check-in reminders were saved",
  "payroll.cutoff.saved": "The payroll cut-off day was saved",
  "presence.auto.saved": "Automatic check-in was switched on or off",
  "policy.published": "A policy was published",
  "holiday.added": "A holiday was added",
  "leave.decided": "A leave request was approved or declined",
  "project.added": "A project was created",
  "client.added": "A client was added",
  "comp.offer.sent": "A founder sent an offer",
};

/** What a person did, for the companion: "You saved the office Wi-Fi". `data` is the event's ids and counts. */
export function said(event, data = {}) {
  if (event === "office.network.saved") {
    const w = Number(data?.wifi_count ?? 0) > 0, ip = Number(data?.ip_count ?? 0) > 0;
    return `saved the office ${w && ip ? "Wi-Fi and IP" : w ? "Wi-Fi" : ip ? "IP" : "network"}`;
  }
  return {
    "office.added": "added an office", "attendance.checked_in": "checked in", "attendance.office.arrived": "checked in on arriving at the office",
    "checkin.arrival.saved": "saved what arriving at the office does", "checkin.reminders.saved": "saved the check-in reminders",
    "payroll.cutoff.saved": "saved the payroll cut-off", "presence.auto.saved": "saved automatic check-in", "policy.published": "published a policy",
    "holiday.added": "added a holiday", "leave.decided": "decided a leave request", "project.added": "created a project", "client.added": "added a client", "comp.offer.sent": "sent the offer",
  }[event] ?? "made a change";
}

// ---------------------------------------------------------------------------------------------------- the registry

const P = (id, label, href, access, extra = {}) => ({ id, label, href, kind: "page", access, ...extra });
const T = (id, label, href, parent, extra = {}) => ({ id, label, href, kind: "tab", parent, ...extra });
const S = (id, label, href, parent, extra = {}) => ({ id, label, href, kind: "section", parent, ...extra });
const C = (id, label, href, parent, extra = {}) => ({ id, label, href, kind: "control", parent, ...extra });

const PRESENCE = "/hr?tab=policies&view=presence";
const CHECKIN = "/hr?tab=onboard&view=settings";
const ARRIVAL_SIGNAL = { event: "attendance.office.arrived", label: "people checked in on arriving at the office", distinct: "subject",
  when: [["arrival", "arrive", "arrives", "arriving", "geofence"], ["check in", "check-in", "checkin", "checks in", "checked in", "check-ins"]] };

const ENTRIES = [
  // Pages on the rail.
  P("dashboard", "Dashboard", "/dashboard", "all", { synonyms: ["home", "overview", "start"], icon: "House" }),
  P("work", "Work", "/tasks", "work", { path: ["Work"], synonyms: ["tasks", "to do", "todo", "my tasks"], icon: "CircleCheck" }),
  P("chats", "Chats", "/chats", "all", { synonyms: ["messages", "whatsapp", "chat", "groups"], module: "chats", icon: "MessageCircle" }),
  T("chats.calls", "Calls", "/calls", "chats", { synonyms: ["calls", "call log", "missed calls", "call history", "phone calls", "video calls"], module: "chats" }),
  // VISIBLE (owner, 25 Oct 2026): the groups hub, its views and the WhatsApp signals, found by name (they were only icons).
  P("groups-hub", "All groups", "/chats/groups", "all", { path: ["Chats", "All groups"], synonyms: ["groups hub", "group hub", "whatsapp groups", "group chats", "every group", "client groups"], module: "chats", icon: "MessageCircle" }),
  T("groups-hub.clients", "Client groups", "/chats/groups?kinds=client", "groups-hub", { synonyms: ["clients' groups", "client whatsapp groups", "client project groups"], module: "chats" }),
  T("groups-hub.waiting", "Groups waiting on us", "/chats/groups?quick=waiting&sort=waiting", "groups-hub", { synonyms: ["waiting on us", "who is waiting", "unanswered clients", "clients waiting"], module: "chats" }),
  T("groups-hub.review", "Imported groups to review", "/chats/groups?tab=review", "groups-hub", { synonyms: ["who is this", "link groups to projects", "imported whatsapp review"], module: "chats" }),
  P("signals", "WhatsApp signals", "/chats/whatsapp/signals", "admin", { path: ["Chats", "WhatsApp signals"], synonyms: ["signals", "complaints", "churn signals", "upsell", "payment asks", "lead quality"], module: "chats", icon: "Sparkles" }),
  P("whats-new", "What's new in Pulse", "/whats-new", "all", { synonyms: ["new features", "what changed", "latest update", "release", "new in pulse"], icon: "Sparkles" }),
  P("story", "Product Story", "/story", "all", { synonyms: ["product story", "versions", "version history", "changelog", "release notes", "product documentation", "what changed"], icon: "BookOpen" }),
  P("clients", "Clients", "/clients", "work", { synonyms: ["customers", "accounts"], icon: "Building2" }),
  T("clients.access", "Pulse access for clients", "/clients?tab=access", "clients", { synonyms: ["client portal", "invite a client", "client login", "client access", "clients on pulse"] }),
  P("acquisition", "Acquisition", "/acquisition", "work", { synonyms: ["leads", "ads", "campaigns", "marketing"], module: "acquisition", icon: "TrendingUp" }),
  P("contacts", "Contacts", "/contacts", "work", { synonyms: ["people outside", "vendors", "partners", "phone book"], icon: "BookUser" }),
  P("map", "Map", "/map", "work", { synonyms: ["locations", "sites", "shoot places"], module: "map", icon: "Map" }),
  P("sops", "Processes", "/processes", "work", { synonyms: ["sops", "procedures", "workflows", "process", "how we work", "boards"], icon: "Workflow" }),
  P("team", "Team", "/people", "all", { synonyms: ["people", "staff", "employees", "directory", "colleagues"], icon: "Users" }),
  P("me", "My desk", "/me", "all", { synonyms: ["my attendance", "my leave", "desk", "me", "my day"], icon: "CalendarCheck" }),
  P("hr", "HR desk", "/hr", "hr", { path: ["HR"], synonyms: ["hr", "human resources", "people ops"], module: "hr", icon: "BriefcaseBusiness" }),
  P("leadership", "Leadership", "/leadership", "admin", { synonyms: ["company pulse", "founders", "management"], icon: "TrendingUp" }),
  // WA-NATIVE: what the company's WhatsApp groups say about running a client (leadership and admins).
  P("insights", "Insights", "/insights", "admin", { synonyms: ["client operations", "whatsapp analysis", "churn", "churn risk", "patterns", "playbook", "onboarding sop", "recommendations"], icon: "Lightbulb" }),
  T("insights.path", "Service path", "/insights?tab=path", "insights", { synonyms: ["service timings", "start to live", "approval time"] }),
  T("insights.wrong", "Where it goes wrong", "/insights?tab=wrong", "insights", { synonyms: ["lead quality", "complaints", "clients at risk"] }),
  T("insights.sop", "Onboarding SOP vs reality", "/insights?tab=sop", "insights", { synonyms: ["sop adherence", "sop review"] }),
  // INSIGHTS-2: who waits for whom (answer times, when clients write) and the pattern library.
  T("insights.waiting", "Who waits", "/insights?tab=waiting", "insights", { synonyms: ["answer time", "response time", "when clients write", "who waits for whom"] }),
  T("insights.patterns", "Patterns", "/insights?tab=patterns", "insights", { synonyms: ["pattern library", "what works", "findings"] }),
  // WA-REPORT: the analysis book — company, pods, every colleague, every client (leadership and admins; a colleague their own page).
  T("insights.reports", "Reports", "/insights/reports", "insights", { synonyms: ["report", "analysis", "the book", "employee report", "person report", "client report", "pod report", "performance report"] }),
  P("finance", "Finance", "/finance", "admin", { synonyms: ["money", "accounts", "books", "cash"], module: "money", icon: "Wallet" }),
  P("erp", "Billing", "/erp", "admin", { synonyms: ["erp", "invoices", "quotations", "quotes", "catalogue", "catalog", "packages", "inventory", "stock"], module: "money", icon: "ReceiptText" }),
  P("review-data", "Review data", "/review-data", "hr", { synonyms: ["review queue", "data review", "matches"], icon: "ScanSearch" }),
  P("audit", "Audit", "/audit", "admin", { synonyms: ["audit log", "who changed what", "history of changes"], icon: "ShieldCheck" }),
  P("settings", "Settings", "/settings", "all", { synonyms: ["preferences", "configuration", "setup"], icon: "Settings" }),
  P("notifications", "Notifications", "/notifications", "all", { synonyms: ["alerts", "bell", "notices"], icon: "Bell" }),
  P("briefs", "Role briefs", "/briefs", "all", { synonyms: ["brief", "daily brief", "morning brief"], module: "briefs", icon: "Newspaper" }),

  // Work.
  T("work.mine", "My tasks", "/tasks?scope=me", "work", { synonyms: ["my work", "assigned to me"] }),
  T("work.company", "All tasks", "/tasks?scope=company", "work", { synonyms: ["everyone's tasks", "company tasks"] }),
  T("work.pool", "The pool", "/tasks?scope=pool", "work", { path: ["Work", "Pool"], synonyms: ["task pool", "claim", "open tasks"] }),
  T("work.projects", "Projects", "/tasks?view=projects", "work", { synonyms: ["work projects", "internal projects"] }),
  T("work.board", "Board", "/tasks?view=board", "work", { synonyms: ["kanban", "columns"] }),
  T("work.team", "Team dashboard", "/tasks?view=team", "work", { synonyms: ["who does what", "leader view"] }),
  T("work.outcomes", "Outcomes", "/tasks/outcomes", "work", { synonyms: ["value delivered", "results", "points"] }),
  T("work.map", "Unlock map", "/tasks/map", "work", { synonyms: ["dependencies", "what waits on what", "blockers map"] }),
  T("work.client-projects", "Client projects", "/projects", "clients", { synonyms: ["packages", "client packages", "fulfilment"] }),

  // HR desk.
  T("hr.dashboard", "Dashboard", "/hr?tab=dashboard", "hr", { synonyms: ["hr overview"] }),
  T("hr.onboard", "Onboard team", "/hr?tab=onboard", "hr", { synonyms: ["onboarding", "invites", "rollout", "invite to pulse"] }),
  T("hr.onboard.team", "Team", "/hr?tab=onboard&view=team", "hr.onboard", { synonyms: ["who has signed in", "bank details", "profiles", "invite list"] }),
  T("hr.onboard.settings", "Check-in settings", CHECKIN, "hr.onboard", { synonyms: ["check-in rules", "checkin rules", "arrival", "reminders", "payroll cut-off"] }),
  S("hr.onboard.settings.arrival", "When someone arrives at the office", CHECKIN, "hr.onboard.settings", { synonyms: ["arrival", "ask first", "automatic check-in", "check in?"], events: ["checkin.arrival.saved"], coach: "Choose what arriving at the office does",
    signals: [{ event: "checkin.arrival.saved", label: "Arrival setting saved", when: [["arrival", "arriving"], ["setting", "settings", "rule", "rules", "ask first", "automatic", "decide"]] }] }),
  S("hr.onboard.settings.reminders", "Check-in reminders", CHECKIN, "hr.onboard.settings", { synonyms: ["reminder times", "remind to check in", "long break"], events: ["checkin.reminders.saved"], coach: "Set the reminder times here",
    signals: [{ event: "checkin.reminders.saved", label: "Reminders saved", when: [["reminder", "reminders"]] }] }),
  S("hr.onboard.settings.cutoff", "Payroll cut-off", CHECKIN, "hr.onboard.settings", { synonyms: ["cut-off date", "cutoff", "payroll date", "attendance closes"], events: ["payroll.cutoff.saved"], coach: "Pick the payroll cut-off day here",
    signals: [{ event: "payroll.cutoff.saved", label: "Payroll cut-off saved", when: [["cut-off", "cutoff", "cut off"]] }] }),
  S("hr.onboard.settings.profiles", "Profiles and documents to ask for", CHECKIN, "hr.onboard.settings", { synonyms: ["documents to ask", "profile reminders", "aadhaar", "pan"] }),
  T("hr.onboard.kit", "Rollout kit", "/hr?tab=onboard&view=kit", "hr.onboard", { synonyms: ["staff message", "whatsapp message", "draft message", "rollout"] }),
  T("hr.moves", "People moves", "/hr?tab=moves", "hr", { synonyms: ["joiners", "leavers", "promotions", "transfers"] }),
  T("hr.approvals", "Approvals", "/hr?tab=approvals", "hr", { synonyms: ["approve", "waiting for hr"] }),
  T("hr.pods", "Pod heads", "/hr?tab=pods", "hr", { synonyms: ["heads", "pods", "managers"] }),
  T("hr.attendance", "Attendance", "/hr?tab=attendance", "hr", { synonyms: ["check-ins", "who is in", "corrections", "regularisation"] }),
  T("hr.leave", "Leave", "/hr?tab=leave", "hr", { synonyms: ["leave requests", "time off", "balances"], events: ["leave.decided"] }),
  T("hr.requests", "Requests", "/hr?tab=requests", "hr", { synonyms: ["tickets", "hr requests", "help requests"] }),
  T("hr.payroll", "Payroll", "/hr?tab=payroll", "hr", { synonyms: ["salary", "payslips", "pay run"] }),
  T("hr.policies", "Policies", "/hr?tab=policies", "hr", { synonyms: ["policy", "rules", "staff notice"] }),
  T("hr.policies.documents", "Documents", "/hr?tab=policies&view=documents", "hr.policies", { synonyms: ["policy documents", "staff notice", "handbook", "publish policy"], events: ["policy.published"],
    signals: [{ event: "policy.published", label: "Policy published", when: [["publish", "published"]] }] }),
  T("hr.policies.rules", "Working rules", "/hr?tab=policies&view=rules", "hr.policies", { synonyms: ["working hours", "late rules", "half day", "shift rules"] }),
  T("hr.policies.leave", "Leave & holidays", "/hr?tab=policies&view=leave", "hr.policies", { synonyms: ["holidays", "holiday list", "leave types"], events: ["holiday.added"],
    signals: [{ event: "holiday.added", label: "Holiday added", when: [["holiday", "holidays"]] }] }),
  C("hr.policies.leave.holiday", "Add a holiday", "/hr?tab=policies&view=leave", "hr.policies.leave", { synonyms: ["new holiday", "holiday date", "festival"], events: ["holiday.added"], coach: "Add the holiday here: its date and name",
    signals: [{ event: "holiday.added", label: "Holiday added", when: [["holiday", "holidays"]] }] }),
  T("hr.policies.patterns", "Patterns & shifts", "/hr?tab=policies&view=patterns", "hr.policies", { synonyms: ["shifts", "work calendar", "weekly off", "pattern"] }),
  T("hr.policies.presence", "Office presence", PRESENCE, "hr.policies", { synonyms: ["office", "offices", "geofence", "presence", "office location", "check-in at office"], events: ["office.added", "office.network.saved", "presence.auto.saved"], coach: "Offices phones recognise",
    signals: [ARRIVAL_SIGNAL] }),
  C("hr.policies.presence.auto", "Automatic check-in at an office", PRESENCE, "hr.policies.presence", { synonyms: ["auto check-in", "automatic check-in", "allow automatic"], events: ["presence.auto.saved"], coach: "Switch automatic check-in here",
    signals: [{ event: "presence.auto.saved", label: "Automatic check-in setting saved", when: [["automatic check-in", "auto check-in", "automatic check in", "auto check in"]] }] }),
  // ATT: the company's break, automatic check-out and question rules.
  C("hr.policies.presence.rules", "Breaks and check-out rules", PRESENCE, "hr.policies.presence", { synonyms: ["break rules", "breaks", "lunch break", "auto check-out", "automatic check-out", "check-out rules", "paid break", "grace"], events: ["presence.auto.saved"], coach: "Set breaks and automatic check-out here",
    signals: [{ event: "presence.auto.saved", label: "Attendance rules saved", when: [["break", "automatic check-out", "auto check-out", "grace"]] }] }),
  C("hr.policies.presence.office", "Office location and radius", PRESENCE, "hr.policies.presence", { synonyms: ["office location", "add an office", "radius", "coordinates", "latitude"], events: ["office.added"], coach: "Add the office and its location here",
    signals: [{ event: "office.added", label: "Office added", when: [["add an office", "new office", "office location", "second office", "another office"]] }] }),
  C("hr.policies.presence.ip", "Office IP", PRESENCE, "hr.policies.presence", { synonyms: ["office ip", "public ip", "ip address", "cidr", "office network", "internet"], events: ["office.network.saved"], needs: "hr.policies.presence.office", coach: "Add the office’s public IP here",
    signals: [{ event: "office.network.saved", label: "Office IP saved", when: [["ip", "ip address", "public ip", "cidr"]], where: { ip_count: { gte: 1 } } }, ARRIVAL_SIGNAL] }),
  C("hr.policies.presence.wifi", "Office Wi-Fi", PRESENCE, "hr.policies.presence", { synonyms: ["office wi-fi name", "office wifi", "wi-fi", "wifi", "ssid", "bssid", "wireless", "office network", "office internet", "router"], events: ["office.network.saved"], needs: "hr.policies.presence.office", coach: "Add the office Wi-Fi here",
    signals: [{ event: "office.network.saved", label: "Office Wi-Fi saved", when: [["wi-fi", "wifi", "ssid", "bssid", "wireless"]], where: { wifi_count: { gte: 1 } } }, ARRIVAL_SIGNAL] }),
  T("hr.policies.approvals", "Approvals & comp-off", "/hr?tab=policies&view=approvals", "hr.policies", { synonyms: ["comp off", "comp-off", "approval rules", "who approves"] }),

  // My desk.
  T("me.overview", "Overview", "/me", "me", { path: ["My desk", "Overview"] }),
  T("me.attendance", "Attendance", "/me?tab=attendance", "me", { synonyms: ["check in", "check-in", "check out", "my attendance", "corrections"], events: ["attendance.checked_in"],
    signals: [{ event: "attendance.checked_in", label: "Checked in", when: [["check in", "check-in", "checkin"], ["myself", "my own", "yourself", "your own", "my attendance"]] }] }),
  T("me.leave", "Leave", "/me?tab=leave", "me", { synonyms: ["apply for leave", "time off", "my leave"] }),
  T("me.performance", "Performance", "/me?tab=performance", "me", { synonyms: ["my performance", "my value"] }),
  T("me.requests", "Requests", "/me?tab=requests", "me", { synonyms: ["ask hr", "my requests"] }),
  T("me.history", "History", "/me?tab=history", "me", { synonyms: ["payslips", "my history", "salary history"] }),
  T("me.policies", "Policies", "/me?tab=policies", "me", { synonyms: ["read policies", "staff notice"] }),
  T("me.accounts", "Upload accounts", "/me?tab=accounts", "me", { synonyms: ["my accounts", "upload account"] }),
  P("me.approvals", "Waiting for you", "/me/approvals", "all", { parent: "me", path: ["My desk", "Waiting for you"], synonyms: ["approvals", "approve"] }),
  P("me.work", "My work", "/me/work", "all", { parent: "me", path: ["My desk", "My work"], synonyms: ["my week", "this week"] }),
  // UX-5A: My desk's sections in order (Ctrl+K opens them at the spot) and the Attendance tab's day-off action.
  S("me.today", "Today on My desk", "/me", "me.overview", { synonyms: ["today", "my day", "check in today"], coach: "Check in, take a break or check out here" }),
  S("me.due", "Due today", "/me", "me.overview", { synonyms: ["due today", "deadlines today", "my tasks today"] }),
  S("me.week", "My week", "/me", "me.overview", { synonyms: ["this week", "streak", "points this week", "hours this week"] }),
  S("me.recognition", "Recognition", "/me", "me.overview", { synonyms: ["thanks", "kudos", "thank-yous", "appreciation"] }),
  S("me.time-off", "Time off", "/me", "me.overview", { synonyms: ["leave balance", "leave left", "days off left", "holidays left"] }),
  C("me.attendance.day-off", "Work on a day off", "/me?tab=attendance", "me.attendance", { synonyms: ["day off", "weekly off", "holiday", "sunday", "work on a holiday", "extra day", "comp off"],
    coach: "Ask to work on a weekly off or holiday here" }),

  // Team.
  T("team.directory", "Directory", "/people", "team", { synonyms: ["people list", "staff list"] }),
  P("team.org", "Org chart", "/people/org", "all", { parent: "team", path: ["Team", "Org chart"], synonyms: ["reporting lines", "who reports to whom", "hierarchy"] }),
  P("team.skills", "Skills", "/people/skills", "all", { parent: "team", path: ["Team", "Skills"], synonyms: ["skills list", "cv", "talent"], module: "skills" }),
  P("team.jobs", "Internal jobs", "/people/jobs", "hr", { parent: "team", path: ["Team", "Internal jobs"], synonyms: ["jobs", "openings", "matching"], module: "jobs" }),
  // COMP-A: pay from offer to exit. Sending an offer is the event a linked "Issue … offer letter" task waits for.
  P("team.pay", "People & pay", "/people/pay", "hr", { parent: "team", path: ["Team", "People & pay"], events: ["comp.offer.sent"],
    synonyms: ["pay", "salary", "salaries", "compensation", "ctc", "raise", "increment", "offer", "offer letter", "probation", "pause pay", "bonus", "advance", "full and final", "fnf"] }),
  P("team.pay.policy", "Pay policy", "/people/pay/settings", "hr", { parent: "team.pay", path: ["Team", "People & pay", "Pay policy"], synonyms: ["salary structure", "who approves pay", "notice period", "letter templates"] }),
  P("team.pay.claims", "Claims to review", "/people/pay/claims", "all", { parent: "team.pay", path: ["Team", "People & pay", "Claims to review"], synonyms: ["reimbursements to approve", "expense claims"] }),
  // COMP-B: the monthly payroll run (HR checks, a founder approves), payslips and the bank file.
  P("team.pay.payroll", "Payroll", "/people/pay/payroll", "hr", { parent: "team.pay", path: ["Team", "People & pay", "Payroll"],
    synonyms: ["payroll", "run payroll", "salary run", "payslips", "pay slips", "bank file", "salary transfer", "pf", "esi", "professional tax", "tds"] }),
  P("me.pay", "My pay", "/me/pay", "all", { parent: "me", path: ["My desk", "My pay"], synonyms: ["my salary", "pay letter", "my offer", "reimbursement", "claim", "snap a bill", "expense"] }),

  // Leadership.
  T("leadership.overview", "Company pulse", "/leadership", "leadership", { synonyms: ["company overview"] }),
  T("leadership.delivery", "Delivery & quality", "/leadership?tab=delivery", "leadership", { synonyms: ["quality", "deliveries"] }),
  T("leadership.pods", "Pods & teams", "/leadership?tab=pods", "leadership", { synonyms: ["pods", "teams"] }),
  T("leadership.people", "People", "/leadership?tab=people", "leadership", { synonyms: ["people value", "seats", "staffing"] }),
  T("leadership.risks", "Risks", "/leadership?tab=risks", "leadership", { synonyms: ["risk", "attention"] }),

  // Finance.
  T("finance.overview", "Overview", "/finance", "finance", { path: ["Finance", "Overview"] }),
  T("finance.in", "Money in", "/finance?tab=revenue", "finance", { synonyms: ["collections", "revenue", "receivables", "income"] }),
  T("finance.out", "Money out", "/finance?tab=subscriptions", "finance", { synonyms: ["vendors", "renewals", "subscriptions", "expenses", "vendors & renewals"] }),
  T("finance.cash", "Cash", "/finance?tab=reconcile", "finance", { synonyms: ["reconcile", "reconciliation", "bank"] }),
  T("finance.close", "Month close", "/finance?tab=close", "finance", { synonyms: ["close the month", "certify"] }),
  // COMP-B: people cost: payroll status, the running budget, runway and what-if scenarios (founders and HR).
  P("finance.people", "People cost", "/finance/people-cost", "hr", { parent: "finance", path: ["Finance", "People cost"],
    synonyms: ["people budget", "salary budget", "headcount budget", "budget vs actual", "runway", "burn", "what if", "scenario", "hiring plan", "people ledger"] }),
  P("finance.desk", "CA desk", "/finance/desk", "admin", { parent: "finance", path: ["Finance", "CA desk"], synonyms: ["bank statements", "accountant", "ca", "statements", "upload statements"], module: "money" }),

  // Billing (ERP until 18 Oct 2026; the addresses stay under /erp).
  P("erp.new", "New invoice", "/erp/new", "admin", { parent: "erp", path: ["Billing", "New invoice"], synonyms: ["make an invoice", "create invoice", "bill", "new quotation", "quote"], module: "money" }),
  P("erp.catalog", "Catalogue", "/erp/catalog", "admin", { parent: "erp", path: ["Billing", "Catalogue"], synonyms: ["catalog", "products and services", "price list", "services", "packages"], module: "money" }),
  P("erp.templates", "Invoice templates", "/erp/templates", "admin", { parent: "erp", path: ["Billing", "Templates"], synonyms: ["templates", "invoice design", "quotation design"], module: "money" }),
  P("erp.settings", "Billing settings", "/erp/settings", "admin", { parent: "erp", path: ["Billing", "Settings"], synonyms: ["erp settings", "gst", "invoice numbering", "tax"], module: "money" }),

  // Processes (FLOW-B: the old SOPs, workflows and boards; the ids stay so saved links and tasks keep working).
  P("sops.workflows", "Live processes", "/processes?show=live", "work", { parent: "sops", path: ["Processes", "Live"], synonyms: ["workflows", "flows", "live workflows"] }),
  P("sops.forms", "Field forms", "/sops/forms", "work", { parent: "sops", path: ["Processes", "Forms"], synonyms: ["forms", "site forms", "checklists"] }),
  P("sops.runs", "Runs", "/runs", "work", { path: ["Runs"], synonyms: ["workflow runs", "in progress", "projects in a process"] }),
  P("sops.drive", "Import from Drive", "/sops/drive", "admin", { parent: "sops", path: ["Processes", "Import from Drive"], synonyms: ["sops from drive", "bring in sops", "import sop"] }),
  P("me.steps", "My steps", "/me/steps", "all", { parent: "me", path: ["My desk", "My steps"], synonyms: ["waiting for you", "my workflow steps", "steps for me", "process steps"] }),

  // Settings.
  // VISIBLE: the apps Pulse connects to (Sales X-Ray, Gmail, webhooks), named as people look for them.
  T("settings.apps", "Connected apps", "/settings?tab=apps", "settings", { synonyms: ["apps", "integrations", "connect an app", "sales x-ray connection", "webhooks"] }),
  T("settings.devices", "Devices", "/settings?tab=devices", "settings", { synonyms: ["phone app", "desktop app", "this phone", "notifications on phone"] }),
  T("settings.sign-in", "Who can sign in", "/settings?tab=sign-in", "settings", { synonyms: ["sign in", "logins", "passwords", "access"] }),
  T("settings.work-rules", "Who can do what", "/settings?tab=work-rules", "settings", { synonyms: ["work rules", "reviews and value", "review policy", "permissions for work"] }),
  S("settings.work-rules.reviews", "Reviews and value", "/settings?tab=work-rules", "settings.work-rules", { synonyms: ["review policy", "who reviews", "rating", "auto done", "finish by itself", "nudge reviewers"], coach: "How reviews, value and finishing by itself work here" }),
  T("settings.team", "Team & pods", "/settings?tab=team", "settings", { synonyms: ["pods", "reporting lines", "team setup"] }),
  T("settings.roles", "Roles & permissions", "/settings?tab=roles", "settings", { synonyms: ["roles", "permissions", "admin rights"] }),
  T("settings.organisation", "Organisation", "/settings?tab=organisation", "settings", { synonyms: ["company", "company details", "logo", "brand", "time zone", "organization"] }),
  C("settings.organisation.logo", "Company logo", "/settings?tab=organisation", "settings.organisation", { synonyms: ["logo", "upload logo", "brand logo", "dark logo"], coach: "Upload the logo here" }),
  T("settings.connected", "Connected accounts", "/settings?tab=connected", "settings", { synonyms: ["google", "drive", "integrations", "connections"] }),
  P("companies", "Companies", "/companies", "admin", { parent: "settings", path: ["Settings", "Companies"], synonyms: ["second company", "new company", "tenants"] }),
];

/** The parent's path plus this label, unless an entry says otherwise. */
function withPaths(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const pathOf = (e) => e.path ?? (e.parent && byId.get(e.parent) ? [...pathOf(byId.get(e.parent)), e.label] : [e.label]);
  const accessOf = (e) => e.access ?? (e.parent && byId.get(e.parent) ? accessOf(byId.get(e.parent)) : "all");
  const moduleOf = (e) => e.module ?? (e.parent && byId.get(e.parent) ? moduleOf(byId.get(e.parent)) : undefined);
  return entries.map((e) => ({ ...e, path: pathOf(e), access: accessOf(e), ...(moduleOf(e) ? { module: moduleOf(e) } : {}) }));
}

export const DESTINATIONS = withPaths(ENTRIES);
const BY_ID = new Map(DESTINATIONS.map((d) => [d.id, d]));

export function destination(id) { return id ? BY_ID.get(id) : undefined; }

/** The anchor attribute a page puts on the element: `<section {...dest("hr.policies.presence.wifi")}>`. */
export function dest(id) { return { "data-dest": id }; }

/** The link that opens a destination and spotlights its anchor (the spotlight strips `go` again). `task` names the task
 *  the person came from, so the companion stays with them. */
export function goHref(d, task) {
  const x = typeof d === "string" ? BY_ID.get(d) : d;
  if (!x) return "/dashboard";
  const [path, query = ""] = x.href.split("?");
  const q = new URLSearchParams(query); q.set("go", x.id); if (task) q.set("task", task);
  return `${path}?${q.toString()}`;
}

/** The destination whose page and tab a URL shows (the most specific one), for marking tabs and naming pages. */
export function destForHref(href) {
  const [path, query = ""] = href.split("?"); const q = new URLSearchParams(query); q.delete("go"); q.delete("task");
  let best; let bestKeys = -1;
  for (const d of DESTINATIONS) {
    if (d.kind === "section" || d.kind === "control") continue;
    const [dp, dq = ""] = d.href.split("?"); if (dp !== path) continue;
    const want = [...new URLSearchParams(dq)];
    if (want.every(([k, v]) => q.get(k) === v) && want.length > bestKeys) { best = d; bestKeys = want.length; }
  }
  return best;
}

/** Whether a person with this role label (the shell's) can see a destination, with the company's modules. Mirrors
 *  the rail: everyone sees "all"; HR sees "hr"; admins everything; leadership and finance roles the "admin" pages. */
export function canSee(d, who) {
  if (d.module && who.modulesOff?.includes(d.module)) return false;
  const role = who.role ?? "";
  if (d.access === "all") return true;
  if (role === "Organisation owner/admin") return true;
  if (d.access === "work") return role !== "HR" && role !== "Accountant";
  // VISIBLE: "HR and leadership" (HR who also holds leadership) sees both.
  if (d.access === "hr") return role === "HR" || role === "Leadership" || role === "HR and leadership";
  return role === "Leadership" || role === "HR and leadership" || role === "Finance" || role === "Accountant";
}

// ------------------------------------------------------------------------------------------------------- matching
const STOP = new Set(["a", "an", "and", "the", "to", "of", "for", "on", "in", "with", "at", "by", "it", "is", "be", "our", "your", "add", "set", "up", "open", "go", "pulse", "please", "this", "that", "from", "into", "page", "tab"]);
export const norm = (s) => s.toLowerCase().replace(/wi[\s-]?fi/g, "wifi").replace(/check[\s-]?ins?\b/g, "checkin").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const stemWord = (w) => w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
const words = (s) => norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w)).map(stemWord);

/** Destinations named by a text, best first: a label or synonym said whole scores most, then shared words. Used for
 *  Ctrl+K and for matching a task's title. Each result names the phrase that matched. */
export function matchDestinations(text, limit = 5) {
  const t = ` ${norm(text)} `; const tw = new Set(words(text));
  if (!tw.size) return [];
  const out = [];
  for (const d of DESTINATIONS) {
    let best = 0; let matched = "";
    for (const phrase of [d.label, ...(d.synonyms ?? [])]) {
      const p = norm(phrase); if (!p) continue;
      const pw = words(phrase); if (!pw.length) continue;
      // The whole phrase in the text: strong, longer phrases stronger.
      if (t.includes(` ${p} `)) { const s = 2 + pw.length; if (s > best) { best = s; matched = phrase; } continue; }
      const shared = pw.filter((w) => tw.has(w)).length;
      if (shared && shared === pw.length) { const s = 1 + shared; if (s > best) { best = s; matched = phrase; } }
      else if (shared) { const s = shared / pw.length; if (s > best) { best = s; matched = phrase; } }
    }
    // Controls are the most exact place; pages the least.
    if (best > 0) out.push({ dest: d, score: Math.round((best + ({ control: 0.3, section: 0.2, tab: 0.1, page: 0 }[d.kind])) * 100) / 100, matched });
  }
  return out.sort((a, b) => b.score - a.score || a.dest.id.localeCompare(b.dest.id)).slice(0, limit);
}

/** "Pulse → HR → Policies → Office presence" (as people write places in notes and titles), resolved against the
 *  registry's paths: each part narrows to a child whose label or synonyms match. */
const ARROW = /\s*(?:→|->|›|»)\s*/;
export function placesIn(text) {
  const out = []; const seen = new Set ();
  const re = /(?:\bPulse\s*(?:→|->|›|»)\s*)?\b([A-Z][A-Za-z]*(?: [Dd]esk)?)((?:\s*(?:→|->|›|»)\s*[^→\n.,;:()"“”]+?)+)(?=[\n.,;:()"“”]|$)/g;
  const named = (d, part) => { const p = norm(part); return norm(d.label) === p || (d.synonyms ?? []).some((s) => norm(s) === p) || norm(d.path[d.path.length - 1] ?? "") === p; };
  const RANK = { page: 0, tab: 1, section: 2, control: 3 };
  for (const m of String(text ?? "").matchAll(re)) {
    const parts = m[2].split(ARROW).map((s) => s.trim()).filter(Boolean);
    // "Pulse → Company": the place starts after "Pulse"; a root is a top-level page, else anything named so.
    const head = m[1] === "Pulse" ? parts.shift() : m[1]; if (!head) continue;
    let at = DESTINATIONS.find((d) => !d.parent && named(d, head)) ?? [...DESTINATIONS].sort((a, b) => RANK[a.kind] - RANK[b.kind]).find((d) => named(d, head));
    if (!at) continue;
    const names = [head];
    for (const part of parts) {
      // "Office presence and test …": a place name ends where ordinary words begin, so try the longest known prefix.
      const tokens = part.split(/\s+/); let next; let used = "";
      for (let n = tokens.length; n > 0 && !next; n--) { const piece = tokens.slice(0, n).join(" "); next = DESTINATIONS.find((d) => d.parent === at.id && named(d, piece)); if (next) used = piece; }
      // An unknown part is named but not followed: the link opens as deep as Pulse knows the place.
      if (!next) { names.push(part); break; }
      names.push(used); at = next;
      if (used !== part) break;
    }
    const label = names.join(" → ");
    if (!seen.has(at.id)) { seen.add(at.id); out.push({ label, dest: at }); }
  }
  return out;
}
