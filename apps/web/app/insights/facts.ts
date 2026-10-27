// INSIGHTS-2 (1082): what the redesigned Insights reads, and the words it uses. A plain module (server page and client
// components read the same lists; a value imported from a "use client" file is only a reference on the server).
export type Side = { n: number; p50: number | null; p75: number | null; p90: number | null; wallP50: number | null };
export type Facts = {
  computedAt: string; filters: { since: string | null; pod: string | null; segment: string | null; client: string | null };
  facets: { pods: { key: string; n: number }[]; segments: { key: string; n: number }[]; clients: { id: string; name: string; n: number }[] };
  groups: number; messages: number; clients: number; from: string | null; to: string | null;
  path: { started: number; live: number; stages: { stage: string; reached: number; p50: number; p90: number }[];
    steps: { key: string; n: number; p25: number | null; p50: number | null; p75: number | null; p90: number | null }[];
    liveHist: { lo: number; hi: number | null; n: number }[]; trend: { quarter: string; n: number; p50: number | null }[]; stalls: { stage: string; n: number }[] };
  waits: { sides: { team?: Side; client?: Side }; hist: { side: "team" | "client"; lo: number; hi: number | null; n: number }[];
    byStage: { stage: string; side: "team" | "client"; n: number; p50: number }[]; heat: { side: "team" | "client"; dow: number; hour: number; n: number }[];
    afterHours: { team?: number; client?: number } | null; voice: { team?: number; client?: number } | null;
    people: { id: string; name: string; pod: string | null; messages: number; groups: number; answers: number; p50: number | null; afterHours: number }[];
    pods: { pod: string; groups: number; live: number | null }[] };
  asks: { intents: { key: string; n: number; firstWeek: number }[]; topics: { key: string; n: number; firstWeek: number }[]; clientMessages: number; firstWeekMessages: number };
  wrong: { signals: { kind: string; n: number; groups: number }[]; months: { month: string; kind: string; n: number }[]; funds: { asks: number; groups: number } };
};
export type Card = { id: string; area: string; tab: string | null; ord: number; title: string; soWhat: string | null; action: string | null; kpis: Record<string, unknown>[];
  chart: Record<string, unknown>; data: unknown[]; evidence: Record<string, unknown>; patternIds: string[]; source: string; version: number; refreshedAt: string };
export type Runs = { runs: { id: string; source: string; kind: string; round: number | null; startedAt: string; finishedAt: string | null; counts: Record<string, number>; stats: Record<string, unknown> }[];
  saturation: Record<string, number>[] | null; patterns: { confirmed: number; candidate: number; families: number; refreshedAt: string | null } | null;
  cards: { n: number; refreshedAt: string | null } | null; data: { groups: number; messages: number; from: string | null; to: string | null; clients: number; readAt: string | null } | null };
export type Pattern = { id: string; family: string; area: string; unit: string | null; statement: string; outcome: string | null; segment: Record<string, unknown>; direction: number | null;
  effectKind: string | null; effect: number | null; ciLow: number | null; ciHigh: number | null; support: number | null; exposed: number | null; q: number | null; status: string;
  replication: Record<string, unknown> | null; stability: Record<string, unknown> | null; valueInr: number | null; valueDays: number | null; valueBasis: string | null; action: string | null;
  rank: number | null; tags: string[]; scope: Record<string, unknown>; chart: Record<string, unknown> | null; data: unknown[]; hasEvidence: boolean; refreshedAt: string };
export type PatternPage = { total: number; all: number; facets: { family: Record<string, number>; area: Record<string, number>; status: Record<string, number> }; items: Pattern[]; actions: Act[] };
export type Act = { rec: string; id?: string; kind: "task" | "sop"; ref: string; at: string; by: string | null; title: string | null; status: string | null };

/** The tabs: each answers one question. `area` is the name the pattern registry and the cards use for it. */
export const TABS = [
  { key: "overview", label: "Overview", q: "How are clients being run?", area: "overview" },
  { key: "path", label: "Where time goes", q: "Where does a client's time go?", area: "service_path" },
  { key: "waiting", label: "Who waits", q: "Who waits for whom?", area: "who_waits" },
  { key: "asks", label: "What clients ask", q: "What do clients ask for?", area: "client_asks" },
  { key: "wrong", label: "What goes wrong", q: "Where does it go wrong?", area: "goes_wrong" },
  { key: "sop", label: "Onboarding", q: "Is onboarding done the way the SOP says?", area: "onboarding" },
  { key: "chats", label: "From the chats", q: "What the chats record", area: "team" },
  { key: "patterns", label: "Patterns", q: "What patterns has Pulse found?", area: "patterns" },
] as const;
export const AREA_LABEL: Record<string, string> = { overview: "Overview", service_path: "Where time goes", path: "Where time goes", who_waits: "Who waits", waiting: "Who waits",
  client_asks: "What clients ask", asks: "What clients ask", goes_wrong: "What goes wrong", wrong: "What goes wrong", onboarding: "Onboarding", sop: "Onboarding", team: "The team",
  money: "Money", clients: "Clients", patterns: "Patterns", other: "Other" };
export const FAMILY_LABEL: Record<string, string> = { contrast: "Contrast", rule: "Association rule", sequence: "Sequence", process: "Process", temporal: "Timing", cluster: "Archetype",
  factor: "Factor", model: "Model", survival: "Survival", anomaly: "Change", network: "Network", text: "Phrasing" };

export const STAGE: Record<string, string> = { onboarding: "Onboarding", brief: "Brief & material", shoot: "Shoot", creative: "Creatives", revision: "Changes asked", approval: "Client approval",
  live: "Campaign live", leads: "Leads talk", payment: "Payment", quiet: "Quiet" };
export const INTENT: Record<string, string> = { request: "Requests", question: "Questions", info: "Updates", deliverable: "Material & creatives", approval: "Approvals", change: "Change requests",
  complaint: "Complaints", ack: "Acknowledgements", schedule: "Scheduling", payment: "Payments" };
export const TOPIC: Record<string, string> = { creative: "Creatives", video: "Video", shoot: "Shoot", ads: "Ads", leads: "Leads", finance: "Money", content: "Content & scripts", project: "Project facts",
  tech: "Tech & access", legal: "Legal & RERA", logistics: "Logistics", relation: "The relationship" };
export const SIGNAL: Record<string, string> = { complaint: "Complaints", approval: "Approvals given", payment: "Payments", delay: "“Any update?” chases", lead_quality: "Lead-quality complaints",
  upsell: "Upsell openings", invoice: "Invoices", churn_risk: "Stop, hold or leaving", quotation: "Quotations", renewal: "Renewals" };
export const STEP: Record<string, string> = { startToLive: "Group start → campaign live", briefToCreative: "Brief → creatives", creativeToApproval: "Creatives → client approval",
  approvalToLive: "Approval → campaign live", liveToPayment: "Live → first payment talk" };
export const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WAIT_BINS = [{ lo: 0, hi: 5, label: "<5m" }, { lo: 5, hi: 15, label: "5–15m" }, { lo: 15, hi: 30, label: "15–30m" }, { lo: 30, hi: 60, label: "½–1h" }, { lo: 60, hi: 120, label: "1–2h" },
  { lo: 120, hi: 240, label: "2–4h" }, { lo: 240, hi: 540, label: "4h–1d" }, { lo: 540, hi: 1620, label: "1–3d" }, { lo: 1620, hi: null, label: "3d+" }];
export const LIVE_BINS = ["<3 days", "3–7", "7–14", "14–30", "30–60", "60+"];
export const PERIODS = [{ key: "all", label: "All time" }, { key: "12m", label: "Last 12 months" }, { key: "6m", label: "Last 6 months" }, { key: "90d", label: "Last 90 days" }, { key: "2026", label: "2026" }, { key: "2025", label: "2025" }];

/** Where a value sits on binned axis positions (index + fraction inside its bin), for a marker. */
export function binPos(v: number | null | undefined, bins: { lo: number; hi: number | null }[]) {
  if (typeof v !== "number") return null;
  for (let i = 0; i < bins.length; i++) { const b = bins[i]; if (b.hi === null || v < b.hi) return i + (b.hi === null ? 0.5 : (v - b.lo) / (b.hi - b.lo)); }
  return bins.length - 0.5;
}
/** The query string the shared filters keep across tabs. */
export function filterQuery(q: Record<string, string | undefined>) {
  return ["period", "pod", "segment", "client"].filter((k) => q[k] && q[k] !== "all").map((k) => `${k}=${encodeURIComponent(q[k]!)}`).join("&");
}
