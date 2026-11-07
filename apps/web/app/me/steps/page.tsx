import { api, apiV1 } from "../../lib/api";
import { Message, Page } from "../../ui";
import { PrimaryLink, SectionHeader, WorkHeader, WorkPage } from "../../components/work-kit";
import { WaitingNow } from "../../sops/board-parts";
import type { WaitingItem } from "../../sops/board-types";
import type { MyStep } from "../../processes/flow-types";
import { MySteps, type StepDetail } from "./my-steps";
import { DailyUpdate } from "../../steps/daily";
import { RoleHome, type RoleHomeData } from "../../processes/role-home";

/** FLOW-B: My steps (was "Waiting for you" under SOPs). The steps open for me in every run, each opening beside the list
 *  with what it needs, its checklist, the part of the write-up that explains it and Pip; what is coming my way (my role,
 *  still waiting for data) and what others wait on me to type in. Steps of older workflows follow, as they were. */
export default async function MyStepsPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const want = (await searchParams).step ?? null;
  const [f, old, home] = await Promise.all([apiV1<{ steps: MyStep[]; upcoming: MyStep[]; asked: MyStep[] }>("/v1/flow/my-steps"), api<{ items: WaitingItem[] }>("workflows/waiting"),
    apiV1<RoleHomeData>("/v1/flow/home")]);
  if (f.error && old.error) return <Message text={old.error} />;
  const mine = f.data ?? { steps: [], upcoming: [], asked: [] };
  const all = [...mine.steps, ...mine.asked, ...mine.upcoming];
  const chosen = want ? all.find((s) => s.id === want) ?? null : null;
  const detail = chosen ? await apiV1<StepDetail>(`/v1/flow/steps/${encodeURIComponent(chosen.id)}`) : null;
  const olderItems = old.data?.items ?? [];
  const late = mine.steps.filter((s) => s.due.late).length + olderItems.filter((i) => i.late).length;
  const open = mine.steps.length + olderItems.length;
  // UX-WORK (owner, 5 Nov 2026): My day's header: the counts as tiles, and one primary action, the step to do next.
  const next = mine.steps.find((s) => s.due.late) ?? mine.steps.find((s) => s.due.days === 0) ?? mine.steps[0] ?? mine.asked[0] ?? null;
  // With no step of a process, an older workflow's step is the next one (late first): its task, or its card here.
  const older = olderItems.find((i) => i.late) ?? olderItems[0] ?? null;
  const olderHref = older ? older.taskId ? `/tasks/${older.taskId}` : `#step-${older.id}` : null;
  return <Page><WorkPage>
    <WorkHeader back={{ href: "/me", label: "My desk" }} eyebrow="My desk · steps processes give you" title="My steps"
      stats={[{ label: "Open", value: open }, { label: "Late", value: late, tone: late ? "bad" : undefined }, { label: "Asked of you", value: mine.asked.length, tone: mine.asked.length ? "warn" : undefined }, { label: "Coming", value: mine.upcoming.length }]}
      actions={mine.steps.length ? <DailyUpdate compact /> : null}
      primary={chosen ? null : next ? <PrimaryLink href={`/me/steps?step=${encodeURIComponent(next.id)}`}>Open the next step</PrimaryLink>
        : olderHref ? <PrimaryLink href={olderHref}>Open the next step</PrimaryLink> : <PrimaryLink href="/my-day">Open My day</PrimaryLink>} />
    {/* FLOW-E: each role I hold, with its tiles (a person can hold several). */}
    {chosen ? null : <RoleHome data={home.data} compact />}
    {/* UX-WORK: "No step is waiting for you" above a step of an older workflow said two things at once; the empty state
        shows only when there is nothing at all. */}
    {all.length || !olderItems.length ? <MySteps mine={mine} chosen={chosen} detail={detail?.data ?? null} detailError={detail?.error ?? null} /> : null}
    {olderItems.length ? <section aria-label="Steps of older workflows"><SectionHeader title="From older workflows" count={olderItems.length} /><WaitingNow items={olderItems} quiet /></section> : null}
  </WorkPage></Page>;
}
