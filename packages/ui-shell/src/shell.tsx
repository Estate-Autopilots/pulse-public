"use client";

import {
  BookUser, Building2, CalendarCheck, ChevronDown, CircleCheck, Network, ReceiptText, ScanSearch, ShieldCheck, Wallet, BriefcaseBusiness, TrendingUp, Ellipsis, FolderKanban, House, Map as MapIcon, MessageCircle, WifiOff,
  ChartGantt, Gauge, Gem, GraduationCap, LayoutGrid, Lightbulb, Newspaper, Palette, PanelLeftClose, PanelLeftOpen, PlugZap, Search, Settings, Users, Workflow, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useBackLayer } from "./back-layer";
import { mobileTabs } from "./mobile-tabs";
import { pathSwitchedOff } from "./modules";
import { BRAND, MARK } from "../../design-system/src/brand.js";
import { NoticeCenter } from "./notice-center";
import { ProfileMenu } from "./profile-menu";
import { clearRecents, recentAge, recentIcon, useRecents } from "./recents";
import styles from "./shell.module.css";
import { SidebarTooltip } from "./sidebar-tooltip";
import { ThemeProvider } from "./theme-provider";
import type { PulseIdentity, PulseOrg, PulseOrgs, PulseWorkspace } from "./types";
import { WorkspaceSwitcher, initials as orgInitials, orgHue } from "./workspace-switcher";

type Page = Readonly<{ label: string; short?: string; href: string; Icon: typeof House; group: "work" | "people" | "money" | "admin"; also?: readonly string[]; access: "all" | "work" | "hr" | "admin" }>;
const allPages: readonly Page[] = [
  { label: "Dashboard", short: "Home", href: "/dashboard", Icon: House, group: "work", access: "all" },
  // CLIENT-PORTAL: a client's own home (the app removes it for everyone else).
  { label: "Home", href: "/client", Icon: House, group: "work", access: "all" },
  // Work: the company's own projects, the fulfilment of client packages, and every task. Clients: the clients and the
  // packages they bought (client projects). Two worlds, never mixed (UX-TASKS).
  { label: "Work", href: "/tasks", Icon: CircleCheck, group: "work", also: ["/my-week", "/delivery", "/portal"], access: "work" },
  { label: "Chats", href: "/chats", Icon: MessageCircle, group: "work", also: ["/communication", "/inbox", "/groups"], access: "all" },
  { label: "Updates", href: "/updates", Icon: Newspaper, group: "work", access: "all" },
  { label: "Clients", href: "/clients", Icon: Building2, group: "work", also: ["/projects", "/stewardship/client", "/stewardship/project", "/deliveries"], access: "work" },
  { label: "Acquisition", href: "/acquisition", Icon: TrendingUp, group: "work", access: "work" },
  { label: "Contacts", href: "/contacts", Icon: BookUser, group: "work", also: ["/stewardship/contact", "/relationships"], access: "work" },
  { label: "Map", href: "/map", Icon: MapIcon, group: "work", access: "work" },
  // FLOW-B (21 Oct 2026): one place for how the company works. Processes (each one's write-up, steps and runs: the old
  // SOPs, workflows and boards together) and Runs (every project going through one). After Map: the phone's tabs stay.
  { label: "Processes", href: "/processes", Icon: Workflow, group: "work", also: ["/sops"], access: "work" },
  { label: "Runs", href: "/runs", Icon: ChartGantt, group: "work", access: "work" },
  // EST-1474: the Creative Strategy app (CS Home and sprints); its module is off unless the server switches it on.
  { label: "Creative Strategy", short: "Creative", href: "/creative", Icon: Lightbulb, group: "work", access: "work" },
  // EST-1363: the Sales X-Ray app; its module switch (PULSE_SALES_XRAY) hides it where it is off.
  { label: "Sales X-Ray", short: "X-Ray", href: "/apps/sales-xray", Icon: PlugZap, group: "work", access: "all" },
  // PULSE-NETWORK (EST-1026): the companies on Pulse Network, their leaders and their AI agents; leaders only for now,
  // and only where the company's connector is set up (the app removes it otherwise). After SOPs: the phone's tabs stay.
  { label: "Network", href: "/network", Icon: Network, group: "work", access: "admin" },
  // PULSE-HQ (owner, 23 Oct 2026): the business of Pulse (catalogue, licences, Offer Studio, ideas, brand); an
  // organisation-only module, on only in the Pulse organisation, so nobody else ever sees it.
  { label: "Pulse HQ", short: "HQ", href: "/hq", Icon: Gem, group: "work", access: "work" },
  { label: "Team", href: "/people", Icon: Users, group: "people", also: ["/activity", "/stewardship/person", "/designers"], access: "all" },
  { label: "My desk", short: "Me", href: "/me", Icon: CalendarCheck, group: "people", also: ["/attendance", "/leave", "/notifications", "/welcome"], access: "all" },
  { label: "HR desk", short: "HR", href: "/hr", Icon: BriefcaseBusiness, group: "people", also: ["/hr-history", "/shifts"], access: "hr" },
  { label: "Leadership", short: "Lead", href: "/leadership", Icon: TrendingUp, group: "people", also: ["/pod", "/pods"], access: "admin" },
  // WA-NATIVE (25 Oct 2026): Insights → Client operations, what the company's WhatsApp groups say (leadership and admins).
  { label: "Insights", href: "/insights", Icon: Lightbulb, group: "people", access: "admin" },
  { label: "Finance", href: "/finance", Icon: Wallet, group: "money", access: "admin" },
  // ERP-INVOICE: invoices, products and services, inventory and templates (leadership, the Finance role; Accountant reads).
  // BILLING (18 Oct 2026): called Billing; the address stays /erp.
  { label: "Billing", href: "/erp", Icon: ReceiptText, group: "money", access: "admin" },
  { label: "Review data", short: "Review", href: "/review-data", Icon: ScanSearch, group: "admin", also: ["/opshub"], access: "hr" },
  { label: "Audit", href: "/audit", Icon: ShieldCheck, group: "admin", access: "admin" },
  // TELEMETRY (owner, 24 Oct 2026): where Pulse is slow: pages, clicks, API routes, errors, people, sessions, versions.
  { label: "Telemetry", href: "/telemetry", Icon: Gauge, group: "admin", access: "admin" },
  // PULSE-HQ (owner, 23 Oct 2026): every organisation reads what Pulse can do (the catalogue the Pulse organisation keeps).
  { label: "What Pulse can do", short: "Features", href: "/features", Icon: Lightbulb, group: "admin", access: "all" },
];
/** QA-1024 (R083): pages a team member's More sheet leaves under "All pages" unless the role uses them. */
const SPECIALIST: readonly string[] = ["/acquisition", "/runs", "/apps/sales-xray", "/hq"];
const MORE_CAP = 8;
const SETTINGS: Page = { label: "Settings", href: "/settings", Icon: Settings, group: "admin", also: ["/companies"], access: "all" };
/** Owner workbench (21 Oct 2026): the rail holds six sections instead of every page; the panel beside it lists the
 *  chosen section's pages by name. A page no section names falls into its group's section; admin pages sit under
 *  Settings. Sections without a page for the role are left out. */
type Section = Readonly<{ key: string; label: string; Icon: typeof House; hrefs: readonly string[]; group?: Page["group"] }>;
const SECTIONS: readonly Section[] = [
  { key: "home", label: "Home", Icon: House, hrefs: ["/dashboard", "/client", "/me"] },
  { key: "hq", label: "Pulse HQ", Icon: Gem, hrefs: ["/hq"] },
  { key: "work", label: "Work", Icon: CircleCheck, hrefs: ["/tasks", "/processes", "/runs", "/creative"], group: "work" },
  { key: "chats", label: "Chats", Icon: MessageCircle, hrefs: ["/chats"] },
  { key: "clients", label: "Clients", Icon: Building2, hrefs: ["/clients", "/contacts", "/acquisition", "/map", "/network", "/apps/sales-xray", "/insights"] },
  { key: "people", label: "People", Icon: Users, hrefs: ["/people", "/hr", "/leadership"], group: "people" },
  { key: "money", label: "Money", Icon: Wallet, hrefs: ["/finance", "/erp"], group: "money" },
];
const SECTION_HREFS = SECTIONS.flatMap((section) => section.hrefs);
/** The places inside a page (its tabs and sub-pages), listed under it in the panel so every feature is one click from its
 *  section. `lead`: leadership, HR and admins only. */
type SubPlace = Readonly<{ label: string; href: string; lead?: boolean }>;
const SUBPLACES: Readonly<Record<string, readonly SubPlace[]>> = {
  "/hq": [{ label: "Feature catalogue", href: "/hq/features" }, { label: "Licences", href: "/hq/licences" }, { label: "Offer Studio", href: "/hq/offers" }, { label: "Ideas", href: "/hq/ideas" }, { label: "Brand", href: "/hq/brand" }, { label: "Stack Intelligence", href: "/stack" }, { label: "Product map", href: "/product-map" }],
  "/tasks": [{ label: "My steps", href: "/me/steps" }, { label: "Projects", href: "/tasks?view=projects" }, { label: "Team dashboard", href: "/tasks?view=team" }, { label: "Outcomes", href: "/tasks/outcomes" }, { label: "My week", href: "/my-week" }],
  "/clients": [{ label: "Client projects", href: "/projects" }, { label: "Deliveries", href: "/delivery" }, { label: "Relationships", href: "/relationships" }],
  "/people": [{ label: "Org chart", href: "/people/org" }, { label: "Designers", href: "/designers" }, { label: "Hiring", href: "/people/jobs" }, { label: "Skills", href: "/people/skills" }, { label: "People & pay", href: "/people/pay", lead: true }],
  "/me": [{ label: "My steps", href: "/me/steps" }, { label: "My work", href: "/me/work" }, { label: "Approvals", href: "/me/approvals" }, { label: "My pay", href: "/me/pay" }, { label: "Notifications", href: "/notifications" }],
  "/hr": [{ label: "Shifts", href: "/shifts" }, { label: "HR history", href: "/hr-history" }],
  "/finance": [{ label: "People cost", href: "/finance/people-cost" }, { label: "CA desk", href: "/finance/desk" }],
  "/erp": [{ label: "Documents", href: "/erp/documents" }, { label: "Catalog", href: "/erp/catalog" }, { label: "Inventory", href: "/erp/inventory" }, { label: "Templates", href: "/erp/templates" }],
  "/settings": [{ label: "Organisation", href: "/settings?tab=organisation", lead: true }, { label: "Who can sign in", href: "/settings?tab=sign-in", lead: true },
    { label: "Roles & permissions", href: "/settings?tab=roles", lead: true }, { label: "Who can do what", href: "/settings?tab=work-rules" }, { label: "Team & pods", href: "/settings?tab=team", lead: true },
    { label: "Connected accounts", href: "/settings?tab=connected", lead: true }, { label: "Devices", href: "/settings?tab=devices" }, { label: "Data health", href: "/settings?tab=data-health", lead: true },
    { label: "Desktop build", href: "/settings?tab=desktop-app", lead: true }, { label: "Brand", href: "/brand", lead: true }],
};
const LEAD_ROLES = new Set(["Organisation owner/admin", "Leadership", "HR"]);
const inSection = (section: Section, page: Page) => {
  const at = section.hrefs.findIndex((base) => page.href === base || page.href.startsWith(base + "/"));
  return at >= 0 ? at : !SECTION_HREFS.some((base) => page.href === base || page.href.startsWith(base + "/")) && page.group === section.group ? section.hrefs.length : -1;
};
function sectionsFor(pages: readonly Page[]) {
  return SECTIONS.map((section) => ({ ...section, items: pages.filter((page) => inSection(section, page) >= 0).sort((a, b) => inSection(section, a) - inSection(section, b)) }))
    .filter((section) => section.items.length > 0);
}
/** Places the search palette finds by name that are tabs of a page rather than rail entries. */
const PLACES: readonly Page[] = [
  { label: "Account", href: "/account", Icon: ShieldCheck, group: "admin", access: "all" },
  { label: "Client projects", href: "/projects", Icon: FolderKanban, group: "work", access: "work" },
  { label: "Work projects", href: "/tasks?view=projects", Icon: FolderKanban, group: "work", access: "work" },
  { label: "Team dashboard", href: "/tasks?view=team", Icon: CircleCheck, group: "work", access: "work" },
  // R46: RE projects, clients, developers, channel partners, employees and contacts, and who confirmed which link.
  { label: "Relationships", href: "/relationships", Icon: BookUser, group: "work", access: "work" },
  { label: "Who can do what", href: "/settings?tab=work-rules", Icon: Settings, group: "admin", access: "all" },
  { label: "Brand: logo, Pip and app icons", short: "Brand", href: "/brand", Icon: Palette, group: "admin", access: "all" },
  { label: "Stack Intelligence: tools, costs and stacks", short: "Stack", href: "/stack", Icon: Gem, group: "work", access: "all" },
  { label: "Product map: screens, user types and journeys of an app", short: "Product map", href: "/product-map", Icon: Workflow, group: "work", access: "all" },
  // XRAY-LINK (owner, 25 Oct 2026): tutorials and videos for every part of Pulse; also the account menu and "How do I…".
  { label: "Learn Pulse: tutorials and videos", short: "Learn", href: "/learn", Icon: GraduationCap, group: "work", access: "all" },
];

/** EST-1205: pages reached from a menu or a link, not from the rail. The top bar names them, instead of falling back to
 *  "Dashboard" (and marking it current). */
const ELSEWHERE: readonly Page[] = [
  { label: "Connect a Pulse app", href: "/connect", Icon: Settings, group: "admin", access: "all" },
  // E2E-4P: these pages are reached from the organisation menu, not the rail; without them the title said "Dashboard".
  { label: "Connections", href: "/connections", Icon: Building2, group: "work", access: "all" },
  { label: "Organisations", href: "/orgs", Icon: Building2, group: "admin", access: "all" },
  { label: "Account / Security", short: "Account", href: "/account", Icon: ShieldCheck, group: "admin", access: "all" },
  { label: "Install Pulse", href: "/apps", Icon: Settings, group: "admin", access: "all" },
  { label: "Your role briefs", short: "Role briefs", href: "/briefs", Icon: BookUser, group: "work", access: "all" },
  { label: "Pulse controls", short: "Controls", href: "/kit", Icon: Palette, group: "admin", access: "all" },
  // PULSE-HQ (0973): Stack Intelligence, for every organisation (Pulse HQ links it; the palette finds it by name).
  { label: "Stack Intelligence", short: "Stack", href: "/stack", Icon: Gem, group: "work", access: "all" },
  // MODULES-1024: these too said "Dashboard" in the top bar above their own title.
  { label: "Calls", href: "/calls", Icon: MessageCircle, group: "work", access: "all" },
  { label: "Product Story", short: "Story", href: "/story", Icon: Lightbulb, group: "work", access: "all" },
  // PRODUCT-MAP (1010): every organisation building software; reached from Product Story, Pulse HQ and the palette.
  { label: "Product map", short: "Map", href: "/product-map", Icon: Workflow, group: "work", access: "all" },
  { label: "My steps", short: "Step", href: "/steps", Icon: CircleCheck, group: "work", access: "all" },
  { label: "Quotation", href: "/quotes", Icon: ReceiptText, group: "money", access: "all" },
  { label: "Not available", href: "/hidden", Icon: ShieldCheck, group: "admin", access: "all" },
  { label: "Learn Pulse", short: "Learn", href: "/learn", Icon: GraduationCap, group: "work", access: "all" },
];

/** The role's pages without those whose module the organisation has switched off. */
function pagesFor(roleLabel: string | undefined, modulesOff: readonly string[] = []) {
  return pagesForRole(roleLabel).filter((page) => !pathSwitchedOff(page.href, modulesOff));
}

function pagesForRole(roleLabel: string | undefined) {
  if (roleLabel === 'Accountant') return allPages.filter(page => page.href === '/finance' || page.href === '/erp').map(page => page.href === '/finance' ? {...page, href: '/finance/desk'} : page);
  if (roleLabel === "Leadership") return allPages.filter(page=>page.href==="/network" || page.href==="/finance" || page.href==="/erp" || page.href==="/leadership" || page.href==="/insights" || page.href==="/hr" || page.access==="all" || page.access==="work");
  if (roleLabel === "Finance") return allPages.filter((page) => page.href === "/erp" || (page.access !== "admin" && page.access !== "hr"));
  // HR is staff too (its own day, chats, the team) and works from the HR desk (a phone tab); never clients, money or admin.
  if (roleLabel === "HR") return ["/dashboard", "/tasks", "/chats", "/hr", "/me", "/people", "/review-data", "/updates"].flatMap((href) => allPages.filter((page) => page.href === href));
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
  return pages.find((page) => under(page.href) || page.also?.some(under))
    ?? allPages.find((page) => under(page.href) || page.also?.some(under)) ?? (place ? { ...place, label: place.short ?? place.label } : pages[0]);
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
export function shellNav(roleLabel: string | undefined, modulesOff?: readonly string[], rename?: ShellRename) {
  const pages = renamed(pagesFor(roleLabel, modulesOff), rename);
  return { pages, places: placesFor(pages, rename), financeOnly: financeOnlyPages(pages) };
}
const financeOnlyPages = (pages: readonly Page[]) => pages.every((page) => page.href === '/finance/desk' || page.href === '/erp') && pages.some((page) => page.href === '/finance/desk');
/** The tabs found by name (Client projects, Team dashboard, …) for a role: the work ones only with Work on the rail. */
const placesFor = (pages: readonly Page[], rename?: ShellRename) => financeOnlyPages(pages) ? [] : renamed(PLACES, rename).filter((place) => place.access === "all" || pages.some((page) => page.href === "/tasks"));

/** Command palette: pages first, then matching projects, clients, contacts and people. ↑ ↓ move, Enter opens. Nothing scrolls: it shows the best few of each. */
function SearchPalette({ open, onClose, pages, rename }: { open: boolean; onClose: () => void; pages: readonly Page[]; rename?: ShellRename }) {
  const router = useRouter();
  const financeOnly = pages.every((page) => page.href === '/finance/desk' || page.href === '/erp') && pages.some((page) => page.href === '/finance/desk');
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<Records | null>(null);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const loading = useRef(false);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const places = financeOnly ? [] : renamed(PLACES, rename).filter((place) => place.access === "all" || pages.some((page) => page.href === "/tasks"));
    const groups: Hit[][] = [[...pages, ...(q ? places : [])].filter((page) => page.label.toLowerCase().includes(q)).slice(0, q ? 5 : 12).map((page) => ({ key: page.href, group: "Pages", label: page.label, href: page.href, Icon: page.Icon }))];
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
  }, [query, pages, records, financeOnly, rename]);
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
export function PulseShell({ identity, children, utilities, create, account, rename, org, orgName, modulesOff, externalSearch, embed, orgs }: { identity: PulseIdentity | null; children: ReactNode; utilities?: ReactNode; create?: ReactNode; account?: ReactNode; rename?: ShellRename; org?: PulseOrg | null; orgName?: string; modulesOff?: readonly string[];
  /** CHAT-SHELL: the page is shown inside the chat's side panel: the page alone, without the rail, the top bar or the
   *  phone's tabs (short confirmations still show). */ embed?: boolean;
  /** ORG: the Pulse account's organisations (the sidebar switcher and the rail's organisation tile switch between them). */ orgs?: PulseOrgs;
  /** UX-5A: the app mounts its own search palette (Ctrl+K): the shortcut and the search field send `pulse:search`
   *  instead of opening the shell's own palette. The app reads the role's pages with `shellNav()`. */ externalSearch?: boolean }) {
  const organisation = org?.name?.trim() || orgName?.trim() || "Pulse";
  // ORG: the organisation this session works in. The address's brand (`org`) can be another one (on pulse-dev it is
  // always Estate Autopilots), so its logo is used only when it is this organisation's own.
  const currentOrg = orgs?.list.find((o) => o.current)?.name ?? organisation;
  const [markFailed, setMarkFailed] = useState<string | null>(null);
  const ownMark = org?.mark && org.name?.trim() === currentOrg.trim() && markFailed !== org.mark ? org.mark : null;
  const pathname = usePathname();
  const pages = useMemo(() => renamed(pagesFor(identity?.roleLabel, modulesOff), rename), [identity?.roleLabel, rename, modulesOff]);
  const recentPages = useRecents();
  // EST-1420 P2: Recents also leave out pages under an entry the app removed (a null rename: a screen hidden from this
  // role or a company switch), except the person's own profile.
  const removed = useMemo(() => Object.entries(rename ?? {}).filter(([href, label]) => label === null && !href.includes("?")).map(([href]) => href), [rename]);
  const under = (href: string, base: string) => { const p = href.split(/[?#]/)[0]; return p === base || p.startsWith(base + "/"); };
  const recents = identity?.roleLabel === 'Accountant' ? [] : recentPages.filter((recent) => !pathSwitchedOff(recent.href, modulesOff)
    && !(removed.some((base) => under(recent.href, base)) && !(identity?.profileHref && under(recent.href, identity.profileHref))));
  const settings = identity?.roleLabel === 'Accountant' ? {...SETTINGS,href:'/account',label:'Account / Security'} : SETTINGS;
  const onSettings = [settings.href, ...(settings.also ?? [])].some((base) => pathname === base || !!pathname?.startsWith(base + "/"));
  const page = onSettings ? settings : currentPage(pathname, pages, rename);
  const tabs = useMemo(() => mobileTabs(pages), [pages]);
  // HR has no Settings in its rail, so the admin pages it may open (Review data) sit in its People section.
  const railPages = useMemo(() => identity?.roleLabel === "HR" ? pages.map((page) => page.group === "admin" ? { ...page, group: "people" as const } : page) : pages, [identity?.roleLabel, pages]);
  const sections = useMemo(() => sectionsFor(railPages), [railPages]);
  const adminPages = useMemo(() => railPages.filter((page) => page.group === "admin"), [railPages]);
  // PULSE-HQ: Stack Intelligence sits under Pulse HQ where the organisation has it (elsewhere it is reached by name).
  const activeSection = onSettings || adminPages.some((p) => p.href === page.href) ? "settings" : sections.find((s) => s.items.some((p) => p.href === page.href))?.key
    ?? (under(pathname ?? "", "/stack") && sections.some((s) => s.key === "hq") ? "hq" : "home");
  // Hovering or focusing a rail section previews its pages in the panel; leaving the sidebar returns to the page's own.
  const [peek, setPeek] = useState<string | null>(null);
  useEffect(() => { setPeek(null); }, [pathname]);
  const shown = peek ?? activeSection;
  const shownSection = shown === "settings" ? { key: "settings", label: settings.label, items: [settings, ...adminPages] } : sections.find((s) => s.key === shown) ?? sections[0];
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
  // QA-1024 (R083): a team member's More sheet holds the pages their role uses, at most MORE_CAP tiles with Settings; the
  // bottom tabs are not repeated and specialist pages (Acquisition, Runs, Sales X-Ray, Pulse HQ) wait under "All pages",
  // which opens every page the role has (nothing loses access). Owners and leadership keep the full sheet.
  const [moreAll, setMoreAll] = useState(false);
  const sheet = useMemo(() => {
    const role = identity?.roleLabel;
    if (role === "Organisation owner/admin" || role === "Leadership") return { shown: pages, rest: [] as typeof pages };
    const onTabs = new Set(tabs.map((tab) => tab.href));
    const uses = (href: string) => !SPECIALIST.includes(href) || (role === "Manager / PGS" && href === "/runs");
    const shown = pages.filter((p) => !onTabs.has(p.href) && uses(p.href)).slice(0, MORE_CAP - 1);
    return { shown, rest: pages.filter((p) => !shown.includes(p)) };
  }, [identity?.roleLabel, pages, tabs]);
  const [offline, setOffline] = useState(false);
  // EST-1198: unread chat messages for the phone's Chats tab, from the updates the app already polls (the bell's count).
  const [chatUnread, setChatUnread] = useState(0);
  const [workspaceId, setWorkspaceId] = useState("pulse-organisation");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const workspaces: PulseWorkspace[] = useMemo(() => [
    { tenant_id: "pulse-personal", name: identity?.displayName ?? "Your account", kind: "personal" },
    { tenant_id: "pulse-organisation", name: organisation, kind: "organisation" },
  ], [identity?.displayName, organisation]);

  useEffect(() => { setMoreOpen(false); }, [pathname]);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape") { setSearchOpen(false); setMoreOpen(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
  if (embed) return <ThemeProvider><main id="main-content" className={styles.embedMain} data-embed="">{children}</main><NoticeCenter /></ThemeProvider>;
  if (pathname.startsWith("/login") || pathname === "/join" || pathname === "/invited" || pathname.startsWith("/accept/") || pathname.startsWith("/offer/") || ["/portal/login","/portal/set-password","/portal/confirm-email"].includes(pathname)) return <ThemeProvider><main id="main-content">{children}</main></ThemeProvider>;
  return (
    <ThemeProvider>
      <div className={`${styles.shell} ${sidebar === "closed" ? styles.collapsed : sidebar === "auto" ? styles.autoSidebar : ""}`} data-sidebar-collapsed={collapsed} data-app-page={pathname?.startsWith("/chats") ? "" : undefined} data-has-utilities={utilities ? "true" : undefined} data-title-tucked={titleTucked ? "" : undefined}>
        <a className={styles.skip} href="#main-content">Skip to workspace</a>
        <aside className={styles.sidebar} aria-label="Pulse navigation" onMouseLeave={() => setPeek(null)}>
          {/* The rail holds the six sections; the panel beside it lists the chosen section's pages, then the page's own
              content and Recents. */}
          <div className={styles.iconStrip}>
            <div className={styles.stripTop}><div className={styles.logoSlot}>
              {/* The organisation's own mark when it has one (LAYOUT-SWEEP); Pulse's otherwise. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- a small logo served by the app itself */}
              <Link href="/" aria-label="Pulse home" title={org?.name ? `Pulse · ${org.name}` : "Pulse"} className={styles.pulseMarkLink}><PulseMark /></Link>
              {collapsed ? <button type="button" className={styles.logoExpandBtn} onClick={toggleCollapsed} aria-label="Expand sidebar navigation" aria-expanded="false" aria-controls="pulse-sidebar-panel"><PanelLeftOpen size={18} aria-hidden="true" /></button> : null}
            </div>
            {/* Owner workbench UI: the current organisation (the account's, not the address's), only in the collapsed rail
                (the open panel already shows it), as a deliberate control: its logo or its initials on its own colour. */}
            {orgs && orgs.list.length > 1 && collapsed ? <SidebarTooltip content="Switch organisation · Ctrl+Shift+O" active>
              <button type="button" className={styles.orgSwitchTile} onClick={() => window.dispatchEvent(new Event("pulse:orgs-open"))}
                data-img={ownMark ? "" : undefined} style={{ "--org-hue": orgHue(currentOrg) } as CSSProperties} aria-label={`${currentOrg}: switch organisation (Ctrl+Shift+O)`}>
                {ownMark ? <img src={ownMark} alt="" width={36} height={36} onError={() => setMarkFailed(ownMark)} /> : orgInitials(currentOrg)}
              </button></SidebarTooltip> : null}
            </div>
            <nav className={styles.stripNav} aria-label="Main sections">
              {sections.map(({ key, label, Icon, items }) => (
                <SidebarTooltip key={key} content={label} active={collapsed}>
                  <Link className={`${styles.stripBtn}${activeSection === key ? ` ${styles.stripBtnActive}` : ""}`} href={items[0].href} aria-label={label} aria-current={activeSection === key ? "page" : undefined}
                    data-peek={peek === key && activeSection !== key ? "" : undefined} onMouseEnter={() => setPeek(key)} onFocus={() => setPeek(key)}>
                    <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.stripLabel}>{label}</span>
                  </Link>
                </SidebarTooltip>
              ))}
            </nav>
            {identity?.roleLabel !== "HR" ? <div className={styles.stripBottom}>
              <SidebarTooltip content={settings.label} active={collapsed}><Link className={`${styles.stripBtn}${activeSection === "settings" ? ` ${styles.stripBtnActive}` : ""}`} href={settings.href} aria-label={settings.label} aria-current={activeSection === "settings" ? "page" : undefined}
                data-peek={peek === "settings" && activeSection !== "settings" ? "" : undefined} onMouseEnter={() => setPeek("settings")} onFocus={() => setPeek("settings")}><Settings size={19} strokeWidth={1.75} aria-hidden="true" /></Link></SidebarTooltip>
            </div> : null}
          </div>
          <div id="pulse-sidebar-panel" className={styles.panel} inert={collapsed}>
            <div className={styles.panelHeader}>
              <WorkspaceSwitcher workspaces={workspaces} currentId={workspaceId} personName={identity?.displayName ?? null} pending={false} open={switcherOpen} setOpen={setSwitcherOpen} containerRef={switcherRef} onSelect={(next) => { setWorkspaceId(next); setSwitcherOpen(false); }} orgMark={ownMark} orgs={orgs} />
              <button type="button" className={styles.collapseBtn} onClick={toggleCollapsed} aria-label="Collapse sidebar navigation" aria-expanded={!collapsed} aria-controls="pulse-sidebar-panel" title="Collapse navigation"><PanelLeftClose size={16} aria-hidden="true" /></button>
            </div>
            <div className={`${styles.searchBox} ${styles.panelSearch}`}>
              <Search size={15} className={styles.searchIcon} aria-hidden="true" />
              <input type="text" readOnly className={styles.searchInput} placeholder="Search Pulse…" aria-label="Search Pulse" onClick={openSearch} onKeyDown={searchFromField} />
              <kbd className={styles.searchKbd}>⌘K</kbd>
            </div>
            {shownSection ? <nav className={styles.sectionNav} aria-label={`${shownSection.label} pages`}>
              <p className={styles.sectionTitle}>{shownSection.label}</p>
              {shownSection.items.map(({ label, href, Icon }) => (
                <Link key={href} href={href} className={styles.sectionLink} aria-current={page.href === href ? "page" : undefined}>
                  <Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{label}</span>
                </Link>
              )).flatMap((link, i) => {
                const subs = (SUBPLACES[shownSection.items[i].href] ?? []).filter((sub) => !sub.lead || LEAD_ROLES.has(identity?.roleLabel ?? "")).filter((sub) => !pathSwitchedOff(sub.href, modulesOff));
                return subs.length ? [link, <div key={`${shownSection.items[i].href}:subs`} className={styles.sectionSubs}>{subs.map((sub) => (
                  <Link key={sub.href} href={sub.href} className={styles.sectionSub} aria-current={!sub.href.includes("?") && pathname === sub.href ? "page" : undefined}>{sub.label}</Link>
                ))}</div>] : [link];
              })}
            </nav> : null}
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
                <li className={styles.titleContext}>Pulse</li>
                <li className={styles.titleSlash} aria-hidden="true">/</li>
                <li><h1 className={styles.titleText} aria-current="page">{page.label}</h1></li>
              </ol>
            </nav>
            <div className={styles.topBarCenter} data-shell-toolbar />
            <div className={styles.topBarRight} data-shell-actions="">
              {create}
              {utilities}
              <ProfileMenu identity={identity} extra={account} />
            </div>
          </header>
          {offline ? <div className={styles.offlineNotice} role="status" aria-label="Offline status"><WifiOff size={15} aria-hidden="true" /><span>{waiting ? "You're offline. That page opens as soon as you're back online." : "You're offline. Pulse will reconnect when a network is available."}</span></div> : null}
          <main id="main-content" className={styles.main}>{children}</main>
        </div>
        {/* EST-1198: Home, Work, Chats and Me (My desk) first; the role's other pages and Settings under More. A tab's name
            starts with the word it shows ("Home (Dashboard)", "Me (My desk)"), so voice control and screen readers match it. */}
        <nav className={styles.bottomNav} aria-label="Mobile navigation">
          {tabs.map(({ label, short, href, Icon }) => { const unread = href === "/chats" ? chatUnread : 0; const name = short && short !== label ? `${short} (${label})` : label; return <Link key={href} className={styles.bottomLink} href={href} aria-label={unread ? `${name}, ${unread} unread` : name} aria-current={page.href === href ? "page" : undefined}><Icon size={19} strokeWidth={1.75} aria-hidden="true" /><span>{short ?? label}</span>{unread ? <i className={styles.bottomBadge} aria-hidden="true">{unread > 99 ? "99+" : unread}</i> : null}</Link>; })}
          {pages.length > tabs.length ? <button type="button" className={styles.bottomLink} aria-haspopup="dialog" aria-expanded={moreOpen} aria-current={onSettings || !tabs.some((p) => p.href === page.href) ? "page" : undefined} onClick={() => { setMoreAll(false); setMoreOpen((value) => !value); }}><Ellipsis size={19} strokeWidth={1.75} aria-hidden="true" /><span>More</span></button> : null}
        </nav>
        {moreOpen ? (
          <div className={styles.moreBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setMoreOpen(false); }}>
            <section className={styles.moreSheet} role="dialog" aria-modal="true" aria-label="All pages">
              {/* eslint-disable-next-line @next/next/no-img-element -- a small logo served by the app itself */}
              <div className={styles.moreHead}>{org?.logo ? <span className={styles.orgLogo}><img className={styles.orgLogoLight} src={org.logo} alt={organisation} height={24} /><img className={styles.orgLogoDark} src={org.logoDark ?? org.logo} alt="" aria-hidden="true" height={24} /></span> : <span>{organisation}</span>}<button type="button" className={styles.moreClose} aria-label="Close" onClick={() => setMoreOpen(false)}><X size={16} aria-hidden="true" /></button></div>
              {/* MOBILE-QA: a phone has no sidebar search field and no Ctrl+K, so the sheet carries the way into search. */}
              <button type="button" className={styles.moreSearch} onClick={() => { setMoreOpen(false); openSearch(); }}><Search size={16} strokeWidth={1.75} aria-hidden="true" /><span>Search Pulse…</span></button>
              <nav className={styles.moreGrid} aria-label="All pages">
                {[...sheet.shown, ...(moreAll ? sheet.rest : [])].map(({ label, href, Icon }) => <Link key={href} href={href} className={styles.moreItem} aria-current={page.href === href ? "page" : undefined} onClick={() => setMoreOpen(false)}><Icon size={18} strokeWidth={1.75} aria-hidden="true" /><span>{label}</span></Link>)}
                <Link href={settings.href} className={styles.moreItem} aria-current={onSettings ? "page" : undefined} onClick={() => setMoreOpen(false)}><Settings size={18} strokeWidth={1.75} aria-hidden="true" /><span>{settings.label}</span></Link>
                {sheet.rest.length && !moreAll ? <button type="button" className={`${styles.moreItem} ${styles.moreAll}`} onClick={() => setMoreAll(true)}><LayoutGrid size={18} strokeWidth={1.75} aria-hidden="true" /><span>All pages</span></button> : null}
              </nav>
              {recents.length ? <><p className={styles.moreLabel}>Recents</p><div className={styles.moreRecents}>{recents.slice(0, 4).map((recent) => { const Icon = recentIcon(recent.kind); return <Link key={recent.href} href={recent.href} className={styles.recentItem} onClick={() => setMoreOpen(false)}><Icon size={15} strokeWidth={1.75} className={styles.recentIcon} aria-hidden="true" /><span className={styles.recentName}>{recent.title}</span><span className={styles.recentDate}>{recentAge(recent.at)}</span></Link>; })}</div></> : null}
            </section>
          </div>
        ) : null}
        {externalSearch ? null : <SearchPalette pages={pages} rename={rename} open={searchOpen} onClose={() => setSearchOpen(false)} />}
        <NoticeCenter />
      </div>
    </ThemeProvider>
  );
}
