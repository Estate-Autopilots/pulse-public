// CASE-STUDIES (owner, 10 Nov 2026): the screens' types and their one call to the API (services/api/src/case-studies.ts).
export type StageInfo = { n: number; key: string; label: string; what: string };
export type CaseCard = { id: string; name: string; sector: string | null; aim: string; stage: number; finished: boolean; stageLabel: string;
  day: number; of: number; over: number; next: string | null; checksDone: number; checksTotal: number; published: boolean; storyDocId: string | null;
  leadName: string | null; links: number };
export type CaseList = { cases: CaseCard[]; stages: StageInfo[]; today: string };
export type CaseMonth = { month: string; revenue: number | null; clients: number | null; leads: number | null };
export type Suggestion = { metric: "revenue" | "clients" | "leads"; verdict: "grow" | "recover" | "steady" | "need_data"; baseline: number | null;
  low: number | null; high: number | null; peak: number | null; trend: number | null; monthsUsed: number; reasons: string[]; engine: string };
export type CaseLink = { id: string; kind: LinkKind; refId: string; note: string; title: string | null; missing: boolean; when: string | null; href: string };
export type LinkKind = "meeting" | "doc" | "goal" | "client" | "project" | "ai_employee";
export type CaseFile = Omit<CaseCard, "links"> & {
  problems: string[]; moves: string[]; pains: string[]; months: CaseMonth[]; numbersFrom: "owner" | "export" | "finance" | "workbench";
  after: { revenue?: number | null; clients?: number | null; leads?: number | null; note?: string };
  clientId: string | null; clientName: string | null; storyTitle: string | null;
  stages: (StageInfo & { checks: { id: string; label: string; done: boolean }[]; done: boolean })[];
  links: CaseLink[]; suggestions: Suggestion[]; lists: { problems: string[]; moves: string[] };
};

export const LINK_WORDS: Record<LinkKind, { one: string; many: string }> = {
  meeting: { one: "Meeting", many: "Meetings and podcasts" }, doc: { one: "Doc", many: "Docs" }, goal: { one: "Goal", many: "Goals" },
  client: { one: "Client", many: "Client record" }, project: { one: "Project", many: "Projects" }, ai_employee: { one: "AI employee", many: "AI employees" },
};
export const SECTORS = ["Interior design", "Real estate", "Health and wellness", "Food", "Education", "Professional services", "Retail", "Manufacturing", "Agency", "Travel", "Other"];

/** POST to the case-study API; throws the API's own words. */
export async function casePost<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : "That did not save. Try again.");
  return data as T;
}
export async function caseGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not load. Try again.");
  return data as T;
}
