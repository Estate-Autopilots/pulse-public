// CONTRACTS-3 (owner, 8 Nov: "linked projects and tasks must show on the contract", both ways): the agreements linked to a
// project or a task, on that project's or task's page: where each is, its amount, how much is paid and the next payment.
// Only who runs those agreements (admins, leadership, Finance, the seller who owns one) gets any; for everyone else the
// block is not there at all.
import Link from "next/link";
import { ChevronRight, FileSignature } from "lucide-react";
import { api } from "../lib/api";
import { money } from "../lib/contracts.mjs";
import css from "./contracts.module.css";
import d3 from "./[id]/drafts.module.css";

type Row = { id: string; title: string; status: string; currency: string; with: string | null; totalMinor: number | null; paidMinor: number; nextDue: string | null; nextMinor: number | null };
const STATUS = { draft: "Not sent yet", proposed: "Out to sign", active: "Signed", ended: "Ended", cancelled: "Stopped" } as Record<string, string>;
const TONE = { draft: "action", proposed: "wait", active: "good" } as Record<string, string>;
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** What follows the total on the card: nothing paid yet, who it is with (when the name does not say). */
function facts(a: Row) {
  return [a.with && !a.title.includes(a.with) ? `with ${a.with}` : null].filter(Boolean).join(" · ");
}

export async function AgreementsForWork({ projectId, taskId, className, headClassName }: { projectId?: string; taskId?: string; className?: string; headClassName?: string }) {
  const r = await api<{ agreements: Row[] }>(`contracts/for-work?${projectId ? `projectId=${projectId}` : `taskId=${taskId}`}`);
  const list = r.data?.agreements ?? [];
  if (!list.length) return null;
  const title = list.length === 1 ? "Agreements" : `Agreements (${list.length})`;
  return <section className={className ?? css.section} aria-label="Agreements">
    {headClassName ? <h2 className={headClassName}><FileSignature size={15} aria-hidden="true" />{title}</h2>
      : <div className={css.sectionHead}><h2><FileSignature size={16} aria-hidden="true" />{title}</h2></div>}
    <ul className={`${css.list} ${d3.workList}`}>{list.map((a) => <li key={a.id} className={d3.workRow}>
      <Link href={`/contracts/${a.id}`} className={d3.workLink}>
        <span className={`${css.itemText} ${d3.workText}`}>
          <span className={d3.workTitle}><strong>{a.title.split(" · ")[0]}</strong></span>
          <span className={d3.workSubRow}>{a.title.includes(" · ") ? <span className={d3.workSub}>{a.title.split(" · ").slice(1).join(" · ")}</span> : null}
            <span className={css.pill} data-tone={TONE[a.status]}>{STATUS[a.status] ?? a.status}</span></span>
          {facts(a) ? <span className={d3.workFacts}>{facts(a)}</span> : null}
        </span>
        <span className={d3.money}>
          {a.totalMinor ? <span className={d3.moneyTop}><span><span className={d3.totalLabel}>Total </span><strong className={d3.total}>{money(Number(a.totalMinor), a.currency)}</strong></span>
            {Number(a.paidMinor) ? <span className={d3.barPct}>{`${Math.min(100, Math.round((Number(a.paidMinor) / Number(a.totalMinor)) * 100))}% paid`}</span> : null}</span> : null}
          {a.totalMinor && Number(a.paidMinor) ? <span className={d3.miniBar} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.round((Number(a.paidMinor) / Number(a.totalMinor)) * 100))}%` }} /></span> : null}
          {a.nextDue ? <span className={d3.nextDue} data-late={a.nextDue < new Date().toISOString().slice(0, 10) ? "" : undefined}>Next payment <strong>{`${a.nextMinor ? `${money(Number(a.nextMinor), a.currency)}, ` : ""}due ${day(a.nextDue)}`}</strong></span> : null}
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </Link>
    </li>)}</ul>
  </section>;
}
