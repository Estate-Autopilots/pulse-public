// PULSE-HQ (owner, 23 Oct 2026): Stack Intelligence's types and words (0973, services/api/src/stack-intel.ts).
export type StackCategory = "compute" | "hosting" | "ci" | "monitoring" | "llm-observability" | "device-testing" | "video-voice" | "ai-models" | "storage" | "credits" | "dev-tools" | "other";
export type Verdict = "adopt" | "trial" | "assess" | "hold";
export type ToolStatus = "idea" | "evaluating" | "trial" | "adopted" | "dropped";
export type Source = { url: string; label?: string; checked?: string };
export type Metric = { label: string; value: string; unit?: string };
export type Tool = { id: string; name: string; category: StackCategory; useCase: string; plan: string; costUsd: number | null; costInr: number | null; freeTier: string; limits: string;
  pros: string; cons: string; bestFor: string; verdict: Verdict; verdictNote: string; status: ToolStatus; ownerId: string | null; owner: string | null; sources: Source[];
  benchmark: string; metrics: Metric[]; url: string | null; sort: number; createdAt: string; updatedAt: string };
/** `existing`: this organisation already pays for it (left out of new spend). `paidBy`: copied from another organisation's
 *  stack where that organisation pays for it; it is still new spend here. */
export type StackItem = { toolId: string; plan?: string; usd?: number | null; inr?: number | null; note?: string; existing?: boolean; paidBy?: string };
export type Stack = { id: string; name: string; blurb: string; items: StackItem[]; sort: number; shareToken: string | null; sharedPublic: boolean; copiedFrom: string | null; updatedAt: string; by: string | null };
export type StackData = { canEdit: boolean; me: string | null; org?: string; tools: Tool[]; stacks: Stack[]; people: { id: string; name: string }[] };
/** The organisation looking at a shared stack, and the tools it already pays for (lower-case names). */
export type ViewerSpend = { org: string; covered: string[] };
/** A shared stack's snapshot: each tool as it was when shared, with its plan and cost in that stack. */
export type SharedTool = { name: string; category: StackCategory; useCase: string; plan: string; toolPlan: string; costUsd: number | null; costInr: number | null; usd: number | null; inr: number | null;
  note: string; existing: boolean; freeTier: string; limits: string; pros: string; cons: string; bestFor: string; verdict: Verdict; verdictNote: string; status: ToolStatus; sources: Source[] };
export type Shared = { token: string; orgName: string; name: string; blurb: string; body: SharedTool[]; publishedBy: string; publishedAt: string; uses: number; public?: boolean; mine: boolean; tools?: number };

export const STACK_CATEGORIES: readonly { key: StackCategory; label: string; hue: number }[] = [
  { key: "compute", label: "Compute", hue: 215 }, { key: "hosting", label: "Hosting & previews", hue: 190 }, { key: "ci", label: "CI", hue: 262 },
  { key: "monitoring", label: "Monitoring", hue: 5 }, { key: "llm-observability", label: "LLM observability", hue: 300 }, { key: "device-testing", label: "Device testing", hue: 140 },
  { key: "video-voice", label: "Video & voice", hue: 25 }, { key: "ai-models", label: "AI models & routers", hue: 330 }, { key: "storage", label: "Storage", hue: 45 },
  { key: "credits", label: "Startup credits", hue: 95 }, { key: "dev-tools", label: "Dev & design tools", hue: 235 }, { key: "other", label: "Other", hue: 0 },
];
export const CATEGORY_OF = Object.fromEntries(STACK_CATEGORIES.map((c) => [c.key, c])) as Record<StackCategory, (typeof STACK_CATEGORIES)[number]>;
export const VERDICTS: readonly { key: Verdict; label: string; tone: string; hint: string }[] = [
  { key: "adopt", label: "Adopt", tone: "var(--good)", hint: "Use it: proven for us" },
  { key: "trial", label: "Trial", tone: "var(--info)", hint: "Worth a real project" },
  { key: "assess", label: "Assess", tone: "var(--warn)", hint: "Look closer before using" },
  { key: "hold", label: "Hold", tone: "var(--bad)", hint: "Do not start with it" },
];
export const TOOL_STATUS: readonly { key: ToolStatus; label: string; tone: string }[] = [
  { key: "idea", label: "Idea", tone: "var(--accent)" }, { key: "evaluating", label: "Evaluating", tone: "var(--info)" }, { key: "trial", label: "Trial", tone: "var(--warn)" },
  { key: "adopted", label: "Adopted", tone: "var(--good)" }, { key: "dropped", label: "Dropped", tone: "var(--faint)" },
];
/** Rupees per US dollar, only to fill a cost given in one currency (the research used 95). */
export const FX = 95;
export const inrOf = (inr: number | null | undefined, usd: number | null | undefined) => typeof inr === "number" ? inr : typeof usd === "number" ? Math.round(usd * FX) : null;
export const usdOf = (inr: number | null | undefined, usd: number | null | undefined) => typeof usd === "number" ? usd : typeof inr === "number" ? Math.round((inr / FX) * 100) / 100 : null;
export const rupees = (n: number | null | undefined) => n === null || n === undefined ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
export const dollars = (n: number | null | undefined) => n === null || n === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

/** A stack's monthly cost: each item's own cost in the stack, else the tool's; "new" leaves out what is already paid. */
export function stackCost(stack: Pick<Stack, "items">, tools: Map<string, Tool>) {
  let inr = 0, usd = 0, existing = 0, unknown = 0;
  for (const it of stack.items) {
    const t = tools.get(it.toolId); if (!t) continue;
    const i = inrOf(it.inr ?? null, it.usd ?? null) ?? inrOf(t.costInr, t.costUsd), u = usdOf(it.inr ?? null, it.usd ?? null) ?? usdOf(t.costInr, t.costUsd);
    if (i === null) { unknown += 1; continue; }
    if (it.existing) existing += i; else { inr += i; usd += u ?? 0; }
  }
  return { inr, usd, existing, unknown };
}
/** A shared stack's tools as seen by one organisation (owner, 24 Oct 2026): software is licensed per company, so a tool
 *  is new spend for the viewer unless the VIEWER already pays for it. The sharing organisation's own "paid" marks only
 *  cover itself (its own copy, `mine`). */
export function sharedSpend(s: Pick<Shared, "body" | "mine" | "orgName">, viewer: ViewerSpend | null | undefined) {
  const org = s.mine || !viewer ? s.orgName : viewer.org;
  const covered = new Set(s.mine || !viewer ? s.body.filter((t) => t.existing).map((t) => t.name.toLowerCase()) : viewer.covered);
  const rows = s.body.map((t) => {
    const price = inrOf(t.inr, t.usd) ?? inrOf(t.costInr, t.costUsd), ours = covered.has(t.name.toLowerCase());
    return { t, price, covered: ours, paidElsewhere: !ours && !s.mine && t.existing };
  });
  return { org, rows, inr: rows.reduce((n, r) => n + (r.covered ? 0 : r.price ?? 0), 0), covered: rows.filter((r) => r.covered).length,
    coveredInr: rows.reduce((n, r) => n + (r.covered ? r.price ?? 0 : 0), 0), unknown: rows.filter((r) => !r.covered && r.price === null).length };
}
