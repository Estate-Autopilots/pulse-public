// AGENT-MEMORY (8 Nov 2026): out of budget, an AI employee went silent in the 7 Nov demo. What it says instead, worded
// here from pulse.agent_budget_state (migration 1840) so the person and its budget approver read the same facts and the
// link to the meter, where admins add more in one click. Pure, so it is tested on its own (test/agent-budget.test.mjs).

export type Meter = { used: number; limit: number | null; share: number | null };
export type BudgetState = {
  level: 'ok' | 'warn' | 'out'; period: 'day' | 'month' | 'org' | 'plan' | 'rupees' | 'org_rupees'; share: number; key: string;
  day: Meter; month: Meter; org: Meter | null; owner: { id: string | null; name: string | null }; canAdd: boolean;
  // TOKENS-2 (2280): rupees a month, its own and the company's (null when none is set).
  rupees?: Meter | null; orgRupees?: Meter | null;
};

const n = (x: number | null | undefined) => new Intl.NumberFormat('en-IN').format(Math.max(0, Math.round(Number(x) || 0)));
const WHAT: Record<BudgetState['period'], string> = { month: "this month's budget", day: "today's budget", org: "the company's AI budget for today", plan: "the company's AI plan",
  rupees: "this month's rupee budget", org_rupees: "the company's AI rupees for this month" };
const inr = (x: number | null | undefined) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.max(0, Math.round(Number(x) || 0)))}`;

/** The meter's page for this AI employee (its profile, AI → Model & limits). */
export function budgetLink(agentId: string, origin: string) { return `${origin.replace(/\/+$/, '')}/people/${agentId}?tab=ai&s=model`; }

/** reply: for the person waiting on it; owner: for its budget approver and owner (80% and 100%). */
export function budgetWords(st: BudgetState, agent: { id: string; name: string }, origin: string) {
  const link = budgetLink(agent.id, origin), who = st.owner?.name ?? 'An admin', what = WHAT[st.period] ?? WHAT.day;
  const rupees = st.period === 'rupees' ? st.rupees : st.period === 'org_rupees' ? st.orgRupees : null;
  const meter = st.period === 'month' ? st.month : st.period === 'org' ? st.org : st.period === 'day' ? st.day : null;
  const of = rupees && rupees.limit ? ` (${inr(rupees.used)} of ${inr(rupees.limit)})` : meter && meter.limit ? ` (${n(meter.used)} of ${n(meter.limit)} tokens)` : '';
  const reply = st.period === 'plan'
    ? `I can't answer this yet: the company has used its AI plan. ${who} can add more here: ${link} I'll answer as soon as it's added.`
    : `I've used ${what}. ${who} can add more here: ${link} I'll answer this as soon as it's added.`;
  const owner = st.level === 'out'
    ? `${agent.name} here: I've used ${what}${of}, so people who write to me are waiting. Add more here: ${link}`
    : `${agent.name} here: I've used ${st.share}% of ${what}${of}. Add more here before I run out: ${link}`;
  return { reply, owner, link };
}
