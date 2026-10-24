import { api, apiV1 } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { Library } from "../../sops/types";
import type { ProcessSummary } from "../flow-types";
import { NewProcess, type Template, type WriteupChoice } from "./new-process";

/** FLOW-B: a new process, on a page of its own (no corner drawer): its name, then where it starts from: a template
 *  (EA's client project, a solar install, blank) or a write-up the company already has, which Pip turns into steps.
 *  Then it opens in the builder. */
export default async function NewProcessPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const from = (await searchParams).from ?? null;
  const [t, p, lib] = await Promise.all([apiV1<{ templates: Template[] }>("/v1/flow/templates"), apiV1<{ processes: ProcessSummary[]; canEdit: boolean }>("/v1/flow/processes"), api<Library>("sops")]);
  if (p.data && !p.data.canEdit) return <Message text="Leadership adds processes. Ask them, or open one from Processes." />;
  // Write-ups: processes that are written only (the flow API), else the active SOPs (before it is on this server).
  const writeups: WriteupChoice[] = p.data ? p.data.processes.filter((x) => x.status === "written" || x.source === "sop")
      .map((x) => ({ id: x.id, name: x.name, summary: x.summary, sections: x.stages.length, steps: x.steps }))
    : (lib.data?.sops ?? []).filter((s) => s.status === "active").map((s) => ({ id: `sop:${s.id}`, name: s.title, summary: s.purpose, sections: s.phases, steps: s.steps }));
  return <Page>
    <PageHeader title="New process" back={{ href: "/processes", label: "Processes" }} recent={false} />
    <NewProcess templates={t.data?.templates ?? null} writeups={writeups} flowReady={!!p.data} initial={from} />
  </Page>;
}
