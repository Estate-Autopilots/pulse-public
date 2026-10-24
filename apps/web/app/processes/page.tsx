import Link from "next/link";
import { HardDrive, Plus } from "lucide-react";
import { api, apiV1 } from "../lib/api";
import { Message, Page, PageHeader, styles } from "../ui";
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
  const live = cards.filter((c) => c.status === "live").length, running = cards.reduce((n, c) => n + c.running, 0), late = cards.reduce((n, c) => n + c.late, 0);
  return <Page>
    <PageHeader title="Processes" context={[live ? `${live} live` : "None live yet", running ? plural(running, "run") + " going" : null, late ? plural(late, "step") + " late" : null]}
      actions={<>
        {canEdit ? <Link className={`${styles.btn} ${css.wide}`} href="/sops/drive"><HardDrive size={14} aria-hidden="true" />Import from Drive{waiting ? <em className={css.count}>{waiting}</em> : null}</Link> : null}
        <ProcessMore canEdit={canEdit} waiting={waiting} />
        {canEdit ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/processes/new"><Plus size={14} aria-hidden="true" />New process</Link> : null}
      </>} />
    <ProcessLibrary cards={cards} canEdit={canEdit} initial={show === "live" || show === "drafted" || show === "written" ? show : "all"} />
  </Page>;
}
