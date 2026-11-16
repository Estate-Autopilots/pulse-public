// PRODUCT-MAP: the Product map's types and words (services/api/src/product-map.ts, migration 1010).
export type Evidence = { kind: string; ref: string; text: string };
export type Use = { views: number; people: number; sessions: number; p75Ms: number | null; errors: number } | null;
export type Screen = { id: string; key: string; route: string; title: string; purpose: string; area: string; access: string[]; proposed: boolean; status: "live" | "proposed" | "removed"; sources: string[]; use: Use; file: string | null; shot: boolean };
export type Element = { id: string; screenId: string; kind: string; label: string; target: string; destructive: boolean; proposed: boolean; noHandler: boolean };
export type Edge = { from: string; to: string; kind: string; label: string; count: number; medianMs: number | null };
export type Feature = { id: string; key: string; name: string; description: string; screens: string[]; proposed: boolean; origin: string };
export type Persona = { id: string; key: string; name: string; role: string; description: string; goals: string[]; ageGroup: string; skillLevel: string; techComfort: string; frequency: string; device: string;
  permissions: string[]; features: string[]; evidence: Evidence[]; confidence: number | null; origin: string };
export type Step = { screen: string; action: string; element: string; expected: string; proposed?: boolean; note?: string };
export type Journey = { id: string; key: string; personaKey: string; title: string; goal: string; status: JourneyStatus; steps: Step[]; evidence: Evidence[]; confidence: number | null;
  usage: { sessions?: number; people?: number; medianMs?: number | null }; origin: string; priority: string; acceptance: string[]; targetVersionId: string | null; byId: string | null; by: string | null; updatedAt: string };
export type JourneyStatus = "discovered" | "auto" | "drafted" | "planned" | "shipped";
export type Issue = { id: string; kind: string; severity: "high" | "medium" | "low"; title: string; detail: string; screenKey: string; journeyKey: string; evidence: Evidence[]; confidence: number | null; origin: string; status: string };
export type Idea = { id: string; title: string; body: string; kind: string; screens: string[]; personaKey: string; journeyKey: string; issueId: string | null; priority: string; status: string; targetVersionId: string | null;
  origin: string; createdAt: string; byId: string | null; by: string | null; votes: number; voted: boolean };
export type Comment = { id: string; ideaId: string; body: string; createdAt: string; by: string | null };
export type Source = { id: string; kind: SourceKind; label: string; config: Record<string, unknown>; status: string; lastRunAt: string | null; lastResult: Record<string, unknown>; hasSecret: boolean };
export type SourceKind = "repo" | "crawl" | "manifest" | "telemetry" | "push";
export type Token = { id: string; name: string; canPush: boolean; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type AiJob = { id: string; status: string; engine: string | null; tokensIn: number | null; tokensOut: number | null; error: string | null; createdAt: string; finishedAt: string | null; counts: Record<string, number> | null };
export type Version = { id: string; label: string; title: string; stage: string; releasedOn: string | null };
export type ProductSummary = { id: string; name: string; blurb: string; screens: number; journeys: number; personas: number; issues: number; ideas: number; sourceKinds: string[]; lastRunAt: string | null };
export type ListData = { canRemove: boolean; products: ProductSummary[]; repos: string[]; crawl: boolean };
export type MapData = { canRemove: boolean; me: string | null; product: { id: string; name: string; blurb: string }; screens: Screen[]; elements: Element[]; edges: Edge[]; features: Feature[]; personas: Persona[];
  journeys: Journey[]; issues: Issue[]; ideas: Idea[]; comments: Comment[]; sources: Source[]; tokens: Token[]; aiJobs: AiJob[]; versions: Version[]; repos: string[]; crawl: boolean };

export const TABS = [
  { key: "overview", label: "Overview" }, { key: "screens", label: "Screens" }, { key: "features", label: "Features" }, { key: "users", label: "User types" },
  { key: "journeys", label: "Journeys" }, { key: "issues", label: "Issues" }, { key: "ideas", label: "Ideas" }, { key: "build", label: "Build & agents" },
] as const;
export type Tab = typeof TABS[number]["key"];

export const SOURCE_INFO: Record<SourceKind, { label: string; what: string }> = {
  repo: { label: "Read its code", what: "Pulse reads a checkout of the app on this server: every route becomes a screen with its buttons, tabs, links, forms and who may open it." },
  crawl: { label: "Visit it live", what: "Pulse opens the app with a test account you give, page by page within a budget, and keeps what each screen shows and a screenshot. It never clicks or submits anything." },
  manifest: { label: "Read its manifest", what: "The app publishes /.well-known/pulse-product-map.json (or any https address) describing its screens; Pulse reads it." },
  telemetry: { label: "Real use (Pulse telemetry)", what: "For apps that send Pulse telemetry (Pulse itself): which screens people open, the paths they walk, how fast each screen shows." },
  push: { label: "Push from the build", what: "The app's build or an AI agent sends the manifest with a Product map token after each release." },
};
export const STATUS: Record<JourneyStatus, { label: string; tone: string; hint: string }> = {
  discovered: { label: "Seen in use", tone: "var(--info)", hint: "A path people really walk (telemetry)" },
  auto: { label: "Proposed", tone: "var(--accent)", hint: "Pulse proposed it from the map" },
  drafted: { label: "Draft", tone: "var(--faint)", hint: "Being written" },
  planned: { label: "Planned", tone: "var(--warn)", hint: "To build" },
  shipped: { label: "Shipped", tone: "var(--good)", hint: "Built and live" },
};
export const ISSUE_KIND: Record<string, string> = { dead_end: "Dead end", orphan: "Unreachable", no_op: "Broken or no-op", missing_link: "Missing link", permission: "Permission", slow: "Slow", error: "Errors", other: "Other" };
export const SEVERITY_TONE: Record<string, string> = { high: "var(--bad)", medium: "var(--warn)", low: "var(--faint)" };
export const ORIGIN: Record<string, string> = { scan: "From the code", auto: "Pulse", ai: "AI", manual: "You", telemetry: "Real use" };
export const IDEA_STATUS = [{ key: "new", label: "New" }, { key: "planned", label: "Planned" }, { key: "building", label: "Building" }, { key: "shipped", label: "Shipped" }, { key: "parked", label: "Parked" }] as const;

export async function pmPost<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/product-map/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not save. Try again.");
  return d as T;
}
export const pct = (x: number | null | undefined) => x == null ? "" : `${Math.round(x * 100)}%`;
export const secs = (ms: number | null | undefined) => ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
export const when = (d: string | null) => d ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(d)) : "never";
/** A screen's name for people: its title, with the address when two screens share a title. */
export function screenName(screens: Screen[], key: string) {
  const s = screens.find((x) => x.key === key); if (!s) return key;
  return screens.some((x) => x.key !== key && x.title === s.title && x.status !== "removed") ? `${s.title} · ${s.route || s.key}` : s.title || s.route || s.key;
}
/** Where a screen leads (its links, the redirects and real moves), most used first. */
export function nextScreens(edges: Edge[], key: string) {
  return edges.filter((e) => e.from === key && e.kind !== "proposed").sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((e) => e.to).filter((k, i, a) => a.indexOf(k) === i);
}
export const linked = (edges: Edge[], a: string, b: string) => edges.some((e) => e.from === a && e.to === b && e.kind !== "proposed");
export const inMenu = (edges: Edge[], b: string) => edges.some((e) => e.from === "*" && e.to === b);
