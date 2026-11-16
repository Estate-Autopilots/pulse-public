import { headers } from "next/headers";
import { apiV1 } from "../../lib/api";
import { day } from "../../lib/format";
import { Message, Page, PageHeader, QueryTabs, styles } from "../../ui";
import { Builder } from "../builder/builder";
import { PhoneSteps } from "../builder/phone";
import type { CompanyBlock, ModuleManifest, Primitive, ProcessDetail, RunSummary } from "../flow-types";
import { MakeProcess } from "./make-process";
import { StartRun } from "./start-run";
import { ProcessRuns } from "./runs";
import { Writeup } from "./writeup";
import css from "../builder/builder.module.css";


/** FLOW-B: one process. Steps (the builder on a computer, a readable list of stages and steps on a phone), its
 *  Write-up (the SOP text by section, with the steps each part explains) and its Runs (every project going through it). */
export default async function ProcessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; step?: string }> }) {
  // An older SOP's, workflow's or board's id ("workflow:<uuid>") arrives still encoded: decode it once.
  const { id: raw } = await params, { tab, step } = await searchParams;
  let id = raw; try { id = decodeURIComponent(raw); } catch {}
  const view = tab === "writeup" || tab === "runs" ? tab : "steps";
  const [p, m, runs] = await Promise.all([apiV1<ProcessDetail>(`/v1/flow/processes/${encodeURIComponent(id)}`), apiV1<{ modules: ModuleManifest[]; primitives?: Primitive[]; blocks?: CompanyBlock[] }>("/v1/flow/modules"),
    view === "runs" ? apiV1<{ runs: RunSummary[] }>(`/v1/flow/runs?processId=${encodeURIComponent(id)}`) : Promise.resolve(null)]);
  if (p.error) return <Message text={p.error} />;
  const d = p.data!, modules = m.data?.modules ?? [], primitives = m.data?.primitives ?? [], blocks = m.data?.blocks ?? [];
  const phone = /Mobi|Android|iPhone|PulseShell/i.test((await headers()).get("user-agent") ?? "");
  const runWord = d.terms?.runs ?? "Runs";
  return <Page fit={view === "steps" && !phone}>
    <PageHeader title={d.name} back={{ href: "/processes", label: "Processes" }} recent={{ title: d.name }}
      context={[d.status === "written" ? "Written only" : d.status === "draft" ? "Draft" : d.status === "live" ? "Live" : d.status === "paused" ? "Paused" : "Archived",
        `${d.steps} ${d.steps === 1 ? "step" : "steps"}`, d.stages.length ? `${d.stages.length} stages` : null, d.publishedAt ? `version ${d.version} · ${day(d.publishedAt)}` : null, d.running ? d.status === "live" ? `${d.running} running` : `${d.running} practice ${d.running === 1 ? "run" : "runs"}` : null]}
      // UX-WORK (owner, 5 Nov 2026): the one thing to do here is start a run (it opens Runs, where Start asks what it needs).
      // An older workflow's page already leads with "Edit it as a process" (MakeProcess): one solid button per page.
      // FIX-DOCS-WORK (owner, 10 Nov 2026: "no clarity on how to use them"): the primary opens the Start sheet right here
      // (who it is for, who does each part, the first step), instead of first sending you to the Runs tab.
      actions={view !== "runs" && !(d.source !== "flow" && d.canEdit) && ((d.canStart && d.status === "live") || (d.canEdit && d.steps > 0)) ? <StartRun process={d} /> : null} />
    {d.source !== "flow" && d.canEdit ? <MakeProcess process={d} /> : null}
    <QueryTabs base={`/processes/${encodeURIComponent(id)}`} current={view} items={[{ key: "steps", label: "Steps" }, { key: "writeup", label: "Write-up", count: d.writeup.length || undefined }, { key: "runs", label: runWord, count: d.running || undefined }]} />
    {view === "writeup" ? <Writeup process={d} />
      : view === "runs" ? <ProcessRuns process={d} runs={runs?.data?.runs ?? null} error={runs?.error ?? null} />
        : phone ? <PhoneSteps process={d} modules={modules} primitives={primitives} />
          : <>{!m.data ? <Message text={m.error ?? "The list of steps did not load."} /> : null}
            <div className={`${styles.fit} ${css.wide}`}><Builder process={d} modules={modules} primitives={primitives} blocks={blocks} step={step ?? null} /></div>
            <div className={css.narrow}><PhoneSteps process={d} modules={modules} primitives={primitives} /></div></>}
  </Page>;
}
