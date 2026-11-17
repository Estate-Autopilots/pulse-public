import Link from "next/link";
import { HardDrive, Plus } from "lucide-react";
import { PrimaryLink, QuietLink, WorkHeader, WorkPage } from "../components/work-kit";
import { api, apiV1 } from "../lib/api";
import { Message, Page } from "../ui";
import { plural } from "../sops/parts";
import type { BoardList } from "../sops/board-types";
import type { Library, WorkflowList } from "../sops/types";
import { ProcessLibrary, ProcessMore } from "./library";
import type { ProcessSummary } from "./flow-types";
import { flowCards, processCards } from "./model";
import css from "./processes.module.css";

/** FLOW-B: Processes, the one list for how the company works. Each card is a process (its write-up, its steps, its
 *  runs) with where it stands: written only, steps drafted, or live with its runs. Leadership adds new ones and brings
 *  write-ups in from Drive; everyone reads them. Replaces the SOPs and Workflows lists (both addresses come here). */
export default async function ProcessesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const show = (await searchParams).show;
  // The flow API lists every process (SOPs, workflows and boards included); before it is on a server, the three old
  // lists are joined here instead.
  const [f, lib] = await Promise.all([apiV1<{ processes: ProcessSummary[]; canEdit: boolean }>("/v1/flow/processes"), api<Library>("sops")]);
  const old = f.data ? null : await Promise.all([api<WorkflowList>("workflows"), api<BoardList>("workflows/boards")]);
  if (!f.data && lib.error && old?.[0].error) return <Message text={lib.error} />;
  const cards = f.data ? flowCards(f.data.processes) : processCards(lib.data?.sops ?? [], old?.[0].data?.workflows ?? [], old?.[1].data?.boards ?? []);
  const canEdit = !!(f.data?.canEdit ?? (lib.data?.canEdit || old?.[0].data?.canEdit)), waiting = lib.data?.drive?.waiting ?? 0;
  const live = cards.filter((c) => c.status === "live").length, running = cards.filter((c) => c.status === "live" || c.status === "paused").reduce((n, c) => n + c.running, 0), late = cards.reduce((n, c) => n + c.late, 0);
  // UX-WORK (owner, 5 Nov 2026): the header in My day's language: what is live, running and late as tiles, one primary
  // action (New process) for those who write them, My steps for everyone else.
  return <Page><WorkPage>
    <WorkHeader title="Processes" context="Your company's ways of working, step by step."
      actions={<>
        {canEdit ? <span className={css.wideOnly}><QuietLink href="/sops/drive" icon={HardDrive}>Add from Google Drive{waiting ? <em className={css.count} title={`${waiting} how-to docs found`}>{waiting}</em> : null}</QuietLink></span> : null}
        <ProcessMore canEdit={canEdit} waiting={waiting} />
      </>}
      primary={canEdit ? <PrimaryLink href="/processes/new" icon={Plus}>New process</PrimaryLink> : <PrimaryLink href="/me/steps">My steps</PrimaryLink>} />
    {/* FIX-DOCS-WORK (owner, 10 Nov 2026: "no clarity on how to use them"): how a process is used, in three steps. */}
    {/* FIX-DOCS-WORK: the counts are one quiet line (the tiles fought the title and pushed the processes down on a phone). */}
    {/* FIX-DOCS-WORK (owner, 10 Nov 2026: "no clarity on how to use them"): how a process works, in three steps. */}
    {cards.some((c) => c.status === "live") ? <ol className={css.how} aria-label="How a process works">
      <li><b>1</b>Open one and press Start</li><li aria-hidden="true" className={css.howArrow}>→</li>
      <li><b>2</b>Each person gets their step</li><li aria-hidden="true" className={css.howArrow}>→</li>
      <li><b>3</b>Follow it step by step</li>
    </ol> : null}
    {cards.some((c) => c.status === "live") ? <p className={css.howShort}>How it works: open one, press Start, then follow it step by step.</p> : null}
    <p className={css.counts}><Link href="/processes?show=live">{live} live</Link><span aria-hidden="true">·</span><Link href="/runs">{running} running now</Link><span aria-hidden="true">·</span><Link href="/runs?view=late" data-late={late ? "" : undefined}>{late} {late === 1 ? "step" : "steps"} late</Link></p>
    <ProcessLibrary cards={cards} canEdit={canEdit} initial={show === "live" || show === "drafted" || show === "written" ? show : "all"} />
  </WorkPage></Page>;
}
