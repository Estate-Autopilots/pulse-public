import Link from "next/link";
import { api } from "../lib/api";
import { Message } from "../ui";
import { PmCards, type PmRow } from "./pm-cards";
import { LiveFirstRun } from "./pm-live/first-run";
import css from "./pm-home.module.css";

/** PM-BUILD-3 (the Mac's screen 01, SPEC v1.1 §5.1; owner's P1: "visual cards, one clean list, details on open"):
 *  Work → Projects is ONE list of project cards. Each card: the project's colour band and icon, its name and client,
 *  its health word with the reason, the phase strip naming the current phase, "Next: step · owner · due" and one clock
 *  line. Filter chips Mine · At risk · Waiting on client · Quiet (14 days) · All, and search; sorted Late, At risk,
 *  Waiting on client, On track, then the rest, then by the next due day. No money, no "today's issues", no second
 *  panel: leadership's desk (money at risk, alerts) stays one link away (?desk=1). Data: GET /api/v0/projects/health. */
type Api = { today: string; everyone: boolean; scope: string; templates?: number; ai?: number; rows: (PmRow & { mine: boolean })[] };

export async function PmProjects({ f, q, canCreate }: { f?: string; q?: string; canCreate: boolean }) {
  const r = await api<Api>("projects/health?scope=all");
  if (r.error || !r.data) return <Message text={r.error ?? "Projects are unavailable."} />;
  const d = r.data;
  const rows: PmRow[] = d.rows.filter((x) => x.pm).map((x) => ({ id: x.id, title: x.title, client: x.client, lead: x.lead, mine: x.mine, pm: x.pm }));
  if (!rows.length) return <LiveFirstRun today={d.today} canCreate={canCreate} />;
  return <>
    <PmCards rows={rows} today={d.today} initial={f} q={q ?? ""} />
    <p className={css.foot}>
      <Link href="/tasks?view=projects&scope=archived&desk=1">Paused and finished projects</Link>
      {d.ai ? <><span aria-hidden="true"> · </span><Link href="/tasks?view=projects&started=ai">Started by AI ({d.ai})</Link></> : null}
      {d.everyone ? <><span aria-hidden="true"> · </span><Link href="/tasks?view=projects&desk=1">Leadership desk</Link></> : null}
    </p>
  </>;
}
