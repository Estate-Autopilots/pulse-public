import { api, apiV1 } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
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
  return <Page>
    <PageHeader title="My steps" back={{ href: "/me", label: "My desk" }} context={[open ? `${open} open` : "Nothing open", late ? `${late} late` : null, mine.asked.length ? `${mine.asked.length} asked of you` : null]}
      actions={mine.steps.length ? <DailyUpdate compact /> : null} />
    {/* FLOW-E: each role I hold, with its tiles (a person can hold several). */}
    {chosen ? null : <div style={{ marginBottom: 12 }}><RoleHome data={home.data} compact /></div>}
    <MySteps mine={mine} chosen={chosen} detail={detail?.data ?? null} detailError={detail?.error ?? null} />
    {olderItems.length ? <section aria-label="Steps of older workflows"><h2 style={{ margin: "18px 0 10px", fontSize: 15 }}>From older workflows</h2><WaitingNow items={olderItems} /></section> : null}
  </Page>;
}
