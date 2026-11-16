import { Lightbulb } from "lucide-react";
import { api } from "../../../lib/api";
import { Empty, Page, PageHeader } from "../../../ui";
import type { Config, Person, SprintView } from "../../types";
import { SprintEditor } from "./editor";
import { LoadFailure } from "../../controls";
import { describeFailure } from "../../../lib/load-error.mjs";

export const metadata = { title: "Creative sprint" };

/** EST-1474: one creative sprint: intake (package, Day 1, approver, strategists), the critical inputs and the clock. */
export default async function SprintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [sprint, config, choices] = await Promise.all([api<SprintView>(`creative/sprints/${encodeURIComponent(id)}`), api<Config>("creative/config"),
    api<{ people: Person[] }>("creative/choices")]);
  if (!sprint.data) return <Page><PageHeader title="Creative sprint" back={{ href: "/creative", label: "Creative Strategy" }} />
    {sprint.status === 403 || sprint.status === 404
      ? <Empty icon={Lightbulb} title={sprint.status === 403 ? "This sprint is not yours to open" : "Sprint not found"} text={describeFailure(sprint.error).text} action={{ href: "/creative", label: "Creative Strategy" }} />
      : <LoadFailure error={sprint.error} />}</Page>;
  if (!config.data || !choices.data) return <Page><PageHeader title={sprint.data.sprint.project} back={{ href: "/creative", label: "Creative Strategy" }} />
    <LoadFailure error={config.error ?? choices.error} /></Page>;
  return <SprintEditor initial={sprint.data} packages={config.data?.packages ?? []} people={choices.data?.people ?? []} />;
}
