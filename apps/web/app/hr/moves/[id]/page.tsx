import Link from "next/link";
import { api } from "../../../lib/api";
import { dayYear } from "../../../lib/format";
import { Avatar, Badge, Message, Page, PageHeader, styles } from "../../../ui";
import { Checklist } from "../checklist";
import { LEFT_LABEL, STAGE_LABEL, type CaseView } from "../types";
import css from "../moves.module.css";

/** One joining or leaving checklist (HR, leadership and admins). Pulse proposes each step; HR confirms it. */
export default async function MoveCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<CaseView>(`lifecycle/cases/${encodeURIComponent(id)}`);
  if (r.error) return <Message text={r.error} />; const c = r.data; if (!c) return null;
  const leaving = c.kind === "leaving";
  const pct = Math.round((c.done / Math.max(1, c.total)) * 100);
  return (
    <Page fit>
      <PageHeader title={`${leaving ? "Leaving" : "Joining"}: ${c.person.name}`} context={[[c.person.role, c.person.pod].filter(Boolean).join(" · ") || "Team",
        leaving ? `Last working day ${dayYear(c.effectiveOn)}${c.leftType ? ` · ${LEFT_LABEL[c.leftType].toLowerCase()}` : ""}` : `Joins ${dayYear(c.effectiveOn)}`]}
        back={{ href: "/hr?tab=moves", label: "People moves" }} actions={<Link href={`/people/${c.person.id}`} className={styles.btn}>Their record</Link>} />
      <div className={css.case} data-grow="">
        <div className={css.summary} data-case-status={c.status}>
          <Avatar name={c.person.name} id={c.person.id} photoAt={c.person.photoAt} size={36} />
          <span className={css.who}><b>{c.person.name}</b><small>{STAGE_LABEL[c.person.stage]} · opened {dayYear(c.openedAt)}{c.openedBy ? ` by ${c.openedBy}` : ""}</small></span>
          <span className={css.progress} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
          <span><b>{c.done} of {c.total}</b> done</span>
          {c.status !== "open" ? <Badge tone={c.status === "done" ? "success" : "neutral"}>{c.status === "done" ? "Complete" : "Cancelled"}</Badge> : null}
          {c.note ? <small className={css.sub} style={{ flexBasis: "100%" }}>“{c.note}”</small> : null}
        </div>
        <div className={css.scrollArea}><Checklist c={c} /></div>
        <p className={css.note}>{leaving ? "History is never deleted: their tasks, deliveries, messages and this checklist stay. Google Workspace is changed only by an admin, by hand." : "Nothing is sent from here: the invitation goes when HR presses Send on their record."}</p>
      </div>
    </Page>
  );
}
