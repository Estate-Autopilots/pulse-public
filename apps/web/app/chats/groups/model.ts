// GROUPS-HUB: the hub's data, labels, filters, facets and sort (pure; the screen is hub.tsx).
export type AgentInGroup = { id: string; name: string; role: "observer" | "assistant" | "coordinator" | "profile" };
export type Group = {
  id: string; name: string; channelKind: string; createdAt: string; member: boolean; myRole: string | null; members: number; clientSide: number;
  memberIds: string[]; agents: AgentInGroup[]; lastAt: string | null; lastLiveAt: string | null; messages7: number; messages30: number; messages: number;
  unread: number; waitingSince: string | null; waitingWho: string | null; imported: number; importedFirst: string | null; importedLast: string | null;
  unmapped: number; suggestions: number; openTasks: number; files: number; archivedByMe: boolean; preview: string | null;
  kind: Kind | null; segments: string[]; services: string[]; clientId: string | null; client: string | null; projectId: string | null; project: string | null;
  pod: string | null; area: string | null; city: string | null; period: string | null; status: Status; statusSet: boolean; ownerId: string | null; owner: string | null;
  tags: string[]; health: "good" | "watch" | "at_risk" | null; sentiment: number | null; healthNote: string | null;
  parsed: { raw?: string; pod?: number | null; project?: string | null; client?: string | null; area?: string | null; month?: string | null; segments?: string[]; services?: string[]; match?: { project?: { name: string; score: number } | null; client?: { name: string; score: number } | null } } | null;
  manual: string[];
  stage: string | null;
  insight: { stages?: string[]; teamMin?: number; clientMin?: number; daysToLive?: number; revisions?: number; signals?: Record<string, number>; sentiment?: number } | null;
};
export type Agent = { id: string; name: string; employeeId: string | null; title: string; runtimeState: string; username: string | null };
export type Person = { id: string; name: string; pod: string | null; username: string | null };
export type View = { id: string; name: string; query: Partial<Filters> & { sort?: Sort }; shared: boolean; mine: boolean };
export type Contact = { id: string; name: string; client: string | null };
export type HubData = { groups: Group[]; agents: Agent[]; people: Person[]; contacts: Contact[]; clients: { id: string; name: string }[]; projects: { id: string; name: string; clientId: string | null; status: string }[]; views: View[]; viewer: string; canLead: boolean };
export type Kind = "client" | "pod" | "team" | "internal" | "vendor" | "other";
export type Status = "active" | "quiet" | "closed" | "archived";
export type Sort = "activity" | "waiting" | "name" | "period" | "members" | "unread" | "messages" | "review";

export const KIND: Record<Kind, string> = { client: "Client project", pod: "Pod", team: "Team", internal: "Internal", vendor: "Vendor", other: "Other" };
export const STATUS: Record<Status, string> = { active: "Active", quiet: "Quiet", closed: "Closed", archived: "Archived" };
export const SEGMENT: Record<string, string> = { residential: "Residential", plotting: "Plotting", luxury: "Luxury", commercial: "Commercial", mid: "Mid-segment" };
export const SERVICE: Record<string, string> = { marketing: "Marketing", reels: "Reels", leads: "Leads", ads: "Ads", video_shoot: "Video shoot", photo_shoot: "Photo shoot",
  cross_selling: "Cross-selling", pre_launch: "Pre-launch", generic_ad: "Generic ad", web: "Website", branding: "Branding", gmb: "Google profile", seo: "SEO" };
export const ROLE: Record<string, { label: string; hint: string }> = {
  observer: { label: "Observer", hint: "Reads the group and summarises it when asked. Never posts." },
  assistant: { label: "Assistant", hint: "Answers when someone @mentions it or replies to it." },
  coordinator: { label: "Coordinator", hint: "Follows the whole group and follows up on tasks and approvals, asking first." },
  profile: { label: "Member", hint: "In the group; it follows its profile's settings." },
};
export const HEALTH: Record<string, string> = { good: "Healthy", watch: "Watch", at_risk: "At risk" };
export const STAGE: Record<string, string> = { onboarding: "Onboarding", brief: "Brief", shoot: "Shoot", creative: "Creative", revision: "Revisions", approval: "Approval",
  live: "Campaign live", leads: "Leads", payment: "Payment", quiet: "Gone quiet" };
export const SIGNAL: Record<string, string> = { complaint: "Complaints", churn_risk: "Churn risk", upsell: "Upsell", renewal: "Renewal", referral: "Referral", payment: "Payment",
  invoice: "Invoice", quotation: "Quotation", approval: "Approvals", delay: "Delays", lead_quality: "Lead quality" };
export const QUICK = [
  { key: "waiting", label: "Waiting on us", hint: "A client wrote last and nobody from the team answered yet" },
  { key: "unread", label: "Unread", hint: "Groups you are in with messages you have not read" },
  { key: "mine", label: "My groups", hint: "Groups you are a member of" },
  { key: "imported", label: "Imported from WhatsApp", hint: "Groups with history brought in from WhatsApp" },
  { key: "unlinked", label: "Not linked", hint: "Client groups without a client or a project yet" },
  { key: "review", label: "To review", hint: "Suggestions or unknown senders waiting for a person" },
  { key: "noai", label: "No AI employee", hint: "Client groups no AI employee is in" },
] as const;
export type Quick = typeof QUICK[number]["key"];

export type Filters = { q: string; quick: Quick[]; kinds: string[]; statuses: string[]; segments: string[]; services: string[]; pods: string[]; areas: string[];
  years: string[]; owners: string[]; agents: string[]; health: string[]; stages: string[]; tags: string[] };
export const NO_FILTERS: Filters = { q: "", quick: [], kinds: [], statuses: [], segments: [], services: [], pods: [], areas: [], years: [], owners: [], agents: [], health: [], stages: [], tags: [] };
export type FacetKey = Exclude<keyof Filters, "q" | "quick">;
export const FACETS: { key: FacetKey; label: string }[] = [
  { key: "kinds", label: "Type" }, { key: "statuses", label: "Status" }, { key: "segments", label: "Segment" }, { key: "services", label: "Service" },
  { key: "pods", label: "Pod" }, { key: "areas", label: "Area or city" }, { key: "years", label: "Started" }, { key: "owners", label: "Owner" },
  { key: "agents", label: "AI employees" }, { key: "health", label: "Health" }, { key: "stages", label: "Stage (from WhatsApp)" }, { key: "tags", label: "Tags" },
];
const NONE = "—";
/** The values a group has for a facet (a group can have several segments, services, AI employees, tags). */
export function facetValues(g: Group, key: FacetKey): string[] {
  switch (key) {
    case "kinds": return [g.kind ?? "other"];
    case "statuses": return [g.status];
    case "segments": return g.segments.length ? g.segments : [NONE];
    case "services": return g.services.length ? g.services : [NONE];
    case "pods": return [g.pod ?? NONE];
    case "areas": return [g.city && g.city !== "Pune" ? g.city : g.area ?? g.city ?? NONE];
    case "years": return [g.period ? g.period.slice(0, 4) : (g.importedFirst ?? g.createdAt ?? "").slice(0, 4) || NONE];
    case "owners": return [g.owner ?? NONE];
    case "agents": return g.agents.length ? g.agents.map((a) => a.name) : [NONE];
    case "health": return [g.health ?? NONE];
    case "stages": return [g.stage ?? NONE];
    case "tags": return g.tags.length ? g.tags : [NONE];
  }
}
export function facetLabel(key: FacetKey, v: string): string {
  if (v === NONE) return key === "agents" ? "None" : key === "owners" ? "No owner" : "Not set";
  if (key === "kinds") return KIND[v as Kind] ?? v;
  if (key === "statuses") return STATUS[v as Status] ?? v;
  if (key === "segments") return SEGMENT[v] ?? v;
  if (key === "services") return SERVICE[v] ?? v;
  if (key === "health") return HEALTH[v] ?? v;
  if (key === "stages") return STAGE[v] ?? v;
  return v;
}

export function quickMatch(g: Group, q: Quick, viewer: string): boolean {
  switch (q) {
    case "waiting": return !!g.waitingSince;
    case "unread": return g.unread > 0;
    case "mine": return g.member;
    case "imported": return g.imported > 0;
    case "unlinked": return (g.kind ?? "client") === "client" && (!g.clientId || !g.projectId);
    case "review": return g.suggestions > 0 || g.unmapped > 0;
    case "noai": return (g.kind === "client") && !g.agents.length;
  }
  return !!viewer;
}

/** Words of a group that a search matches: its name and everything the hub knows about it. */
export function haystack(g: Group, names: Map<string, string>): string {
  return [g.name, g.client, g.project, g.area, g.city, g.pod, g.owner, g.waitingWho, ...g.tags, ...g.segments.map((s) => SEGMENT[s] ?? s), ...g.services.map((s) => SERVICE[s] ?? s),
    ...g.agents.map((a) => a.name), ...g.memberIds.map((id) => names.get(id) ?? ""), g.kind ? KIND[g.kind] : "", g.period ?? ""].filter(Boolean).join(" ").toLowerCase();
}
export const words = (q: string) => q.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);

export function applyFilters(groups: Group[], f: Filters, viewer: string, hay: Map<string, string>, textHits: Map<string, number> | null, except?: FacetKey): Group[] {
  const ws = words(f.q);
  return groups.filter((g) => {
    if (!f.statuses.length && g.status === "archived" && except !== "statuses") return false; // archived only when asked for
    for (const q of f.quick) if (!quickMatch(g, q, viewer)) return false;
    for (const { key } of FACETS) {
      if (key === except) continue;
      const want = f[key]; if (!want.length) continue;
      if (!facetValues(g, key).some((v) => want.includes(v))) return false;
    }
    if (ws.length) {
      const h = hay.get(g.id) ?? "";
      if (!ws.every((w) => h.includes(w)) && !(textHits?.has(g.id))) return false;
    }
    return true;
  });
}

export function facetCounts(groups: Group[], f: Filters, viewer: string, hay: Map<string, string>, textHits: Map<string, number> | null, key: FacetKey) {
  const counts = new Map<string, number>();
  for (const g of applyFilters(groups, f, viewer, hay, textHits, key)) for (const v of new Set(facetValues(g, key))) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const v of f[key]) if (!counts.has(v)) counts.set(v, 0);
  return [...counts.entries()].sort((a, b) => (a[0] === NONE ? 1 : 0) - (b[0] === NONE ? 1 : 0) || b[1] - a[1] || a[0].localeCompare(b[0]));
}

const t = (s: string | null) => (s ? new Date(s).getTime() : 0);
export function sortGroups(list: Group[], sort: Sort, textHits: Map<string, number> | null): Group[] {
  const by: Record<Sort, (a: Group, b: Group) => number> = {
    activity: (a, b) => t(b.lastAt) - t(a.lastAt),
    waiting: (a, b) => (a.waitingSince ? 0 : 1) - (b.waitingSince ? 0 : 1) || t(a.waitingSince) - t(b.waitingSince) || t(b.lastAt) - t(a.lastAt),
    name: (a, b) => a.name.localeCompare(b.name),
    period: (a, b) => (b.period ?? "").localeCompare(a.period ?? "") || t(b.lastAt) - t(a.lastAt),
    members: (a, b) => b.members - a.members,
    unread: (a, b) => b.unread - a.unread || t(b.lastAt) - t(a.lastAt),
    messages: (a, b) => b.messages30 - a.messages30 || b.messages - a.messages,
    review: (a, b) => (b.suggestions + b.unmapped) - (a.suggestions + a.unmapped),
  };
  const out = [...list].sort(by[sort]);
  if (textHits?.size) out.sort((a, b) => (textHits.get(b.id) ?? 0) - (textHits.get(a.id) ?? 0));
  return out;
}
export const SORTS: { value: Sort; label: string }[] = [
  { value: "activity", label: "Last activity" }, { value: "waiting", label: "Waiting longest" }, { value: "unread", label: "Unread first" },
  { value: "messages", label: "Busiest (30 days)" }, { value: "period", label: "Newest period" }, { value: "name", label: "Name" },
  { value: "members", label: "Most members" }, { value: "review", label: "Most to review" },
];

export function ago(at: string | null, now = Date.now()): string {
  if (!at) return "No messages";
  const m = Math.round((now - new Date(at).getTime()) / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 14) return `${d} d ago`;
  const w = Math.round(d / 7); if (w < 9) return `${w} wk ago`;
  return new Date(at).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}
export function monthLabel(p: string | null): string {
  if (!p) return "";
  const [y, m] = p.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}
/** The URL of a saved state (filters and sort), and back. */
export function toQuery(f: Filters, sort: Sort): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.quick.length) p.set("quick", f.quick.join(","));
  for (const { key } of FACETS) if (f[key].length) p.set(key, f[key].join("|"));
  if (sort !== "activity") p.set("sort", sort);
  return p.toString();
}
export function fromQuery(s: URLSearchParams): { filters: Filters; sort: Sort } {
  const f: Filters = { ...NO_FILTERS, q: s.get("q") ?? "", quick: (s.get("quick")?.split(",").filter((x) => QUICK.some((q) => q.key === x)) ?? []) as Quick[] };
  for (const { key } of FACETS) f[key] = s.get(key)?.split("|").filter(Boolean) ?? [];
  const sort = (SORTS.some((x) => x.value === s.get("sort")) ? s.get("sort") : "activity") as Sort;
  return { filters: f, sort };
}

/** A group's name as people read it: bars become dots, an all-lower-case name gets capitals (codes stay as written). */
export function displayName(name: string): string {
  let n = name.replace(/\s*\|\s*/g, " · ").replace(/\s+/g, " ").trim();
  if (!/[A-Z]/.test(n)) n = n.replace(/\b([a-z])([a-z]*)/g, (_, a: string, b: string) => (/^(r|p|l|c|m|sp|lux|mr|mrs|miss|dr|ms)$/.test(a + b) && !/^(mr|mrs|miss|dr|ms)$/.test(a + b) ? (a + b).toUpperCase().replace("LUX", "Lux") : a.toUpperCase() + b));
  return n;
}
