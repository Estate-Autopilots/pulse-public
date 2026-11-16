import { LiveWork } from "../../tasks/live";
import { api } from "../../lib/api";
import { screenGoal } from "../../lib/goals.mjs";
import { Message, Page } from "../../ui";
import type { GoalDetail } from "../parts";
import { GoalView } from "./goal-view";

export const dynamic = "force-dynamic";

/** FOUNDATIONS: one goal: its progress and how it is worked out, the projects and tasks under it, its smaller goals. */
export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return <Message text="Goal not found." />;
  const r = await api<GoalDetail>(`goals/${id}`);
  if (!r.data) return <Message text={r.error ?? "This goal is unavailable."} />;
  const d = r.data;
  return <Page><LiveWork scope="goal" id={id} /><GoalView initial={{ ...d, goal: screenGoal(d.goal), subGoals: (d.subGoals ?? []).map(screenGoal) }} /></Page>;
}
