// FIX-PEOPLE-MONEY C5 (owner, 10 Nov 2026: "AI workload / tasks and cost is ugly and unclear. Cost per task should also
// be calculated for humans ... People cost and AI cost should sit side by side."): Work and cost (Codex concept 1, "Side
// by side"). The last 1, 2 or 4 weeks: tasks people finished (accepted by someone else) and what that cost at the team's
// average rate from payroll, beside what AI employees finished and the tokens it took. AI-TASKS' throughput
// (agents/tasks/throughput) and Outcomes (outcomes/team) give the counts; the finance model's payroll gives the rate.
// Admins and leaders see every AI employee; a manager sees theirs (agent_task_throughput decides); rupees for people
// need Finance's read (otherwise the page shows tasks only and says why).
import { api } from "../../../lib/api";
import { Message, Page } from "../../../ui";
import { aiCost, payRate, peopleCost, projectCost } from "../../../lib/work-cost.mjs";
import type { LiveState } from "../../../finance/types";
import { WorkCostView } from "./cost-view";

type Agent = { id: string; name: string; title: string; given: number; submitted: number; accepted: number; returned: number; tokens: number };
type Person = { id: string; name: string; role: string | null; pod: string | null; photoAt: string | null; values: number[] };
/** The first day of the last `weeks` weeks, this one included (`week` is this week's Monday, YYYY-MM-DD). */
const firstDay = (week: string, weeks: number) => new Date(Date.parse(`${week}T00:00:00Z`) - (weeks - 1) * 7 * 86400000).toISOString().slice(0, 10);
const PERIODS = [{ days: 7, weeks: 1 }, { days: 14, weeks: 2 }, { days: 28, weeks: 4 }] as const;

export const metadata = { title: "Tasks and cost" }; // the name every link uses (AI → Tasks and cost)

export default async function WorkAndCost({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const q = await searchParams;
  const period = PERIODS.find((p) => String(p.days) === q.days) ?? PERIODS[2];
  const teamP = api<{ week: string; people: Person[] }>("outcomes/team");
  // By project counts the People card's own calendar weeks: from the Monday of its first week (Outcomes' week is this one).
  const projP = teamP.then((t) => api<{ days: number; tasks: { projectId: string | null; project: string | null; who: string; ai: boolean; tokens: number }[] }>(
    `work/cost/projects?days=${period.weeks * 7}${t.data?.week ? `&since=${firstDay(t.data.week, period.weeks)}` : ""}`));
  const [ai, team, live, proj] = await Promise.all([
    api<{ days: number; agents: Agent[] }>(`agents/tasks/throughput?days=${period.weeks * 7}`),
    teamP,
    api<LiveState>("finance/live"),
    projP,
  ]);
  if (ai.error && team.error) return <Message text={ai.error} />;
  const rate = payRate(live.data?.model?.payroll ?? []);
  const people = peopleCost(team.data?.people ?? [], rate, period.weeks);
  const bots = aiCost(ai.data?.agents ?? []);
  // By project counts only the people and AI employees on the two cards, at their own pay per task, so they agree.
  const scope = { people: new Map(people.rows.map((r) => [r.id, r.perTask])), ai: new Set(bots.rows.map((r) => r.id)) };
  const projects = proj.data ? projectCost(proj.data.tasks, rate, period.days, scope) : null;
  const noProject = (proj.data?.tasks ?? []).filter((t) => !t.projectId && (t.ai ? scope.ai.has(t.who) : scope.people.has(t.who))).length;
  return <Page>
    <WorkCostView days={period.days} weeks={period.weeks} rate={rate} people={people} ai={bots} projects={projects} noProject={noProject}
      notes={{ people: team.error ?? null, ai: ai.error ?? null, money: rate ? null : live.status === 403 ? "Rupees need Finance access" : "No payroll month in the finance model yet" }} />
  </Page>;
}
