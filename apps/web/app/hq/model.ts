// PULSE-HQ (owner, 23 Oct 2026): the business of Pulse, run in Pulse. Types and words shared by every Pulse HQ page.
import {
  Activity, ArrowLeftRight, Award, BadgeCheck, Banknote, Bell, BellRing, BookUser, Bot, Briefcase, BriefcaseBusiness, Brush, Building, Building2, Cable,
  Calculator, CalendarCheck, CalendarRange, Camera, ChartColumn, ChartGantt, Chrome, CircleCheck, CirclePlus, Clapperboard, ClipboardList, Code, Crosshair,
  DatabaseZap, DoorOpen, Download, EyeOff, Factory, FileClock, FileInput, FileLock, FileText, Film, Fingerprint, FlaskConical, FolderKanban, Gauge, GitBranch,
  Globe, GraduationCap, Handshake, HardDrive, House, IdCard, Import, Inbox, KeyRound, Landmark, LayoutTemplate, Library, Lightbulb, ListChecks, LogIn, Mail,
  Map as MapIcon, MapPinned, Megaphone, Merge, MessageCircle, MessageSquareShare, MessageSquareText, MessagesSquare, Mic, Monitor, Navigation, Network, Newspaper,
  Package, Palette, PanelRight, PanelsTopLeft, PenLine, Phone, PhoneCall, PhoneForwarded, PiggyBank, PlugZap, Radar, ReceiptText, Repeat, Rocket, Scale,
  ScanSearch, ScrollText, Search, Server, Settings, Share2, ShieldCheck, Smartphone, Smile, Sparkles, SquareTerminal, Star, Target, Terminal, ToggleRight,
  TrendingUp, Truck, Unplug, UserPlus, UserSearch, Users, Wallet, Wand, Webhook, Workflow, type LucideIcon,
} from "lucide-react";

export type Category = "home" | "work" | "flows" | "chats" | "people" | "finance" | "clients" | "creative" | "xray" | "network" | "apps" | "admin" | "platform";
export type FeatureStatus = "live" | "beta" | "building" | "idea";
export type IdeaStatus = "new" | "exploring" | "planned" | "building" | "shipped" | "parked";
export type OfferStatus = "draft" | "testing" | "ready" | "retired";
export type Billing = "month" | "year" | "once" | "seat-month";

export type Feature = { id: string; key: string; category: Category; name: string; promise: string; what: string; who: string; status: FeatureStatus; icon: string;
  proof: string; href?: string | null; screenshot?: string | null; sort: number; draft?: boolean; archived?: boolean; updatedAt?: string; ownerId?: string | null; owner?: string | null };
export type Idea = { id: string; title: string; problem: string; forWhom: string; impact: number; effort: number; status: IdeaStatus; featureKeys: string[];
  featureId: string | null; draft: boolean; createdAt: string; by: string | null; byId?: string | null; votes: number; voted: boolean;
  sort?: number; area?: Category | null; ownerId?: string | null; owner?: string | null; details?: string };
export type Bonus = { name: string; value: number; why: string };
export type Anchor = { label: string; amount: number };
export type Problem = { problem: string; solution: string; features: string[] };
export type Tier = { key: string; name: string; price: number | null; blurb: string; seats: number | null; highlight: boolean; features: string[] };
export type Naming = { magnet: string; avatar: string; goal: string; interval: string; container: string; tagline: string };
export type Offer = { id: string; name: string; status: OfferStatus; icp: string; dreamOutcome: string; dream: number; likelihood: number; time: number; effort: number;
  deliverables: string[]; bonuses: Bonus[]; guarantee: string; scarcity: string; urgency: string; naming: Naming; anchors: Anchor[]; currency: string; price: number | null;
  billing: Billing; positioning: string; brandNotes: string; tiers: Tier[]; problems: Problem[]; delivery: string[]; accent: string; sort: number; draft: boolean; updatedAt: string; value: number };
export type Brand = { tagline: string; oneLiner: string; category: string; forWho: string; against: string; promise: string; pillars: string[]; proof: string[];
  voice: string; pricing: string; colours: string[]; draft: boolean };
export type BrandVersion = { id: string; savedAt: string; by: string | null; body: Brand };
export type Person = { id: string; name: string };
export type Hq = { canEdit: boolean; features: Feature[]; ideas: Idea[]; offers: Offer[]; brand: Brand | null; brandUpdatedAt: string | null; brandVersions?: BrandVersion[];
  people?: Person[]; me?: string | null };

export const CATEGORIES: readonly { key: Category; label: string; blurb: string; Icon: LucideIcon; hue: number }[] = [
  { key: "home", label: "Home & daily focus", blurb: "Each person's starting page: today's priorities, updates and a search for everything.", Icon: House, hue: 262 },
  { key: "work", label: "Work & tasks", blurb: "Tasks, projects and reviews, so everyone knows what to do and what got done.", Icon: CircleCheck, hue: 215 },
  { key: "flows", label: "Processes", blurb: "Write down how your company works once, then run it step by step on every job.", Icon: Workflow, hue: 190 },
  { key: "chats", label: "Chat, calls & AI helpers", blurb: "Team chat, voice and video calls, Pip the assistant and AI team members.", Icon: MessageCircle, hue: 160 },
  { key: "people", label: "People & HR", blurb: "Team profiles, automatic attendance, leave, onboarding, pay and payroll.", Icon: Users, hue: 140 },
  { key: "finance", label: "Money & billing", blurb: "Cash, invoices, quotes, expenses and a read-only desk for your accountant.", Icon: Wallet, hue: 95 },
  { key: "clients", label: "Clients & sales", blurb: "Clients, contacts, enquiries, site visits, a client portal and delivery.", Icon: Building2, hue: 45 },
  { key: "creative", label: "Creative work", blurb: "Creative sprints, each designer's output, asset tracking and video review.", Icon: Lightbulb, hue: 25 },
  { key: "xray", label: "Sales X-Ray", blurb: "Every sales call analysed, searchable and usable inside your processes.", Icon: PlugZap, hue: 5 },
  { key: "network", label: "Many organisations", blurb: "One account across companies, freelancers and clients, and your own Pulse.", Icon: Network, hue: 330 },
  { key: "apps", label: "Phone & desktop apps", blurb: "Pulse on Android, the desktop and the browser, with alerts everywhere.", Icon: Smartphone, hue: 300 },
  { key: "admin", label: "Admin & security", blurb: "Who can see what, sign-in, the audit trail, protected personal data and setup.", Icon: ShieldCheck, hue: 235 },
  { key: "platform", label: "Connections & API", blurb: "Connect your other tools and Google Drive, or run Pulse on your own server.", Icon: Cable, hue: 200 },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c])) as Record<Category, (typeof CATEGORIES)[number]>;

export const FEATURE_STATUS: readonly { key: FeatureStatus; label: string; hint: string; tone: string }[] = [
  { key: "live", label: "Live", hint: "Shipped and on", tone: "var(--good)" },
  { key: "beta", label: "Beta", hint: "Behind a switch or in preview", tone: "var(--info)" },
  { key: "building", label: "Building", hint: "In an active lane", tone: "var(--warn)" },
  { key: "idea", label: "Idea", hint: "Planned, not built", tone: "var(--accent)" },
];
export const IDEA_STATUS: readonly { key: IdeaStatus; label: string; tone: string }[] = [
  { key: "new", label: "New", tone: "var(--accent)" }, { key: "exploring", label: "Exploring", tone: "var(--info)" }, { key: "planned", label: "Planned", tone: "#0f9d9a" },
  { key: "building", label: "Building", tone: "var(--warn)" }, { key: "shipped", label: "Shipped", tone: "var(--good)" }, { key: "parked", label: "Parked", tone: "var(--faint)" },
];
export const OFFER_STATUS: readonly { key: OfferStatus; label: string }[] = [
  { key: "draft", label: "Draft" }, { key: "testing", label: "Testing" }, { key: "ready", label: "Ready" }, { key: "retired", label: "Retired" },
];
export const BILLING: readonly { key: Billing; label: string; per: string }[] = [
  { key: "month", label: "Per month", per: "/month" }, { key: "year", label: "Per year", per: "/year" },
  { key: "once", label: "One-off", per: "" }, { key: "seat-month", label: "Per seat per month", per: "/seat/month" },
];

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowLeftRight, Award, BadgeCheck, Banknote, Bell, BellRing, BookUser, Bot, Briefcase, BriefcaseBusiness, Brush, Building, Building2, Cable,
  Calculator, CalendarCheck, CalendarRange, Camera, ChartColumn, ChartGantt, Chrome, CircleCheck, CirclePlus, Clapperboard, ClipboardList, Code, Crosshair,
  DatabaseZap, DoorOpen, Download, EyeOff, Factory, FileClock, FileInput, FileLock, FileText, Film, Fingerprint, FlaskConical, FolderKanban, Gauge, GitBranch,
  Globe, GraduationCap, Handshake, HardDrive, House, IdCard, Import, Inbox, KeyRound, Landmark, LayoutTemplate, Library, Lightbulb, ListChecks, LogIn, Mail,
  Map: MapIcon, MapPinned, Megaphone, Merge, MessageCircle, MessageSquareShare, MessageSquareText, MessagesSquare, Mic, Monitor, Navigation, Network, Newspaper,
  Package, Palette, PanelRight, PanelsTopLeft, PenLine, Phone, PhoneCall, PhoneForwarded, PiggyBank, PlugZap, Radar, ReceiptText, Repeat, Rocket, Scale,
  ScanSearch, ScrollText, Search, Server, Settings, Share2, ShieldCheck, Smartphone, Smile, Sparkles, SquareTerminal, Star, Target, Terminal, ToggleRight,
  TrendingUp, Truck, Unplug, UserPlus, UserSearch, Users, Wallet, Wand, Webhook, Workflow,
};
export const ICON_NAMES = Object.keys(ICONS).sort();
export const iconFor = (name: string): LucideIcon => ICONS[name] ?? Sparkles;

/** Hormozi's value equation: (dream outcome × perceived likelihood) ÷ (time delay × effort and sacrifice), each 1–10. */
export const valueScore = (o: { dream: number; likelihood: number; time: number; effort: number }) =>
  Math.round((o.dream * o.likelihood) / Math.max(1, o.time * o.effort) * 100) / 100;
/** Where a value score sits: 100 is the ceiling (10 × 10 ÷ 1 × 1), 1 is break-even. A log scale reads it honestly. */
export const valueShare = (v: number) => Math.max(0, Math.min(1, Math.log10(Math.max(0.01, v) * 100) / 4));
export const valueWord = (v: number) => v >= 12 ? "Irresistible" : v >= 6 ? "Strong" : v >= 3 ? "Promising" : v >= 1.2 ? "Thin" : "Weak";

/** The idea board's priority: impact over effort, lifted by votes. */
export const priority = (i: { impact: number; effort: number; votes: number }) => Math.round((i.impact / Math.max(1, i.effort)) * (1 + i.votes / 5) * 10) / 10;

export function money(amount: number | null | undefined, currency = "INR", compact = false) {
  if (amount === null || amount === undefined) return "Custom";
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, maximumFractionDigits: 0, notation: compact ? "compact" : "standard" }).format(amount);
  } catch { return `${currency} ${Math.round(amount).toLocaleString("en-IN")}`; }
}
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const per = (billing: Billing) => BILLING.find((b) => b.key === billing)?.per ?? "";

/** MAGIC naming (Hormozi): Magnet, Avatar, Goal, Interval, Container. A few ways to put the parts together. */
export function nameIdeas(n: Naming): string[] {
  const parts = [n.magnet, n.avatar, n.goal, n.interval, n.container].map((s) => s.trim());
  const [magnet, avatar, goal, interval, container] = parts;
  const out = [
    [avatar, magnet].filter(Boolean).join(" "),
    [magnet, avatar, container].filter(Boolean).join(" "),
    [avatar, container].filter(Boolean).join(" ") + (goal ? `: ${goal}` : ""),
    goal && interval ? `${goal} ${interval}` : "",
    [interval ? interval.replace(/^in\s+/i, "").replace(/^\w/, (c) => c.toUpperCase()) : "", avatar, container].filter(Boolean).join(" "),
  ];
  return [...new Set(out.map((s) => s.trim()).filter((s) => s.length > 2))].slice(0, 5);
}

/** Every bonus's stated value and the price anchors, against the price: the "value stack". */
export const stackValue = (o: Pick<Offer, "bonuses">) => o.bonuses.reduce((sum, b) => sum + (Number(b.value) || 0), 0);

/** The lowest price an offer starts from: its tiers' prices and its own; null when every one is custom. */
export function fromPrice(o: Pick<Offer, "tiers" | "price">) {
  const prices = o.tiers.map((t) => t.price).filter((p): p is number => typeof p === "number");
  if (typeof o.price === "number") prices.push(o.price);
  return prices.length ? Math.min(...prices) : null;
}

/** Who a feature is for, as a few plain groups a buyer recognises (read from its "who" line). */
export const AUDIENCES: readonly { key: string; label: string; test: RegExp }[] = [
  { key: "everyone", label: "Everyone", test: /every|all staff|employee|team member|anyone|staff|people|colleague/i },
  { key: "leaders", label: "Owners & leaders", test: /owner|leader|founder|manag|admin|director|head/i },
  { key: "hr", label: "HR", test: /HR|human|people team|recruit|hiring/i },
  { key: "finance", label: "Finance", test: /financ|account|CA|billing|payroll/i },
  { key: "sales", label: "Sales & growth", test: /sales|marketing|growth|acquisition/i },
  { key: "clients", label: "Clients", test: /client|customer/i },
  { key: "field", label: "Field teams", test: /field|site|install/i },
  { key: "creative", label: "Creative teams", test: /creative|design|editor|video|strateg/i },
  { key: "builders", label: "IT & developers", test: /develop|IT|integrat|engineer|builder|partner|install/i },
];
export const audiencesOf = (who: string) => AUDIENCES.filter((a) => a.test.test(who)).map((a) => a.key);

/** The first page of the product a feature's proof names (never an API address), to open it. */
export function whereLink(proof: string): string | null {
  for (const m of proof.matchAll(/(?:^|[\s,;(])(\/[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*)(?=$|[\s,;).])/gi)) {
    const path = m[1];
    if (!/^\/(api|v1|v0|healthz)(\/|$)/i.test(path)) return path;
  }
  return null;
}
export const STATUS_ORDER: Record<FeatureStatus, number> = { live: 0, beta: 1, building: 2, idea: 3 };
