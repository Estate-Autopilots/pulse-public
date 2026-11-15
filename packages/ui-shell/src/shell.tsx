"use client";

import {
  BookUser, Building2, CalendarCheck, CalendarDays, ChevronDown, CircleCheck, Network, ReceiptText, ScanSearch, ShieldCheck, Wallet, BriefcaseBusiness, TrendingUp, Ellipsis, FolderKanban, House, Map as MapIcon, MessageCircle, WifiOff,
  Building, ChartGantt, FileSignature, Gauge, Gem, GraduationCap, LayoutGrid, Lightbulb, Newspaper, Palette, PanelLeftClose, PanelLeftOpen, PlugZap, Search, ServerCog, Settings, Users, Workflow, Bug, Target, Megaphone, FileText,
  Bot, BookOpenCheck, Check, ChevronUp, Plus, Compass, Ear, Eye, EyeOff, Handshake, Mic, Pencil, PhoneCall, Quote, Rocket, RotateCcw, Sparkles, Star, Sun, Bell, LogIn, UserRound,
} from "lucide-react";
import Link from "next/link";
// SPEED-2 (15 Nov 2026): a menu link fetches its whole page (data too) on hover or touch, so the click shows it at
// once (next.config: experimental.dynamicOnHover). The app-router Link reads unstable_dynamicOnHover, but next/link's
// public types do not list it yet, so it is passed as a spread that adds no typed props. It goes after a link's key: a
// key after a spread turns the JSX into createElement, and Link then warns about its children's keys.
const HOVER_FULL = { unstable_dynamicOnHover: true } as object;
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useBackLayer } from "./back-layer";
import { mobileTabs } from "./mobile-tabs";
import { NewDot, useNewDots } from "./new-dot";
import { dotTip, entryCount, entryIsNew, entryNotes, NEW_LABEL, subIsNew } from "./new-dots";
import { pathSwitchedOff } from "./modules";
import { AppsLauncher, type LauncherGroup } from "./apps-launcher";
import { ABOUT, NAV_GROUPS, NAV_PREFS_KEY, groupOpen, groupOrder, hiddenOf, moveGroup, pinsOf, prefsFrom, toggleHidden, togglePin, type NavGroupKey, type NavPrefs } from "./nav-catalog";
import navCss from "./nav.module.css";
import { BRAND, MARK } from "../../design-system/src/brand.js";
import { NoticeCenter } from "./notice-center";
import { installMenuKeys } from "./menu-keys";
import { ProfileMenu } from "./profile-menu";
import { clearRecents, recentAge, recentIcon, useRecents } from "./recents";
import styles from "./shell.module.css";
import { SidebarTooltip } from "./sidebar-tooltip";
import { ThemeProvider } from "./theme-provider";
import type { PulseIdentity, PulseOrg, PulseOrgs, PulseProduct, PulseWorkspace } from "./types";
import { OrgTile, WorkspaceSwitcher } from "./workspace-switcher";

type Page = Readonly<{ label: string; short?: string; href: string; Icon: typeof House; group: NavGroupKey; also?: readonly string[]; blurb?: string; words?: readonly string[]; sub?: string; access: "all" | "work" | "hr" | "admin"; cluster?: SettingsCluster }>;
/** VISUAL-QA (owner, 10 Nov 2026: "the Settings group mixes personal items with admin tools"): the Settings group's rows
 *  sit under three captions, in this order. */
type SettingsCluster = "you" | "company" | "admin";
const CLUSTERS: readonly (readonly [SettingsCluster, string])[] = [["you", "You"], ["company", "Company"], ["admin", "Admin tools"]];
/** IA-NAV (owner, 10 Nov 2026): every page, grouped by what people do (nav-catalog.ts NAV_GROUPS). The rail shows one icon
 *  per group, the sidebar the same groups (folding), All apps every page with a short line; Ctrl+K reads the same list.
 *  An entry's href may carry a query (Quotes, Connect your AI): it is a way in, never the page the top bar names. */
const allPages: readonly Page[] = [
  // Home: the day and what changed.
  { label: "Dashboard", short: "Home", href: "/dashboard", Icon: House, group: "home", access: "all" },
  // CLIENT-PORTAL: a client's own home (the app removes it for everyone else).
  { label: "Home", href: "/client", Icon: House, group: "home", access: "all" },
  { label: "My day", href: "/my-day", Icon: Sun, group: "home", access: "work" },
  // CALENDAR-HUB (owner, 13 Nov 2026, P2.1 T2.1.4 "a calendar somewhere in the home, accessible"): the one calendar for
  // everything (meetings, tasks due, milestones, posts, leave, your events and your Google Calendar), at the top of the rail.
  { label: "Calendar", href: "/calendar", Icon: CalendarDays, group: "home", access: "all" },
  // GAP-FOUNDER-VIEW: every company the person runs on one screen; only in their own workspace, when they run two or
  // more (lib/nav.ts).
  { label: "All my companies", short: "Companies", href: "/founder", Icon: Building, group: "home", access: "admin" },
  { label: "Updates", href: "/updates", Icon: Newspaper, group: "home", access: "all" },
  { label: "What's new", href: "/whats-new", Icon: Sparkles, group: "home", access: "all" },
  // XRAY-LINK: tutorials and videos for every part of Pulse.
  { label: "Learn Pulse", short: "Learn", href: "/learn", Icon: GraduationCap, group: "home", access: "all" },
  // PULSE-HQ: every organisation reads what Pulse can do (the catalogue the Pulse organisation keeps). VISUAL-QA: beside
  // Learn Pulse (it is about Pulse, not a company setting or an admin tool).
  { label: "What Pulse can do", short: "Features", href: "/features", Icon: Lightbulb, group: "home", access: "all" },
  // Work: the company's own projects, the fulfilment of client packages, and every task (UX-TASKS).
  { label: "Tasks", short: "Work", href: "/tasks", Icon: CircleCheck, group: "work", also: ["/my-week", "/delivery", "/portal"], access: "work" },
  // DOCS-WORKBENCH (owner, 6 Nov 2026): the company's docs and files (editor, folders, mentions, history).
  { label: "Docs", href: "/docs", Icon: FileText, group: "work", access: "work" },
  // FLOW-B (21 Oct 2026): Processes (each one's write-up, steps and runs) and Runs (every project going through one).
  { label: "Processes", href: "/processes", Icon: Workflow, group: "work", also: ["/sops"], access: "work" },
  { label: "Runs", href: "/runs", Icon: ChartGantt, group: "work", access: "work" },
  { label: "Meetings", href: "/meetings", Icon: Mic, group: "work", access: "work" },
  // EST-1474: the Creative Strategy app (CS Home and sprints); its module is off unless the server switches it on.
  { label: "Creative Strategy", short: "Creative", href: "/creative", Icon: Lightbulb, group: "work", access: "work" },
  // VISIBLE (owner, 25 Oct 2026): the product map on leaders' rails too.
  { label: "Product map", href: "/product-map", Icon: Workflow, group: "work", access: "admin" },
  // Chat.
  { label: "Chats", href: "/chats", Icon: MessageCircle, group: "chat", also: ["/communication", "/inbox", "/groups"], access: "all" },
  { label: "Calls", href: "/calls", Icon: PhoneCall, group: "chat", access: "all" },
  // Sales & clients. KAZUK-FLOW: a salesperson's own home (lib/nav.ts shows it to sales seats).
  { label: "My sales", href: "/sales", Icon: Target, group: "sales", access: "work" },
  { label: "Leads", href: "/acquisition", Icon: TrendingUp, group: "sales", access: "work" },
  { label: "Clients", href: "/clients", Icon: Building2, group: "sales", also: ["/projects", "/stewardship/client", "/stewardship/project", "/deliveries", "/appointments"], access: "work" },
  { label: "Contacts", href: "/contacts", Icon: BookUser, group: "sales", also: ["/stewardship/contact", "/relationships"], access: "work" },
  // Billing's quotations (WL-QUOTE-FLOW): the roles that have Billing.
  { label: "Quotes", href: "/erp/documents?view=quotation", Icon: Quote, group: "sales", access: "admin" },
  // CONTRACTS-2 (8 Nov 2026): Agreements (admins, leadership and Finance; Sales see their own).
  { label: "Agreements", href: "/contracts", Icon: FileSignature, group: "sales", access: "admin" },
  { label: "Map", href: "/map", Icon: MapIcon, group: "sales", access: "work" },
  // WA-NATIVE (25 Oct 2026): Insights → Client operations, what the company's WhatsApp groups say (leadership and admins).
  { label: "Insights", href: "/insights", Icon: Lightbulb, group: "sales", access: "admin" },
  // EST-1363: the Sales X-Ray app; its module switch (PULSE_SALES_XRAY) hides it where it is off.
  { label: "Sales X-Ray", short: "X-Ray", href: "/apps/sales-xray", Icon: PlugZap, group: "sales", access: "all" },
  // Money. BILLING (18 Oct 2026): called Billing; the address stays /erp.
  { label: "Billing", href: "/erp", Icon: ReceiptText, group: "money", access: "admin" },
  { label: "Finance", href: "/finance", Icon: Wallet, group: "money", access: "admin" },
  // FOUNDATIONS / GOALS-2: long-term goals for the company, its teams and its people.
  { label: "Goals", href: "/goals", Icon: Target, group: "money", access: "work" },
  // FOCUS (owner, 7 Nov 2026): the funding list, an organisation-only module (the Vitals organisation).
  { label: "Funding", href: "/funding", Icon: Wallet, group: "money", access: "admin" },
  // People.
  { label: "Team", href: "/people", Icon: Users, group: "people", also: ["/activity", "/stewardship/person", "/designers"], access: "all" },
  { label: "My desk", short: "Me", href: "/me", Icon: CalendarCheck, group: "people", also: ["/attendance", "/leave", "/notifications", "/welcome", "/agreements"], access: "all" },
  { label: "HR desk", short: "HR", href: "/hr", Icon: BriefcaseBusiness, group: "people", also: ["/hr-history", "/shifts"], access: "hr" },
  { label: "Leadership", short: "Lead", href: "/leadership", Icon: TrendingUp, group: "people", also: ["/pod", "/pods"], access: "admin" },
  // Growth. PR-STUDIO-2: a brand's posts from strategy to insights (admins and leadership: lib/nav.ts; pulse.pr_can()).
  { label: "PR Studio", short: "PR", href: "/pr", Icon: Megaphone, group: "growth", access: "work" },
  // COMPANY-SEARCH (8 Nov 2026): every company on Vitals and the people who chose "Let people find me".
  { label: "Find companies", href: "/directory", Icon: Compass, group: "growth", access: "all" },
  // PULSE-NETWORK (EST-1026): leaders only, and only where the company's connector is set up (lib/nav.ts).
  { label: "Network", href: "/network", Icon: Network, group: "growth", access: "admin" },
  // PULSE-HQ (owner, 23 Oct 2026): an organisation-only module, on only in the Pulse organisation.
  { label: "Pulse HQ", short: "HQ", href: "/hq", Icon: Gem, group: "growth", access: "work" },
  // CASE-STUDIES (owner, 10 Nov 2026): the 45-day journey with partner businesses, organisation-only (the Vitals organisation).
  { label: "Case studies", short: "Cases", href: "/case-studies", Icon: BookOpenCheck, group: "growth", access: "admin" },
  // AI. AI-EMP-2: what each AI employee did (admins and leaders: lib/nav.ts); AI-CONNECT; AGENT-CHANNELS' listening.
  // FIX-AI-EMPLOYEES (10 Nov 2026): the page is "Autopilots · your AI employees"; the menu says the same.
  { label: "Autopilots", short: "AI", href: "/people/ai", Icon: Bot, group: "ai", access: "work" },
  { label: "Connect your AI", href: "/settings?tab=connect-ai", Icon: PlugZap, group: "ai", access: "all" },
  { label: "Listen", href: "/listen", Icon: Ear, group: "ai", access: "work" },
  // FOCUS: the owner's AI capacity and today's plan (organisation-only: his own workspace).
  { label: "Focus", href: "/focus", Icon: Gauge, group: "ai", access: "admin" },
  // Settings' own pages (admins; HR keeps Review data in People).
  { label: "Review data", short: "Review", href: "/review-data", Icon: ScanSearch, group: "settings", also: ["/opshub"], cluster: "company", access: "hr" },
  { label: "Audit", href: "/audit", Icon: ShieldCheck, group: "settings", cluster: "admin", access: "admin" },
  // TELEMETRY (owner, 24 Oct 2026): where Pulse is slow: pages, clicks, API routes, errors, people, sessions, versions.
  { label: "Telemetry", href: "/telemetry", Icon: Gauge, group: "settings", cluster: "admin", access: "admin" },
  // PULSE-ADMIN (owner, 27 Oct 2026): Pulse's back office, for its platform admins only (lib/nav.ts).
  { label: "Admin console", short: "Admin", href: "/admin", Icon: ServerCog, group: "settings", cluster: "admin", access: "admin" },
  // BUG-REPORT (owner, 27 Oct 2026): what people reported with Ctrl+B, a shake or the account menu; triage for leaders.
  { label: "Bug reports", short: "Bugs", href: "/bug-reports", Icon: Bug, group: "settings", cluster: "admin", access: "admin" },
];
const SETTINGS: Page = { label: "Settings", href: "/settings", Icon: Settings, group: "settings", also: ["/companies"], cluster: "you", access: "all" };
/** VISUAL-QA: the Settings sections people open most are rows of the Settings group (not only places under Settings
 *  once on it), each under its caption: your own, then the company's. Which ones a role sees is SUBPLACES["/settings"]. */
/** VISUAL-QA: pages reached from the account menu that are a sidebar row's own page. */
const LIGHTS: Readonly<Record<string, string>> = { "/account": "/settings?tab=account" };
const SETTINGS_ROWS: Readonly<Record<string, readonly [typeof House, SettingsCluster]>> = {
  "/settings?tab=account": [UserRound, "you"], "/settings?tab=notifications": [Bell, "you"],
  "/settings?tab=organisation": [Building2, "company"], "/settings?tab=sign-in": [LogIn, "company"], "/settings?tab=work-rules": [ShieldCheck, "company"],
};
const GROUP_ICON: Readonly<Record<NavGroupKey, typeof House>> = { home: House, work: CircleCheck, chat: MessageCircle, sales: Handshake, money: Wallet, people: Users, growth: Rocket, ai: Bot, settings: Settings };
type Group = Readonly<{ key: NavGroupKey; label: string; short?: string; blurb: string; Icon: typeof House; items: readonly Page[] }>;
/** The role's groups in the person's order, each with its pages in the list's order; a group without pages is left out.
 *  The Settings group starts with Settings itself. */
function groupsFor(pages: readonly Page[], order: readonly NavGroupKey[], settings: Page | null, settingsRows: readonly Page[] = []): Group[] {
  const rank = (p: Page) => { const i = CLUSTERS.findIndex(([c]) => c === p.cluster); return i < 0 ? CLUSTERS.length : i; };
  return order.map((key) => { const g = NAV_GROUPS.find((x) => x.key === key)!; const items = pages.filter((p) => p.group === key);
    // VISUAL-QA: the Settings group in caption order (You, Company, Admin tools); a stable sort keeps the list's order inside each.
    // VISUAL-QA: inside the Settings group its first row says "All settings" (the group and the row both said Settings).
    const list = key === "settings" && settings ? [{ ...settings, label: settings.href === SETTINGS.href ? "All settings" : settings.label }, ...settingsRows, ...items].map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p) : items;
    return { key, label: g.label, short: "short" in g ? g.short : undefined, blurb: g.blurb, Icon: GROUP_ICON[key], items: list }; })
    .filter((g) => g.items.length > 0);
}
const withAbout = (page: Page): Page => ABOUT[page.href] ? { ...page, blurb: page.blurb ?? ABOUT[page.href].blurb, words: page.words ?? ABOUT[page.href].words } : page;
/** Sections whose sub-pages carry their own title in the top bar (the rest keep the section's). */
// HR-PEOPLE: Team's sub-pages (People & pay, Org chart, Agreements) name the top bar too.
const OWN_TITLES = new Set(["/me", "/tasks", "/people"]);
/** The places inside a page (its tabs and sub-pages), listed under it in the panel so every feature is one click from its
 *  section. `lead`: leadership, HR and admins only; `"leaders"`: admins and leadership only (not HR on its own);
 *  `"admin"`: organisation admins only; `"people"`: admins and HR (who runs sign-in). */
type SubPlace = Readonly<{ label: string; href: string; lead?: boolean | "leaders" | "admin" | "people" }>;
const SUBPLACES: Readonly<Record<string, readonly SubPlace[]>> = {
  "/hq": [{ label: "Feature catalogue", href: "/hq/features" }, { label: "Investor numbers", href: "/hq/investors" }, { label: "Licences", href: "/hq/licences" }, { label: "Offer Studio", href: "/hq/offers" }, { label: "Ideas", href: "/hq/ideas" }, { label: "Brand", href: "/hq/brand" }, { label: "Stack Intelligence", href: "/stack" }, { label: "Product map", href: "/product-map" }],
  // IA-NAV: What's new and Learn Pulse are Home's own entries now; My day too.
  // UX-SIMPLE (28 Oct 2026): Work's own places; the team dashboard, outcomes and reviews are in Work → More.
  "/tasks": [{ label: "Projects", href: "/tasks?view=projects" }, { label: "People", href: "/tasks?view=people", lead: true }, { label: "My steps", href: "/me/steps" }, { label: "My week", href: "/my-week" },
    { label: "Dependency map", href: "/tasks/map" }, { label: "Finished per week", href: "/tasks/outcomes", lead: true }, { label: "Tidy up", href: "/tasks/merge", lead: true }],
  // IA-NAV: the places inside Processes, Runs, Meetings, Learn, PR Studio and AI employees (they had no way in but a link).
  "/processes": [{ label: "Libraries", href: "/processes/libraries" }, { label: "Field forms", href: "/sops/forms" }, { label: "Import from Drive", href: "/sops/drive", lead: "admin" }],
  "/runs": [{ label: "Capacity", href: "/runs/capacity" }, { label: "Scorecard", href: "/runs/scorecard" }],
  // MEETING-CAPTURE: the three ways in (one capture engine: the meeting record).
  "/meetings": [{ label: "Add a transcript", href: "/meetings/new?mode=paste" }, { label: "Record a meeting", href: "/meetings/new?mode=record" }, { label: "Narrate a problem", href: "/meetings/new?mode=problem" }],
  "/learn": [{ label: "My training", href: "/learn/training" }, { label: "Manage training", href: "/learn/training/manage", lead: "people" }],
  "/pr": [{ label: "More PR tools", href: "/pr/more" }],
  "/people/ai": [{ label: "Tasks and cost", href: "/people/ai/tasks" }],
  "/contracts": [{ label: "New agreement", href: "/contracts/new" }, { label: "Templates", href: "/contracts/templates" }, { label: "What clients change", href: "/contracts/insights", lead: "leaders" }], // CONTRACTS-3: admins and leadership (Finance opens it from Templates)
  "/contacts": [{ label: "Contact identities", href: "/contacts/identity" }, { label: "Models", href: "/contacts/models" }],
  // SETTINGS-APPLE (T1.3.3): no sub-item under Review data: WhatsApp names are a type (a chip) of its one queue, not a
  // page or a menu entry of their own ("WhatsApp names is not a category to be listed").
  "/bug-reports": [{ label: "Bug and feature board", href: "/bug-reports/board" }, { label: "From other companies", href: "/bug-reports/dev" }],
  // VISIBLE: the groups hub and its views (each person sees the groups they are in; leaders see every group's facts).
  "/chats": [{ label: "All groups", href: "/chats/groups" }, { label: "Client groups", href: "/chats/groups?kinds=client" }, { label: "Waiting on us", href: "/chats/groups?quick=waiting&sort=waiting" },
    { label: "WhatsApp signals", href: "/chats/whatsapp/signals", lead: "leaders" }, { label: "Import WhatsApp history", href: "/chats/import", lead: "leaders" },
    { label: "Groups from WhatsApp", href: "/chats/whatsapp", lead: "leaders" }, { label: "Check voice-note transcripts", href: "/chats/whatsapp/review", lead: "leaders" }],
  // SELF-SERVE (1520): a professional's appointments with clients, and adding a client with their one-click link.
  "/clients": [{ label: "Appointments", href: "/appointments" }, { label: "Add and invite", href: "/clients/add", lead: true }, { label: "Client projects", href: "/projects" }, { label: "Deliveries", href: "/delivery" }, { label: "Client access", href: "/delivery/access", lead: true }, { label: "Project support", href: "/delivery/support" }, { label: "Relationships", href: "/relationships" }, { label: "Pulse access", href: "/clients?tab=access", lead: true }],
  "/insights": [{ label: "Client operations", href: "/insights" }, { label: "Where it goes wrong", href: "/insights?tab=wrong" }, { label: "WhatsApp signals", href: "/chats/whatsapp/signals" }],
  "/people": [{ label: "Org chart", href: "/people/org" }, { label: "Designers", href: "/designers" }, { label: "Hiring", href: "/people/jobs" }, { label: "Skills", href: "/people/skills" }, { label: "People & pay", href: "/people/pay", lead: true }, { label: "Agreements", href: "/people/agreements", lead: true }, { label: "Add people", href: "/people?add=people", lead: true }, { label: "Who can do what", href: "/people/access", lead: "admin" }],
  "/me": [{ label: "My steps", href: "/me/steps" }, { label: "My work", href: "/me/work" }, { label: "Approvals", href: "/me/approvals" }, { label: "My pay", href: "/me/pay" }, { label: "Leave cover", href: "/cover" }, { label: "Agreements", href: "/agreements" }, { label: "My profile", href: "/me/profile" }, { label: "Notifications", href: "/notifications" }],
  "/admin": [{ label: "Organisations", href: "/admin?tab=orgs" }, { label: "People", href: "/admin?tab=people" }, { label: "Usage", href: "/admin?tab=usage" },
    { label: "Audit log", href: "/admin?tab=audit" }, { label: "System health", href: "/admin?tab=health" }, { label: "Announcements", href: "/admin?tab=announcements" },
    { label: "Bug reports", href: "/admin?tab=bugs" }, { label: "Set up a company", href: "/companies" }],
  "/hr": [{ label: "Shifts", href: "/shifts" }, { label: "HR history", href: "/hr-history" }, { label: "HR flow help", href: "/hr/help" }],
  // FIX-PEOPLE-MONEY C4 (owner, 10 Nov 2026: "People cost doesn't need its own page"): people cost is a line of Finance
  // Overview's profit and loss; its what-if stays one click away in Finance's More menu.
  "/finance": [{ label: "CA check", href: "/finance/desk" }],
  "/erp": [{ label: "Documents", href: "/erp/documents" }, { label: "Catalogue", href: "/erp/catalog" }, { label: "Stock", href: "/erp/inventory" }, { label: "Templates", href: "/erp/templates" },
    { label: "Rate cards", href: "/erp/rate-cards" }, { label: "Billing log", href: "/erp/log" }, { label: "Import statement", href: "/money" }],
  // UX-SIMPLE (28 Oct 2026): five at most; the rest (sign-in, roles, apps, data health, desktop build, brand) are the
  // Settings page's own tabs, one click away.
  // UX-SETTINGS-CHAT (owner, 5 Nov 2026): the Settings home lists every section; here the ones people open most, each
  // only for the roles that can open it (leadership's "Organisation" and "Team" opened their own preferences instead).
  "/settings": [{ label: "Your account", href: "/settings?tab=account" }, { label: "Notifications", href: "/settings?tab=notifications" },
    { label: "Company", href: "/settings?tab=organisation", lead: "admin" }, { label: "Who can sign in", href: "/settings?tab=sign-in", lead: "people" }, { label: "Who can do what", href: "/settings?tab=work-rules" }],
};
const LEAD_ROLES = new Set(["Organisation owner/admin", "Leadership", "HR", "HR and leadership"]);
const LEADERS = new Set(["Organisation owner/admin", "Leadership", "HR and leadership"]);
const PEOPLE_DESK = new Set(["Organisation owner/admin", "HR", "HR and leadership"]);
const subFor = (sub: SubPlace, roleLabel: string) => !sub.lead || (sub.lead === "admin" ? roleLabel === "Organisation owner/admin" : (sub.lead === "people" ? PEOPLE_DESK : sub.lead === "leaders" ? LEADERS : LEAD_ROLES).has(roleLabel));
/** The sub-places a role may open under a page (role rules, switched-off modules, entries the app removed). */
function subsOf(href: string, roleLabel: string, modulesOff: readonly string[] | undefined, removedBases: readonly string[]) {
  const under = (h: string, base: string) => { const p = h.split(/[?#]/)[0]; return p === base || p.startsWith(base + "/"); };
  return (SUBPLACES[href] ?? []).filter((sub) => subFor(sub, roleLabel) && !pathSwitchedOff(sub.href, modulesOff) && !removedBases.some((base) => under(sub.href, base)));
}
/** Places the search palette finds by name that are tabs of a page rather than rail entries. */
const PLACES: readonly Page[] = [
  { label: "Account", href: "/account", Icon: ShieldCheck, group: "settings", access: "all" },
  { label: "Client projects", href: "/projects", Icon: FolderKanban, group: "work", access: "work" },
  { label: "Work projects", href: "/tasks?view=projects", Icon: FolderKanban, group: "work", access: "work" },
  { label: "Team dashboard", href: "/tasks?view=team", Icon: CircleCheck, group: "work", access: "work" },
  // R46: RE projects, clients, developers, channel partners, employees and contacts, and who confirmed which link.
  { label: "Relationships", href: "/relationships", Icon: BookUser, group: "work", access: "work" },
  { label: "Who can do what", href: "/settings?tab=work-rules", Icon: Settings, group: "settings", access: "all" },
  { label: "Brand: logo, Pip and app icons", short: "Brand", href: "/brand", Icon: Palette, group: "settings", access: "all" },
  { label: "Stack Intelligence: tools, costs and stacks", short: "Stack", href: "/stack", Icon: Gem, group: "work", access: "all" },
  { label: "Product map: screens, user types and journeys of an app", short: "Product map", href: "/product-map", Icon: Workflow, group: "work", access: "all" },
  // IA-NAV: a person's own career pages (the organisation menu's account side) and Stack Intelligence's directory.
  { label: "My career", href: "/orgs/career", Icon: GraduationCap, group: "settings", access: "all" },
  { label: "My resume", short: "Resume", href: "/orgs/resume", Icon: FileText, group: "settings", access: "all" },
  { label: "My licences", short: "Licences", href: "/orgs/licences", Icon: ShieldCheck, group: "settings", access: "all" },
  { label: "Stack directory", href: "/stack/directory", Icon: Gem, group: "work", access: "all" },
  { label: "Product Story", short: "Story", href: "/story", Icon: Lightbulb, group: "home", access: "all" },
];

/** EST-1205: pages reached from a menu or a link, not from the rail. The top bar names them, instead of falling back to
 *  "Dashboard" (and marking it current). */
const ELSEWHERE: readonly Page[] = [
  { label: "Connect a Pulse app", href: "/connect", Icon: Settings, group: "settings", access: "all" },
  // E2E-4P: these pages are reached from the organisation menu, not the rail; without them the title said "Dashboard".
  { label: "Connections", href: "/connections", Icon: Building2, group: "work", access: "all" },
  // GAP-FOUNDER-VIEW: the account's own profile (from the organisation menu) is named in the top bar, not "Organisations"
  // (it comes before /orgs: the first entry the address is under wins).
  { label: "Your profile", href: "/profile", Icon: UserRound, group: "settings", access: "all" },
  { label: "Organisations", href: "/orgs", Icon: Building2, group: "settings", access: "all" },
  { label: "Account / Security", short: "Account", href: "/account", Icon: ShieldCheck, group: "settings", access: "all" },
  { label: "Install Pulse", href: "/apps", Icon: Settings, group: "settings", access: "all" },
  { label: "Your role briefs", short: "Role briefs", href: "/briefs", Icon: BookUser, group: "work", access: "all" },
  { label: "Pulse controls", short: "Controls", href: "/kit", Icon: Palette, group: "settings", access: "all" },
  // PULSE-HQ (0973): Stack Intelligence, for every organisation (Pulse HQ links it; the palette finds it by name).
  { label: "Stack Intelligence", short: "Stack", href: "/stack", Icon: Gem, group: "work", access: "all" },
  // MODULES-1024: these too said "Dashboard" in the top bar above their own title.
  { label: "Calls", href: "/calls", Icon: MessageCircle, group: "work", access: "all" },
  { label: "Product Story", short: "Story", href: "/story", Icon: Lightbulb, group: "work", access: "all" },
  // PRODUCT-MAP (1010): every organisation building software; reached from Product Story, Pulse HQ and the palette.
  { label: "Product map", short: "Map", href: "/product-map", Icon: Workflow, group: "work", access: "all" },
  { label: "My steps", short: "Step", href: "/steps", Icon: CircleCheck, group: "work", access: "all" },
  { label: "Quotation", href: "/quotes", Icon: ReceiptText, group: "money", access: "all" },
  { label: "Not available", href: "/hidden", Icon: ShieldCheck, group: "settings", access: "all" },
  { label: "Learn Pulse", short: "Learn", href: "/learn", Icon: GraduationCap, group: "work", access: "all" },
  // BUG-REPORT: everyone reaches their own reports from the reporter.
  { label: "Your bug reports", short: "Bugs", href: "/bug-reports", Icon: Bug, group: "settings", access: "all" },
];

/** FIX-SHELL (owner, 10 Nov 2026: "I can't reach Funding from Estate Autopilots; make Focus/Funding reachable from any
 *  org, never a dead page"): these organisation-only pages, when off here, link to the person's company that has them
 *  (/@handle/funding switches company first). Product map and Pulse HQ stay out of other companies' menus. */
const ACROSS: Readonly<Record<string, string>> = { "/focus": "focus", "/funding": "funding" };
/** The role's pages without those whose module the organisation has switched off (Focus and Funding link across). */
function pagesFor(roleLabel: string | undefined, modulesOff: readonly string[] = [], orgs?: PulseOrgs) {
  return pagesForRole(roleLabel).flatMap((page): Page[] => {
    if (!pathSwitchedOff(page.href, modulesOff)) return [page];
    const key = ACROSS[page.href];
    const there = key ? orgs?.list.find((o) => !o.current && !!o.handle && o.orgOnly?.includes(key)) : undefined;
    // SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2): Focus opens in place, on this company's part (no company switch).
    if (there && key === "focus") return [{ ...page, blurb: "Your AI work for this company" }];
    return there ? [{ ...page, href: `/@${there.handle}${page.href}`, blurb: `Opens in ${there.name}`, words: ABOUT[page.href]?.words }] : [];
  });
}

const HR_PAGES = ["/dashboard", "/tasks", "/chats", "/hr", "/me", "/people", "/review-data", "/updates"];
/** HR's rail also has Home's What's new and Learn Pulse (every seat reads them). */
const HR_ALSO = ["/whats-new", "/learn"];
const QUOTES = "/erp/documents?view=quotation";
// SETTINGS-APPLE (T1.3.4): Admin console too; the menu keeps it only for Pulse's platform admins (lib/nav.ts platformOff).
const leadershipPage = (page: Page) => ["/network", "/finance", "/erp", QUOTES, "/contracts", "/leadership", "/insights", "/hr", "/product-map", "/admin"].includes(page.href) || page.access === "all" || page.access === "work";
function pagesForRole(roleLabel: string | undefined) {
  if (roleLabel === 'Accountant') return allPages.filter(page => page.href === '/finance' || page.href === '/erp').map(page => page.href === '/finance' ? {...page, href: '/finance/desk'} : page);
  if (roleLabel === "Leadership") return allPages.filter(leadershipPage);
  // VISIBLE: HR who also holds leadership: leadership's pages and HR's own (Review data), in the rail's order.
  if (roleLabel === "HR and leadership") return allPages.filter((page) => leadershipPage(page) || HR_PAGES.includes(page.href));
  if (roleLabel === "Finance") return allPages.filter((page) => page.href === "/erp" || page.href === QUOTES || page.href === "/contracts" || (page.access !== "admin" && page.access !== "hr"));
  // KAZUK-FLOW (1670): a salesperson's seat is a member's pages plus Billing (their own deals).
  // CONTRACTS-2: and Agreements (the ones made from their own quotations; pulse.contract_seller decides).
  if (roleLabel === "Sales") return allPages.filter((page) => page.href === "/erp" || page.href === QUOTES || page.href === "/contracts" || (page.access !== "admin" && page.access !== "hr"));
  // HR is staff too (its own day, chats, the team) and works from the HR desk (a phone tab); never clients, money or admin.
  if (roleLabel === "HR") return [...HR_PAGES, ...HR_ALSO].flatMap((href) => allPages.filter((page) => page.href === href));
  if (roleLabel === "Organisation owner/admin") return allPages;
  return allPages.filter((page) => page.access !== "admin" && page.access !== "hr");
}

/** UX-TASKS-2: the company's words for clients and what it sells (a product company's Customers and Releases); a null
 *  hides the entry (an internal team has no clients). Keyed by href. */
export type ShellRename = Readonly<Record<string, string | null>>;
function renamed<T extends Page>(list: readonly T[], rename?: ShellRename): T[] {
  return rename ? list.flatMap((page) => rename[page.href] === null ? [] : [rename[page.href] ? { ...page, label: rename[page.href]!, short: undefined } : page]) : [...list];
}
function currentPage(pathname: string | null, pages: readonly Page[] = allPages, rename?: ShellRename) {
  const under = (base: string) => pathname === base || !!pathname?.startsWith(base + "/");
  const place = renamed(PLACES, rename).find((p) => !p.href.includes("?") && under(p.href)) ?? ELSEWHERE.find((p) => under(p.href));
  // IA-NAV: the closest entry wins (AI employees at /people/ai, not Team); an entry with a query is never the page.
  const best = (list: readonly Page[]) => list.filter((p) => !p.href.includes("?")).map((p) => ({ p, at: Math.max(-1, ...[p.href, ...(p.also ?? [])].filter(under).map((h) => h.length)) }))
    .filter((x) => x.at >= 0).sort((a, b) => b.at - a.at)[0]?.p;
  return best(pages) ?? best(allPages) ?? (place ? { ...place, label: place.short ?? place.label } : pages[0]);
}

// The panel now carries the section's pages, so it opens by default on an ordinary laptop, not only on very wide screens.
const WIDE_SIDEBAR = "(min-width: 1280px)";

/** Pulse's mark (packages/design-system/brand): an open P holding the live point, on the iris squircle. */
function PulseMark() {
  return (
    <span aria-hidden="true" className={styles.pulseMark}>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <defs><linearGradient id="pulse-mark-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={BRAND.irisLight} /><stop offset="1" stopColor={BRAND.irisDeep} /></linearGradient></defs>
        <rect width="32" height="32" rx="9" fill="url(#pulse-mark-fill)" />
        <path d={MARK.stroke} fill="none" stroke="#fff" strokeWidth={MARK.width} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={MARK.point.cx} cy={MARK.point.cy} r={MARK.point.r} fill="#fff" />
      </svg>
    </span>
  );
}

type Hit = { key: string; group: string; label: string; sub?: string; href: string; Icon: typeof House };
type Records = { group: string; Icon: typeof House; items: { label: string; sub?: string; href: string; text: string }[] }[];
const str = (value: unknown) => typeof value === "string" ? value : "";
/** Projects, clients, contacts and people, read once when the palette first opens. Lists a person may not see are skipped. */
async function loadRecords(): Promise<Records> {
  const read = async (path: string, key: string) => {
    try { const r = await fetch(`/api/v0/${path}`); if (!r.ok) return []; const d = await r.json() as Record<string, unknown>; return Array.isArray(d[key]) ? d[key] as Record<string, unknown>[] : []; } catch { return []; }
  };
  const [projects, clients, contacts, people] = await Promise.all([read("projects", "projects"), read("clients", "clients"), read("contacts", "contacts"), read("people", "people")]);
  const make = (label: string, sub: string, href: string) => ({ label, sub: sub && sub !== label ? sub : undefined, href, text: `${label} ${sub}`.toLowerCase() });
  return [
    { group: "Client projects", Icon: FolderKanban, items: projects.map((p) => make(str(p.title) || str(p.folderName), [str(p.clientName), str(p.location)].filter(Boolean).join(" · "), `/projects/${str(p.projectId)}`)) },
    { group: "Clients", Icon: Building2, items: clients.map((c) => make(str(c.name), [str(c.companyName), str(c.city)].filter(Boolean).join(" · "), `/clients/${str(c.id)}`)) },
    { group: "Contacts", Icon: BookUser, items: contacts.map((c) => make(str(c.name), [str(c.designation), str(c.clientName) || str(c.companyName)].filter(Boolean).join(" · "), `/contacts/${str(c.id)}`)) },
    { group: "Team", Icon: Users, items: people.filter((p) => str(p.status) !== "inactive").map((p) => make(str(p.name), [str(p.role), str(p.pod)].filter(Boolean).join(" · "), `/people/${str(p.id)}`)) },
  ];
}

/** UX-5A: the role's rail pages, the places found by name and whether the role only has Finance, for an app's own
 *  search palette (the same lists the shell's palette uses). */
export type ShellNavPage = Page;
export function shellNav(roleLabel: string | undefined, modulesOff?: readonly string[], rename?: ShellRename, orgs?: PulseOrgs) {
  const pages = renamed(pagesFor(roleLabel, modulesOff, orgs), rename).map(withAbout);
  // IA-NAV: every sub-place the role may open is found by name too ("Rate cards", "More PR tools"), with its page's name.
  const removedBases = Object.entries(rename ?? {}).filter(([href, label]) => label === null && !href.includes("?")).map(([href]) => href);
  const subs = financeOnlyPages(pages) ? [] : pages.flatMap((page) => subsOf(page.href, roleLabel ?? "", modulesOff, removedBases)
    .filter((sub) => !pages.some((p) => p.href === sub.href)).map((sub): Page => ({ label: sub.label, href: sub.href, Icon: page.Icon, group: page.group, sub: page.label, words: ABOUT[sub.href]?.words, access: page.access })));
  const places = [...placesFor(pages, rename, modulesOff), ...subs.filter((sub, i, all) => all.findIndex((x) => x.href === sub.href) === i)];
  return { pages, places, financeOnly: financeOnlyPages(pages) };
}
const financeOnlyPages = (pages: readonly Page[]) => pages.every((page) => page.href === '/finance/desk' || page.href === '/erp') && pages.some((page) => page.href === '/finance/desk');
/** The tabs found by name (Client projects, Team dashboard, …) for a role: the work ones only with Work on the rail. */
// FIX-SHELL: a place whose module is off here (the Product map outside the platform's own companies) is not found either.
const placesFor = (pages: readonly Page[], rename?: ShellRename, modulesOff?: readonly string[]) => financeOnlyPages(pages) ? [] : renamed(PLACES, rename)
  .filter((place) => (place.access === "all" || pages.some((page) => page.href === "/tasks")) && !pathSwitchedOff(place.href, modulesOff));

/** Command palette: pages first, then matching projects, clients, contacts and people. ↑ ↓ move, Enter opens. Nothing scrolls: it shows the best few of each. */
function SearchPalette({ open, onClose, pages, rename, modulesOff }: { open: boolean; onClose: () => void; pages: readonly Page[]; rename?: ShellRename; modulesOff?: readonly string[] }) {
  const router = useRouter();
  const financeOnly = pages.every((page) => page.href === '/finance/desk' || page.href === '/erp') && pages.some((page) => page.href === '/finance/desk');
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<Records | null>(null);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const loading = useRef(false);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const places = placesFor(pages, rename, modulesOff);
    const groups: Hit[][] = [[...pages, ...(q ? places : [])].filter((page) => [page.label, ...(page.words ?? [])].some((w) => w.toLowerCase().includes(q))).slice(0, q ? 5 : 12).map((page) => ({ key: page.href, group: "Pages", label: page.label, href: page.href, Icon: page.Icon }))];
    if (!financeOnly && q.length >= 2) for (const set of records ?? []) {
      const starts = set.items.filter((item) => item.label.toLowerCase().startsWith(q));
      const rest = set.items.filter((item) => !item.label.toLowerCase().startsWith(q) && item.text.includes(q));
      groups.push([...starts, ...rest].slice(0, 5).map((item) => ({ key: item.href, group: set.group, label: item.label, sub: item.sub, href: item.href, Icon: set.Icon })));
    }
    // As many rows as the window has room for, shared fairly between the groups: the list never scrolls.
    const room = Math.max(4, Math.floor(((typeof window === "undefined" ? 900 : window.innerHeight) - 300) / 36));
    const take = groups.map(() => 0);
    for (let left = room, moved = true; left > 0 && moved;) { moved = false; groups.forEach((g, i) => { if (left > 0 && take[i] < g.length) { take[i]++; left--; moved = true; } }); }
    return groups.flatMap((g, i) => g.slice(0, take[i]));
  }, [query, pages, records, financeOnly, rename, modulesOff]);
  useEffect(() => {
    if (!open) return;
    setQuery(""); setAt(0);
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (!records && !loading.current && !financeOnly) { loading.current = true; void loadRecords().then(setRecords).finally(() => { loading.current = false; }); }
  }, [open, records, financeOnly]);
  useEffect(() => { setAt(0); }, [query]);
  if (!open) return null;
  const openHit = (hit: Hit | undefined) => { if (hit) { router.push(hit.href); onClose(); } };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") { event.preventDefault(); setAt((i) => Math.min(hits.length - 1, i + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); openHit(hits[at]); }
  };
  return (
    <div className={styles.searchBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={styles.searchDialog} role="dialog" aria-modal="true" aria-label="Search Pulse">
        <div className={styles.searchDialogInput}>
          <Search size={18} aria-hidden="true" />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={financeOnly ? 'Search Finance pages…' : 'Search pages, projects, clients, people…'} aria-label={financeOnly ? 'Search Finance pages' : 'Search pages, projects, clients and people'} role="combobox" aria-expanded="true" aria-controls="pulse-search-results" aria-activedescendant={hits[at] ? `pulse-hit-${at}` : undefined} onKeyDown={onKey} />
          <kbd>ESC</kbd>
        </div>
        <div className={styles.searchResults} id="pulse-search-results" role="listbox">
          {hits.map((hit, i) => (
            <div key={`${hit.group}:${hit.key}`} role="presentation">
              {i === 0 || hits[i - 1].group !== hit.group ? <p className={styles.searchDialogLabel}>{hit.group.toUpperCase()}</p> : null}
              <Link id={`pulse-hit-${i}`} role="option" aria-selected={i === at} href={hit.href} className={styles.searchResult} data-active={i === at ? "" : undefined} onMouseEnter={() => setAt(i)} onClick={onClose}>
                <hit.Icon size={16} aria-hidden="true" /><span>{hit.label}{hit.sub ? <small>{hit.sub}</small> : null}</span><span aria-hidden="true">↵</span>
              </Link>
            </div>
          ))}
          {hits.length === 0 ? <p className={styles.searchEmpty}>{!financeOnly && query.trim().length >= 2 && !records ? "Searching…" : "Nothing matches."}</p> : null}
        </div>
        <p className={styles.searchHints} aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>1</kbd>–<kbd>9</kbd> tabs</span><span><kbd>←</kbd><kbd>→</kbd> pages</span><span><kbd>/</kbd> search this page</span></p>
      </section>
    </div>
  );
}

/** `create`: the one small "+ New" control, first in the top bar's right-hand group at every width (LAYOUT-SWEEP: the
 *  rail no longer carries a big button). `utilities` follow it (Pip's island, check-in, the bell); `account` adds the
 *  app's own items to the account menu. Short confirmations show in Pip's island (UX-NOTIFY), not a corner. `org` is
 *  the organisation's own name and logo (LAYOUT-SWEEP); without one, `orgName` names the installed organisation and
 *  falls back to Pulse (EST-655). modulesOff filters switched-off modules from the rail, tabs, palette, recents and
 *  routes (EST-647). */
export function PulseShell({ identity, children, utilities, create, account, rename, org, orgName, modulesOff, externalSearch, embed, orgs, quickCreate, product }: { identity: PulseIdentity | null; children: ReactNode; utilities?: ReactNode; create?: ReactNode; account?: ReactNode; rename?: ShellRename; org?: PulseOrg | null; orgName?: string; modulesOff?: readonly string[];
  /** CHAT-SHELL: the page is shown inside the chat's side panel: the page alone, without the rail, the top bar or the
   *  phone's tabs (short confirmations still show). */ embed?: boolean;
  /** ORG: the Pulse account's organisations (the sidebar switcher and the rail's organisation tile switch between them). */ orgs?: PulseOrgs;
  /** IA-NAV: a staff seat's phone bar carries "+ New" (a new task). */ quickCreate?: boolean;
  /** UX-5A: the app mounts its own search palette (Ctrl+K): the shortcut and the search field send `pulse:search`
   *  instead of opening the shell's own palette. The app reads the role's pages with `shellNav()`. */ externalSearch?: boolean;
  /** LOGIN-VITALS: the product this address wears ("Vitals OS" and its icon on the platform's own addresses); Pulse when
   *  absent. It names the top bar's first crumb and the rail's tile when no company is known. */ product?: PulseProduct }) {
  const productName = product?.name?.trim() || "Pulse";
  const organisation = org?.name?.trim() || orgName?.trim() || productName;
  // ORG: the organisation this session works in. The address's brand (`org`) can be another one (on pulse-dev it is
  // always Estate Autopilots), so its logo is used only when it is this organisation's own.
  const currentOrg = orgs?.list.find((o) => o.current)?.name ?? organisation;
  // A logo that fails to load falls back to the initials inside OrgTile and the switcher (never a broken picture).
  const ownMark = org?.mark && org.name?.trim() === currentOrg.trim() ? org.mark : null;
  // ORG-SWITCHER-UX: without the address's own logo, the current organisation's logo from the account's list.
  const currentChoice = orgs?.list.find((o) => o.current);
  const railMark = ownMark ?? currentChoice?.mark ?? null;
  const brandIsCurrent = !orgs || org?.name?.trim() === currentOrg.trim();
  // FIX-SHELL: the company's one tile (rail), its own logo else its initials on its colour; Pulse's mark without a company.
  const companyKnown = !!(org?.name?.trim() || orgName?.trim() || orgs?.list.length);
  const multiOrg = !!orgs && orgs.list.length > 1;
  const companyTile = companyKnown ? <OrgTile name={currentOrg} mark={railMark} color={currentChoice?.color} size={32} className={styles.companyTile} imgClassName={styles.companyTileImg} /> : product?.icon
    ? <img src={product.icon} alt="" aria-hidden="true" width={32} height={32} className={styles.pulseMark} style={{ borderRadius: 9 }} /> : <PulseMark />;
  const pathname = usePathname();
  const role = identity?.roleLabel;
  const pages = useMemo(() => renamed(pagesFor(role, modulesOff, orgs), rename).map(withAbout), [role, rename, modulesOff, orgs]);
  const recentPages = useRecents();
  // EST-1420 P2: Recents also leave out pages under an entry the app removed (a null rename: a screen hidden from this
  // role or a company switch), except the person's own profile.
  const removed = useMemo(() => Object.entries(rename ?? {}).filter(([href, label]) => label === null && !href.includes("?")).map(([href]) => href), [rename]);
  const under = (href: string, base: string) => { const p = href.split(/[?#]/)[0]; return p === base || p.startsWith(base + "/"); };
  const recents = identity?.roleLabel === 'Accountant' ? [] : recentPages.filter((recent) => !pathSwitchedOff(recent.href, modulesOff)
    && !(removed.some((base) => under(recent.href, base)) && ![identity?.profileHref, identity?.recordHref].some((own) => own && under(recent.href, own))));
  const settings = identity?.roleLabel === 'Accountant' ? {...SETTINGS,href:'/account',label:'Account / Security'} : SETTINGS;
  const onSettings = [settings.href, ...(settings.also ?? [])].some((base) => pathname === base || !!pathname?.startsWith(base + "/"));
  const page = onSettings ? settings : currentPage(pathname, pages, rename);
  // UX-WORK (5 Nov 2026): My desk's and Work's own pages (My steps, My work, Approvals, My week) are titled what the menu
  // calls them, with the section before them, so a screen reader and a phone's top bar do not call Approvals "My desk".
  // HR-PEOPLE (screenshot judge: People & pay → Pay policy's top bar said "Team"): a page under a sub-place takes that
  // sub-place's name (/people/pay/settings → People & pay), the longest that fits; the section's own address only exactly.
  const sub = OWN_TITLES.has(page.href) ? (SUBPLACES[page.href] ?? []).filter((s) => !s.href.includes("?") && (pathname === s.href || (s.href !== page.href && pathname.startsWith(`${s.href}/`))))
    .sort((a, b) => b.href.length - a.href.length)[0] : undefined;
  const tabs = useMemo(() => mobileTabs(pages), [pages]);
  // HR has no Settings in its rail, so the Settings pages it may open (Review data) sit in its People group.
  const railPages = useMemo(() => role === "HR" ? pages.map((p) => p.group === "settings" ? { ...p, group: "people" as const } : p) : pages, [role, pages]);
  const adminPages = useMemo(() => railPages.filter((p) => p.group === "settings"), [railPages]);
  // IA-NAV: what the person changed with Edit menu (pins, hidden pages, group order, open groups), kept in this browser.
  const [prefs, setPrefs] = useState<NavPrefs>({});
  useEffect(() => { try { setPrefs(prefsFrom(JSON.parse(window.localStorage.getItem(NAV_PREFS_KEY) ?? "{}"))); } catch {} }, []);
  const savePrefs = (next: NavPrefs) => { setPrefs(next); try { window.localStorage.setItem(NAV_PREFS_KEY, JSON.stringify(next)); } catch {} };
  // VISUAL-QA: the Settings sections this role may open (SUBPLACES["/settings"]) as rows of the Settings group, with icons.
  // SETTINGS-APPLE (judge: "two lists of the same sections side by side"): on Settings itself its own list pane shows
  // the sections, so the rail's Settings group keeps only "All settings" there (the shortcuts stay on every other page).
  const inSettingsList = pathname === "/settings";
  const settingsRows = useMemo(() => role === "HR" || settings.href !== SETTINGS.href || inSettingsList ? [] : subsOf(SETTINGS.href, role ?? "", modulesOff, removed)
    .flatMap((s): Page[] => { const row = SETTINGS_ROWS[s.href]; return row ? [{ label: s.label, href: s.href, Icon: row[0], group: "settings", access: "all", cluster: row[1] }] : []; }), [role, settings, modulesOff, removed, inSettingsList]);
  const groups = useMemo(() => groupsFor(railPages, groupOrder(prefs), role === "HR" ? null : settings, settingsRows), [railPages, prefs, role, settings, settingsRows]);
  const pins = pinsOf(prefs, role), hiddenHrefs = hiddenOf(prefs, role);
  const pinnedPages = pins.map((href) => groups.flatMap((g) => g.items).find((p) => p.href === href)).filter((p): p is Page => !!p);
  // The address's query (Quotes, Connect your AI and the tabs under a page are entries with a query).
  const [search, setSearch] = useState("");
  useEffect(() => { setSearch(window.location.search); }, [pathname]);
  const here = (href: string) => { const [p, q] = href.split("?"); if (p !== pathname) return false; if (!q) return true; const want = new URLSearchParams(q), have = new URLSearchParams(search); return [...want].every(([k, v]) => have.get(k) === v); };
  /** The entry the person is on: an entry with a query when the address carries it (Quotes), else the page itself. */
  // VISUAL-QA: a page reached from another menu lights the sidebar row it belongs to (Account / Security is Your account).
  const lights = pathname ? LIGHTS[pathname] : undefined;
  const activeHref = useMemo(() => groups.flatMap((g) => g.items).find((p) => p.href.includes("?") && here(p.href))?.href
    ?? (lights && groups.some((g) => g.items.some((p) => p.href === lights)) ? lights : page.href), [groups, page.href, pathname, search, lights]); // eslint-disable-line react-hooks/exhaustive-deps
  // VISUAL-QA (owner, 10 Nov 2026: "a nav highlight that doesn't match the page"): a page no sidebar row covers used to
  // fall back to the first page (Dashboard), so Home opened and its rail icon lit on Account, Apps or Connections. Now
  // such a page opens the group it belongs to (Settings for Account and Apps), or none.
  const matched = page !== pages[0] || [page.href, ...(page.also ?? [])].some((b) => pathname === b || !!pathname?.startsWith(b + "/"));
  const activeGroup = onSettings && !activeHref.includes("?") ? "settings" : groups.find((g) => g.items.some((p) => p.href === activeHref))?.key
    ?? (matched && groups.some((g) => g.key === page.group) ? page.group : null);
  const [editing, setEditing] = useState(false);
  // The current page's row is always in view in the sidebar (a long group list scrolls inside its own box).
  useEffect(() => { const t = window.setTimeout(() => document.querySelector("#pulse-sidebar-panel nav [aria-current='page']")?.scrollIntoView({ block: "nearest" }), 60); return () => window.clearTimeout(t); }, [pathname, activeHref]);
  const [appsOpen, setAppsOpen] = useState(false);
  // DROPDOWNS: every hand-made dropdown menu gets the same keyboard, size and scrolling (menu-keys.ts).
  useEffect(() => installMenuKeys(), []);
  // NEW-DOTS (owner, 8 Nov 2026): a red dot on every entry that leads to a page the latest releases changed, until the
  // person opens it (the app sends the list: new-dots-host.tsx). A page lights for itself, the pages it also covers and
  // its sub-places; a group and Settings light for their pages; the account menu's What's new carries the count.
  const dots = useNewDots();
  const subsFor = (href: string) => subsOf(href, role ?? "", modulesOff, removed);
  const pageIsNew = (p: Page) => (p.href.includes("?") ? subIsNew(dots, p.href) : entryIsNew(dots, [p.href, ...(p.also ?? [])]))
    || subsFor(p.href).some((s) => subIsNew(dots, s.href));
  const settingsIsNew = entryIsNew(dots, [settings.href, ...(settings.also ?? [])]) || adminPages.some(pageIsNew);
  const groupIsNew = (g: Group) => g.key === "settings" ? settingsIsNew : g.items.some(pageIsNew);
  // NEW-DOTS-2 (owner, 10 Nov 2026: "alert me at the top level first, then take me deeper"): every level says how many new
  // things wait below it (a group, a page, a sub-place, a tab); the page itself then leads on to the thing
  // (new-dots-host.tsx). A page reached by a tab address (…?view=) never counts its page's changes (as pageIsNew).
  const hrefsOf = (p: Page) => p.href.includes("?") ? [] : [p.href, ...(p.also ?? []), ...subsFor(p.href).filter((s) => !s.href.includes("?")).map((s) => s.href)];
  const countOf = (ps: readonly Page[]) => entryCount(dots, ps.flatMap(hrefsOf));
  const settingsCount = countOf([settings, ...adminPages]);
  const groupCount = (g: Group) => g.key === "settings" ? settingsCount : countOf(g.items);
  // HR-PEOPLE (owner, 13 Nov 2026: hovering a red dot "says nothing", or a line about something else): an entry with a
  // dot says on hover what is new under it and that a click shows it; without a dot it keeps its one-line blurb.
  const tipOf = (label: string, ps: readonly Page[], lit: boolean, fallback?: string) => lit ? dotTip(label, countOf(ps), entryNotes(dots, ps.flatMap(hrefsOf))) : fallback;
  const withNew = (name: string, lit: boolean) => lit ? `${name}, ${NEW_LABEL}` : name;
  const dotFor = (p: Page) => p.href === "/whats-new" ? <NewDot on={dots.on && dots.count > 0} count={dots.count} /> : <NewDot on={pageIsNew(p)} count={countOf([p])} />;
  // "auto" (no saved choice): the panel beside the rail opens only on very wide windows, so pages get the width.
  const [sidebar, setSidebar] = useState<"auto" | "open" | "closed">("auto");
  const [wide, setWide] = useState(false);
  // Owner workbench UI: Chats (a full app page) keeps the panel aside unless it was opened by hand, so its toggle is the
  // rail's expand button there too; before, the panel stayed hidden behind the chat and the toggle opened then "closed".
  const appPage = !!pathname?.startsWith("/chats");
  const collapsed = sidebar === "closed" || (sidebar === "auto" && (!wide || appPage));
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // IA-NAV: All apps, the same groups with every page's short line and places (the rail's grid button, Ctrl+K, and the
  // phone's More). A team member's sheet used to fold specialist pages under "All pages"; now every page is one tap away.
  const launcherGroups = useMemo<LauncherGroup[]>(() => groups.map((g) => ({ key: g.key, label: g.label, Icon: g.Icon, entries: g.items.map((p) => ({
    label: p.label, href: p.href, Icon: p.Icon, blurb: p.blurb, words: p.words, group: g.label, isNew: p.href === "/whats-new" ? dots.on && dots.count > 0 : pageIsNew(p),
    count: p.href === "/whats-new" ? (dots.on ? dots.count : undefined) : countOf([p]) || undefined, current: p.href === activeHref,
    subs: subsFor(p.href).filter((s) => !g.items.some((x) => x.href === s.href)).map((s) => ({ label: s.label, href: s.href, isNew: subIsNew(dots, s.href) })) })) }))
  , [groups, dots, activeHref, role, modulesOff, removed]); // eslint-disable-line react-hooks/exhaustive-deps
  // FIX-SHELL: All apps opens on Recent (the sidebar's Recents: pages and records opened last).
  const launcherRecents = useMemo(() => recents.map((r) => ({ href: r.href, title: r.title, Icon: recentIcon(r.kind) })), [recents]);
  const togglePinned = (href: string) => savePrefs(togglePin(prefs, role, href));
  // IA-NAV (with UI-SWEEP): the phone's "+" (a new task) is a tab in the bottom bar, so it never covers a page's first
  // card. Work and My day have their own "+ New" (KAZUK-REST); the app opens the Create dialog (pulse:create).
  const newTab = quickCreate && !/^\/(tasks|my-day)(\/|$)/.test(pathname ?? "") ? <button key="new" type="button" className={`${styles.bottomLink} ${navCss.newTab}`} aria-label="New task" aria-haspopup="dialog"
    data-phone-quick-create="" onClick={() => window.dispatchEvent(new CustomEvent("pulse:create", { detail: {} }))}><i className={navCss.newTabIcon} aria-hidden="true"><Plus size={18} strokeWidth={2.4} /></i><span>New</span></button> : null;
  const [offline, setOffline] = useState(false);
  // Unread chat messages for the desktop rail and phone tab, from the updates the app already polls.
  const [chatUnread, setChatUnread] = useState(0);
  const [workspaceId, setWorkspaceId] = useState("pulse-organisation");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const workspaces: PulseWorkspace[] = useMemo(() => [
    { tenant_id: "pulse-personal", name: identity?.displayName ?? "Your account", kind: "personal" },
    { tenant_id: "pulse-organisation", name: organisation, kind: "organisation" },
  ], [identity?.displayName, organisation]);

  useEffect(() => { setMoreOpen(false); setAppsOpen(false); }, [pathname]);
  // Ctrl+K → All apps (the app's palette sends it).
  useEffect(() => { const show = () => setAppsOpen(true); window.addEventListener("pulse:apps", show); return () => window.removeEventListener("pulse:apps", show); }, []);
  // FLOAT-2: Android back (and the browser's) closes the More sheet, the switcher or search before it leaves the page.
  useBackLayer(moreOpen, () => setMoreOpen(false));
  useBackLayer(switcherOpen, () => setSwitcherOpen(false));
  useBackLayer(searchOpen, () => setSearchOpen(false));
  // Phone and tablet: the page's own heading names the page, so the bar's title stays tucked away until that heading
  // scrolls under the bar (the iOS large-title pattern). Pages render after the shell, so the heading is found again
  // whenever the main area changes.
  const [titleTucked, setTitleTucked] = useState(false);
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main || typeof IntersectionObserver === "undefined") return;
    let watched: Element | null = null;
    let frame = 0;
    const seen = new IntersectionObserver(([entry]) => setTitleTucked(entry.isIntersecting), { rootMargin: "-48px 0px 0px 0px" });
    const attach = () => {
      frame = 0;
      const heading = main.querySelector("[data-page-header] h2");
      if (heading === watched) return;
      if (watched) seen.unobserve(watched);
      watched = heading;
      if (heading) seen.observe(heading); else setTitleTucked(false);
    };
    attach();
    const changes = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(attach); });
    changes.observe(main, { childList: true, subtree: true });
    return () => { changes.disconnect(); seen.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    try { const saved = window.localStorage.getItem("pulse.sidebar.collapsed"); setSidebar(saved === "true" ? "closed" : saved === "false" ? "open" : "auto"); } catch {}
    const media = window.matchMedia(WIDE_SIDEBAR); const sync = () => setWide(media.matches); sync();
    media.addEventListener("change", sync); return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const closeSwitcher = (event: PointerEvent) => {
      if (event.target instanceof Node && !switcherRef.current?.contains(event.target)) setSwitcherOpen(false);
    };
    document.addEventListener("pointerdown", closeSwitcher);
    return () => document.removeEventListener("pointerdown", closeSwitcher);
  }, []);
  useEffect(() => {
    const updateConnectivity = () => setOffline(!navigator.onLine);
    updateConnectivity();
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    return () => {
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, []);
  // UI-SWEEP / UX-GAMIFY (10 Nov 2026): the top bar has no fill at rest (owner, 20 Oct); once the page has scrolled under it,
  // [data-shell-topbar] carries data-scrolled so the CSS can give it a fill (the page's title no longer shows cut in half).
  // The window scrolls on a phone, the shell's own box on a computer: one capturing listener sees both.
  useEffect(() => {
    const bar = () => document.querySelector("[data-shell-topbar]");
    const main = document.getElementById("main-content");
    const onScroll = (event: Event) => {
      const el = event.target === document ? document.scrollingElement : event.target as Element | null;
      if (!el || !(el === document.scrollingElement || (main && el.contains(main)))) return;
      bar()?.toggleAttribute("data-scrolled", (el as Element).scrollTop > 0);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  useEffect(() => { document.querySelector("[data-shell-topbar]")?.removeAttribute("data-scrolled"); }, [pathname]);
  // QA-1024 (friendliness): on a phone the top bar repeated the page's own title right under it ("My desk" / "My desk").
  // While the page's title is in view the bar's copy is faded out (still there for screen readers); it appears once the
  // page's title scrolls away under the bar, as in a large-title app. html[data-page-title-shown] drives the CSS.
  useEffect(() => {
    const root = document.documentElement;
    let io: IntersectionObserver | null = null;
    const watch = () => {
      io?.disconnect();
      const head = document.querySelector("main [data-page-header] h2");
      if (!head || typeof IntersectionObserver === "undefined") { root.removeAttribute("data-page-title-shown"); return; }
      const bar = Math.round(document.querySelector("[data-shell-topbar]")?.getBoundingClientRect().height ?? 52);
      io = new IntersectionObserver(([e]) => root.toggleAttribute("data-page-title-shown", e.isIntersecting), { rootMargin: `-${bar}px 0px 0px 0px` });
      io.observe(head);
    };
    const timers = [0, 400, 1500].map((ms) => window.setTimeout(watch, ms));
    return () => { timers.forEach((t) => window.clearTimeout(t)); io?.disconnect(); root.removeAttribute("data-page-title-shown"); };
  }, [pathname]);
  // QA-1024: offline, a tap on a Pulse link stays on this page and the page opens once the network is back. Before, the
  // failed client navigation fell back to a full page load: Chrome's "No internet" page, a dead end that stayed after
  // the network returned (seen on the Redmi Note 8 Pro).
  const [waiting, setWaiting] = useState<string | null>(null);
  const shellRouter = useRouter();
  useEffect(() => {
    if (!offline) return;
    let pending: string | null = null;
    const hold = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const a = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      event.preventDefault(); event.stopPropagation();
      pending = url.pathname + url.search + url.hash; setWaiting(pending);
    };
    // Back online: open the page that was tapped (this listener runs in the same event as the shell's own "online").
    const back = () => { const href = pending; pending = null; setWaiting(null); if (href) shellRouter.push(href); };
    document.addEventListener("click", hold, true); window.addEventListener("online", back);
    return () => { document.removeEventListener("click", hold, true); window.removeEventListener("online", back); };
  }, [offline, shellRouter]);
  useEffect(() => {
    const changed = (event: Event) => { const n = (event as CustomEvent<{ counts?: { chats?: unknown } }>).detail?.counts?.chats; if (typeof n === "number") setChatUnread(n); };
    window.addEventListener("pulse:communications", changed);
    return () => window.removeEventListener("pulse:communications", changed);
  }, []);
  // UX-5A: with the app's own palette, opening it is an event the palette listens for.
  const external = useRef(externalSearch); useEffect(() => { external.current = externalSearch; }, [externalSearch]);
  const openSearch = () => { if (external.current) window.dispatchEvent(new Event("pulse:search")); else setSearchOpen(true); };
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key ?? "").toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape") { setSearchOpen(false); setMoreOpen(false); setAppsOpen(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // AGENT-UI-CONTROL: an AI employee helping this person opens or closes the sidebar (window "pulse:sidebar" { open });
  // a phone has no sidebar, so nothing takes it there (the action says so).
  useEffect(() => {
    const set = (event: Event) => {
      const open = (event as CustomEvent<{ open?: unknown }>).detail?.open;
      if (typeof open !== "boolean" || !window.matchMedia("(min-width: 900px)").matches) return;
      event.preventDefault(); setSidebar(open ? "open" : "closed");
      try { window.localStorage.setItem("pulse.sidebar.collapsed", String(!open)); } catch {}
    };
    window.addEventListener("pulse:sidebar", set);
    return () => window.removeEventListener("pulse:sidebar", set);
  }, []);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setSidebar(next ? "closed" : "open");
    try { window.localStorage.setItem("pulse.sidebar.collapsed", String(next)); } catch {}
  };
  const searchFromField = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSearch();
    }
  };

  // ERP-INVOICE: a client's acceptance link (/accept/…) is a bare page too: no staff rail, signed out; COMP-A: so is
  // a person's offer link (/offer/…). E2E-4P: so are an invitation (/join) and a client link (/invited): the person
  // opening them is not in this organisation yet, and the staff rail (Dashboard, My pay…) only led nowhere.
  // ONBOARD: so is team setup (/team-setup), for colleagues who cannot sign in yet.
  // ONBOARD-GATE: and "Set up your profile" (/welcome), a focused first run (Pulse stays closed until it is done).
  // SIGNED-OUT-SHELL (phone QA, 4 Nov 2026): nobody signed in (sign-up, Start your company, the profile gate) is a bare
  // page too. The frame without a person drew "Dashboard", an "A" avatar and a staff tab bar (Home twice, Pulse HQ,
  // People, My pay) whose every link only led to "Sign in to continue".
  if (embed) return <ThemeProvider><main id="main-content" className={styles.embedMain} data-embed="">{children}</main><NoticeCenter /></ThemeProvider>;
  if (!identity || pathname.startsWith("/login") || pathname === "/join" || pathname === "/team-setup" || pathname === "/welcome" || pathname === "/invited" || pathname.startsWith("/accept/") || pathname.startsWith("/offer/") || ["/portal/login","/portal/set-password","/portal/confirm-email"].includes(pathname)) return <ThemeProvider><main id="main-content" data-bare-page="">{children}</main></ThemeProvider>;
  return (
    <ThemeProvider>
      <div className={`${styles.shell} ${sidebar === "closed" ? styles.collapsed : sidebar === "auto" ? styles.autoSidebar : ""}`} data-sidebar-collapsed={collapsed} data-app-page={pathname?.startsWith("/chats") ? "" : undefined} data-has-utilities={utilities ? "true" : undefined} data-title-tucked={titleTucked ? "" : undefined}>
        <a className={styles.skip} href="#main-content">Skip to workspace</a>
        <aside className={styles.sidebar} aria-label="Pulse navigation">
          {/* IA-NAV: the rail holds one icon per group (nav-catalog.ts); the panel beside it holds the same groups, folding,
              with the person's pinned pages on top, then the page's own content and Recents. */}
          <div className={styles.iconStrip}>
            {/* FIX-SHELL (owner, 10 Nov 2026: "the Pulse logo sits above the Estate Autopilots logo, stacked; show the company
                identity once"): the rail's one tile is the company's own (its logo, else its initials on its colour; Pulse's
                mark only where no company is known). Open, it leads home and the panel beside it names the company; collapsed
                with more than one company, it is the switcher (Ctrl+Shift+O), and the rail's foot opens the panel. */}
            <div className={styles.stripTop}><div className={styles.logoSlot}>
              {collapsed && multiOrg
                ? <SidebarTooltip content={`${currentOrg} · Switch company (Ctrl+Shift+O)`} active>
                    <button type="button" className={styles.companyLink} onClick={() => window.dispatchEvent(new Event("pulse:orgs-open"))} aria-label={`${currentOrg}: switch company (Ctrl+Shift+O)`} data-nav-id="rail:company">{companyTile}</button>
                  </SidebarTooltip>
                : <Link href="/" aria-label={`${companyKnown ? currentOrg : productName} home`} title={companyKnown ? currentOrg : productName} className={styles.companyLink} data-nav-id="rail:company">{companyTile}</Link>}
            </div>
            </div>
            <nav className={styles.stripNav} aria-label="Main sections">
              {groups.filter((g) => g.key !== "settings").map((g) => {
                const unread = g.key === "chat" ? chatUnread : 0;
                const lit = groupIsNew(g);
                const name = withNew(unread ? `${g.label}, ${unread} unread` : g.label, lit);
                const to = g.items.find((p) => !hiddenHrefs.includes(p.href)) ?? g.items[0];
                // NEW-DOTS-2: the tooltip says how many new things wait inside ("Work · 2 new"); the link's name stays "Work, New".
                const tip = lit && !unread ? tipOf(g.label, g.key === "settings" ? [settings, ...adminPages] : g.items, true) ?? name : unread ? `${g.label}: ${unread} unread ${unread === 1 ? "message" : "messages"}. Click to read ${unread === 1 ? "it" : "them"}.` : name;
                return <SidebarTooltip key={g.key} content={tip} active>
                  <Link {...HOVER_FULL} className={`${styles.stripBtn}${activeGroup === g.key ? ` ${styles.stripBtnActive}` : ""}`} href={to.href} aria-label={name} aria-current={activeGroup === g.key ? "page" : undefined}
                    data-nav-id={`rail:${g.key}`} onClick={() => { if (prefs.open?.[g.key] === false) savePrefs({ ...prefs, open: { ...prefs.open, [g.key]: true } }); }}>
                    <g.Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.stripLabel}>{g.short ?? g.label}</span>
                    {unread ? <i className={styles.stripBadge} aria-hidden="true">{unread > 99 ? "99+" : unread}</i> : <NewDot on={lit} place="corner" count={groupCount(g)} />}
                  </Link>
                </SidebarTooltip>;
              })}
            </nav>
            <div className={styles.stripBottom}>
              {collapsed ? <SidebarTooltip content="Open the menu" active><button type="button" className={styles.stripBtn} onClick={toggleCollapsed} aria-label="Expand sidebar navigation" aria-expanded="false" aria-controls="pulse-sidebar-panel" data-nav-id="rail:expand"><PanelLeftOpen size={19} strokeWidth={1.75} aria-hidden="true" /></button></SidebarTooltip> : null}
              <SidebarTooltip content="All apps" active><button type="button" className={`${styles.stripBtn} ${navCss.appsBtn}`} data-open={appsOpen ? "" : undefined} aria-label="All apps" aria-haspopup="dialog" aria-expanded={appsOpen}
                data-nav-id="rail:apps" onClick={() => setAppsOpen(true)}><LayoutGrid size={19} strokeWidth={1.75} aria-hidden="true" /></button></SidebarTooltip>
              {role !== "HR" ? <SidebarTooltip content={withNew(settings.label, settingsIsNew)} active><Link {...HOVER_FULL} className={`${styles.stripBtn}${activeGroup === "settings" ? ` ${styles.stripBtnActive}` : ""}`} href={settings.href} aria-label={withNew(settings.label, settingsIsNew)} aria-current={activeGroup === "settings" ? "page" : undefined}
                data-nav-id="rail:settings"><Settings size={19} strokeWidth={1.75} aria-hidden="true" /><NewDot on={settingsIsNew} place="corner" count={settingsCount} /></Link></SidebarTooltip> : null}
            </div>
          </div>
          <div id="pulse-sidebar-panel" className={styles.panel} inert={collapsed}>
            <div className={styles.panelHeader}>
              <WorkspaceSwitcher workspaces={workspaces} currentId={workspaceId} personName={identity?.displayName ?? null} pending={false} open={switcherOpen} setOpen={setSwitcherOpen} containerRef={switcherRef} onSelect={(next) => { setWorkspaceId(next); setSwitcherOpen(false); }} orgMark={ownMark} orgs={orgs} bare={companyKnown} />
              <button type="button" className={styles.collapseBtn} onClick={toggleCollapsed} aria-label="Collapse sidebar navigation" aria-expanded={!collapsed} aria-controls="pulse-sidebar-panel" title="Collapse navigation"><PanelLeftClose size={16} aria-hidden="true" /></button>
            </div>
            <div className={`${styles.searchBox} ${styles.panelSearch}`}>
              <Search size={15} className={styles.searchIcon} aria-hidden="true" />
              <input type="text" readOnly className={styles.searchInput} placeholder="Search Pulse…" aria-label="Search Pulse" onClick={openSearch} onKeyDown={searchFromField} />
              <kbd className={styles.searchKbd}>⌘K</kbd>
            </div>
            <div className={navCss.groups} data-editing={editing ? "" : undefined}>
              {editing ? <p className={navCss.editHint}>Star a page to pin it on top. Hide what you never use; it stays in All apps.</p> : null}
              {pinnedPages.length > 0 && !editing ? <nav className={styles.sectionNav} aria-label="Pinned pages">
                <p className={navCss.pinnedTitle}><Star size={12} aria-hidden="true" />Pinned</p>
                {pinnedPages.map((p) => (
                  <Link key={`pin:${p.href}`} {...HOVER_FULL} href={p.href} className={styles.sectionLink} data-nav-id={`pin:${p.href}`} aria-current={activeHref === p.href ? "page" : undefined} title={tipOf(p.label, [p], pageIsNew(p), p.blurb)}>
                    <p.Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{p.label}</span>{dotFor(p)}
                  </Link>))}
              </nav> : null}
              {groups.map((g, gi) => {
                const isOpen = editing || groupOpen(prefs, role, g.key, activeGroup === g.key, activeGroup === "home");
                const items = editing ? g.items : g.items.filter((p) => !hiddenHrefs.includes(p.href) || p.href === activeHref);
                const movable = g.key !== "settings";
                return <div key={g.key} className={navCss.group}>
                  <div className={navCss.item}>
                    <button type="button" className={navCss.groupHead} aria-expanded={isOpen} data-active={activeGroup === g.key ? "" : undefined} data-nav-id={`group:${g.key}`}
                      aria-label={withNew(g.label, groupIsNew(g) && !isOpen)} disabled={editing} title={!isOpen ? tipOf(g.label, g.items, groupIsNew(g)) : undefined}
                      onClick={() => savePrefs({ ...prefs, open: { ...prefs.open, [g.key]: !isOpen } })}>
                      <g.Icon size={15} strokeWidth={1.9} aria-hidden="true" /><span className={navCss.groupLabel}>{g.label}</span>
                      {!isOpen ? <NewDot on={groupIsNew(g)} count={groupCount(g)} /> : null}<ChevronDown size={14} className={navCss.chev} aria-hidden="true" />
                    </button>
                    {editing && movable ? <>
                      <button type="button" className={navCss.editBtn} aria-label={`Move ${g.label} up`} disabled={gi === 0} onClick={() => savePrefs(moveGroup(prefs, g.key, -1))}><ChevronUp size={15} aria-hidden="true" /></button>
                      <button type="button" className={navCss.editBtn} aria-label={`Move ${g.label} down`} disabled={gi >= groups.length - 2} onClick={() => savePrefs(moveGroup(prefs, g.key, 1))}><ChevronDown size={15} aria-hidden="true" /></button>
                    </> : null}
                  </div>
                  {isOpen ? <nav className={`${styles.sectionNav} ${navCss.groupItems}`} aria-label={`${g.label} pages`}>
                    {items.flatMap((p, pi) => {
                      const subs = !editing && p.href === page.href && !(inSettingsList && p.href === SETTINGS.href) ? subsFor(p.href).filter((s) => !g.items.some((x) => x.href === s.href)) : []; // SETTINGS-APPLE: not under All settings while its own list pane shows them
                      const hidden = hiddenHrefs.includes(p.href);
                      const row = <div key={p.href} className={navCss.item} data-hidden={editing && hidden ? "" : undefined}>
                        <Link {...HOVER_FULL} href={p.href} className={styles.sectionLink} data-nav-id={`nav:${p.href}`} aria-current={activeHref === p.href ? "page" : undefined} title={tipOf(p.label, [p], pageIsNew(p), p.blurb)}>
                          <p.Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{p.label}</span>{dotFor(p)}
                        </Link>
                        {editing ? <>
                          <button type="button" className={navCss.editBtn} aria-pressed={pins.includes(p.href)} aria-label={pins.includes(p.href) ? `Unpin ${p.label}` : `Pin ${p.label}`} onClick={() => togglePinned(p.href)}><Star size={14} aria-hidden="true" /></button>
                          {p.href !== settings.href ? <button type="button" className={navCss.editBtn} aria-pressed={hidden} aria-label={hidden ? `Show ${p.label} in the menu` : `Hide ${p.label} from the menu`} onClick={() => savePrefs(toggleHidden(prefs, role, p.href))}>{hidden ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}</button> : null}
                        </> : null}
                      </div>;
                      // VISUAL-QA: a caption (You, Company, Admin tools) where the Settings group's rows change kind, when it has more than one kind.
                      const caption = g.key === "settings" && p.cluster && p.cluster !== items[pi - 1]?.cluster && new Set(items.map((x) => x.cluster)).size > 1
                        ? [<p key={`${p.href}:cluster`} className={navCss.clusterTitle} data-cluster={p.cluster}>{CLUSTERS.find(([c]) => c === p.cluster)?.[1]}</p>] : [];
                      return subs.length ? [...caption, row, <div key={`${p.href}:subs`} className={styles.sectionSubs}>{subs.map((s) => (
                        <Link key={s.href} {...HOVER_FULL} href={s.href} className={styles.sectionSub} data-nav-id={`sub:${s.href}`} aria-current={here(s.href) ? "page" : undefined} title={subIsNew(dots, s.href) ? dotTip(s.label, entryCount(dots, [s.href]), entryNotes(dots, [s.href])) : undefined}>{s.label}<NewDot on={subIsNew(dots, s.href)} count={entryCount(dots, [s.href])} /></Link>
                      ))}</div>] : [...caption, row];
                    })}
                  </nav> : null}
                </div>;
              })}
            </div>
            <div className={navCss.foot}>
              {editing ? <>
                <button type="button" className={navCss.footBtn} data-primary="" onClick={() => setEditing(false)}><Check size={14} aria-hidden="true" />Done</button>
                <button type="button" className={navCss.footBtn} onClick={() => savePrefs({})}><RotateCcw size={14} aria-hidden="true" />Reset</button>
              </> : <>
                <button type="button" className={navCss.footBtn} onClick={() => setAppsOpen(true)} data-nav-id="panel:apps"><LayoutGrid size={14} aria-hidden="true" />All apps</button>
                <button type="button" className={navCss.footBtn} onClick={() => setEditing(true)} data-nav-id="panel:edit"><Pencil size={14} aria-hidden="true" />Edit menu</button>
              </>}
            </div>
            <div className={styles.panelSlot} data-shell-sidebar />
            <div className={styles.panelSpacer} />
            <section className={styles.recentsSection} aria-label="Recent pages">
              <div className={styles.recentsHeader}>
                <button type="button" className={styles.recentsToggleBtn} onClick={() => setRecentsOpen((value) => !value)} aria-expanded={recentsOpen}>
                  <ChevronDown size={14} className={`${styles.recentsChevron}${recentsOpen ? "" : ` ${styles.recentsChevronCollapsed}`}`} aria-hidden="true" />
                  <span className={styles.recentsTitle}>Recents</span>
                </button>
                {recents.length ? <button type="button" className={styles.recentsClear} onClick={clearRecents}>Clear</button> : null}
              </div>
              {recentsOpen ? <div className={styles.recentsList}>
                {recents.map((recent) => { const Icon = recentIcon(recent.kind); return (
                  <Link key={recent.href} href={recent.href} className={styles.recentItem} title={recent.title}>
                    <Icon size={15} strokeWidth={1.75} className={styles.recentIcon} aria-hidden="true" />
                    <span className={styles.recentName}>{recent.title}</span>
                    <span className={styles.recentDate}>{recentAge(recent.at)}</span>
                  </Link>
                ); })}
                {recents.length === 0 ? <p className={styles.recentsEmpty}>Pages you open will appear here.</p> : null}
              </div> : null}
            </section>
          </div>
        </aside>
        <div className={styles.content}>
          <header className={styles.topBar} data-shell-topbar="">
            {/* OWNER-HOME: no logo in the top bar; the rail carries the one Pulse mark (owner, 20 Oct 2026). */}
            <nav className={styles.titleWrap} aria-label="Breadcrumb">
              <ol className={styles.topBarTitle}>
                <li className={styles.titleContext}>{sub ? page.label : productName}</li>
                <li className={styles.titleSlash} aria-hidden="true">/</li>
                <li><h1 className={styles.titleText} aria-current="page">{sub?.label ?? page.label}</h1></li>
              </ol>
            </nav>
            <div className={styles.topBarCenter} data-shell-toolbar />
            <div className={styles.topBarRight} data-shell-actions="">
              {create}
              {utilities}
              <ProfileMenu identity={identity} extra={account} newCount={dots.on ? dots.count : 0} />
            </div>
          </header>
          {offline ? <div className={styles.offlineNotice} role="status" aria-label="Offline status"><WifiOff size={15} aria-hidden="true" /><span>{waiting ? "You're offline. That page opens as soon as you're back online." : "You're offline. Pulse will reconnect when a network is available."}</span></div> : null}
          <main id="main-content" className={styles.main}>{children}</main>
        </div>
        {/* EST-1198: Home, Work, Chats and Me (My desk) first; the role's other pages and Settings under More. A tab's name
            starts with the word it shows ("Home (Dashboard)", "Me (My desk)"), so voice control and screen readers match it. */}
        <nav className={styles.bottomNav} aria-label="Mobile navigation" data-tabs={newTab ? "6" : undefined}>
          {tabs.flatMap((tab, ti) => { const { label, short, href, Icon } = tab; const unread = href === "/chats" ? chatUnread : 0; const lit = pageIsNew(tab); const name = short && short !== label ? `${short} (${label})` : label; const link = <Link key={href} {...HOVER_FULL} className={styles.bottomLink} href={href} aria-label={withNew(unread ? `${name}, ${unread} unread` : name, lit)} aria-current={page.href === href ? "page" : undefined}><Icon size={19} strokeWidth={1.75} aria-hidden="true" /><span>{short ?? label}</span>{unread ? <i className={styles.bottomBadge} aria-hidden="true">{unread > 99 ? "99+" : unread}</i> : <NewDot on={lit} place="corner" count={countOf([tab])} />}</Link>;
            return ti === 1 && newTab ? [link, newTab] : [link]; })}
          {pages.length > tabs.length ? (() => { const lit = settingsIsNew || pages.some((p) => !tabs.some((t) => t.href === p.href) && pageIsNew(p)); return <button type="button" className={styles.bottomLink} aria-label={withNew("More", lit)} aria-haspopup="dialog" aria-expanded={moreOpen} aria-current={onSettings || !tabs.some((p) => p.href === page.href) ? "page" : undefined} onClick={() => setMoreOpen((value) => !value)} data-nav-id="tab:more"><Ellipsis size={19} strokeWidth={1.75} aria-hidden="true" /><span>More</span><NewDot on={lit} place="corner" count={countOf(pages.filter((p) => !tabs.some((t) => t.href === p.href))) + (settingsIsNew ? settingsCount : 0)} /></button>; })() : null}
        </nav>
        {/* IA-NAV: the phone's More is All apps as a sheet (search, pinned pages, every group); a computer opens it as a card. */}
        <AppsLauncher open={moreOpen || appsOpen} onClose={() => { setMoreOpen(false); setAppsOpen(false); }} groups={launcherGroups} pins={pins} onPin={togglePinned}
          onSearch={openSearch} sheet={moreOpen} heading={moreOpen ? <span className={navCss.sheetOrg}>{brandIsCurrent ? organisation : currentOrg}</span> : null}
          recents={launcherRecents} />
        {externalSearch ? null : <SearchPalette pages={pages} rename={rename} modulesOff={modulesOff} open={searchOpen} onClose={() => setSearchOpen(false)} />}
        <NoticeCenter />
      </div>
    </ThemeProvider>
  );
}
