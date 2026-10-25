import Link from "next/link";
import { ChevronLeft, Lock } from "lucide-react";
import { RecentVisit } from "@pulse/ui-shell";
import { api } from "../../../lib/api";
import { ModuleOff, offModuleResponse } from "../../../module-off";
import { ago, dayTime } from "../../../lib/format";
import { TicketControls, TicketReply } from "../../../hr/actions";
import css from "../../../hr/hr.module.css";
import { CATEGORY, TICKET_STATUS, ticketNo, type TicketDetail, type TicketList } from "../../../hr/types";
import { Avatar, Badge, Message, Page, Panel, styles, Workspace } from "../../../ui";

const STATUS_TEXT: Record<string, string> = { open: "reopened the request", in_progress: "started working on it", waiting: "is waiting for a reply from the person", closed: "closed the request" };

export default async function Request({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<TicketDetail>(`hr/tickets/${encodeURIComponent(id)}`);
  if (r.error) return offModuleResponse(r) ? <ModuleOff /> : <Message text={r.error} />; const t = r.data; if (!t) return null;
  const assignees = t.staff ? (await api<TicketList>("hr/tickets?scope=all")).data?.assignees ?? [] : [];
  const status = TICKET_STATUS[t.status]; const done = t.status === "resolved" || t.status === "closed";
  const back = t.staff && !t.mine ? { href: "/hr?tab=requests", label: "HR desk requests" } : { href: "/me?tab=requests", label: "My requests" };
  return (
    <Page fit>
      <RecentVisit title={`${ticketNo(t.no)} ${t.subject}`} />
      <Link href={back.href} className={styles.back} style={{ marginBottom: -6 }}><ChevronLeft size={13} aria-hidden="true" />{back.label}</Link>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>{t.subject}</h2>
          <div className={styles.context}><span className={styles.mono}>{ticketNo(t.no)}</span><span>{CATEGORY[t.category] ?? t.category}</span><span>raised by {t.mine ? "you" : t.name} {ago(t.createdAt)}</span></div>
        </div>
        <div className={styles.actions}>{t.priority === "high" ? <Badge tone="danger">Urgent</Badge> : null}<Badge tone={status.tone}>{t.status === "waiting" && !t.mine ? "Waiting for the person" : status.label}</Badge></div>
      </header>
      <Workspace>
        <Panel title="Conversation" sub={<span className={styles.inline} style={{ gap: 4, display: "inline-flex" }}><Lock size={11} aria-hidden="true" />Only {t.mine ? "you" : t.name}, HR and admins</span>}>
          <ul className={css.thread}>
            <li className={css.msg} data-mine={t.mine ? "" : undefined}><Avatar name={t.name} id={t.personId} photoAt={t.photoAt} size={28} />
              <span className={css.msgHead}><b>{t.name}</b><small>{dayTime(t.createdAt)}</small></span>
              <p className={css.msgBody}>{t.body || t.subject}</p></li>
            {t.events.map((e) => e.kind === "comment" ? (
              <li key={e.id} className={css.msg} data-internal={e.internal ? "" : undefined} data-mine={e.authorId === t.personId && t.mine ? "" : undefined}><Avatar name={e.by ?? "Pulse"} size={28} />
                <span className={css.msgHead}><b>{e.by ?? "Pulse"}</b><small>{dayTime(e.at)}</small>{e.internal ? <Badge tone="warning">HR note, hidden from {t.name.split(" ")[0]}</Badge> : null}</span>
                <p className={css.msgBody}>{e.body}</p></li>
            ) : <li key={e.id} className={css.event}>{e.by ?? "Pulse"} {e.kind === "assigned" ? (e.body === "Nobody" ? "removed the assignment" : `assigned it to ${e.body}`) : e.kind === "resolved" ? "resolved the request" : STATUS_TEXT[e.body] ?? `set it to ${e.body}`} · {dayTime(e.at)}</li>)}
          </ul>
          {t.resolution && done ? <p className={css.resolution}><b>Resolution</b>{t.resolution}</p> : null}
          <TicketReply id={t.id} staff={t.staff && !t.mine} closed={done} />
        </Panel>
        <div className={styles.stack}>
          <Panel title="Status">
            <dl className={styles.facts}>
              <dt>Status</dt><dd>{status.label}</dd>
              <dt>With</dt><dd>{t.assigneeName ?? <span className={styles.muted}>Not picked up yet</span>}</dd>
              <dt>Raised</dt><dd>{dayTime(t.createdAt)}</dd>
              <dt>Last update</dt><dd>{ago(t.updatedAt)}</dd>
              {t.resolvedAt ? <><dt>{t.status === "closed" ? "Closed" : "Resolved"}</dt><dd>{dayTime(t.resolvedAt)}</dd></> : null}
            </dl>
            {t.staff ? <TicketControls id={t.id} status={t.status} priority={t.priority} assigneeId={t.assigneeId ?? null} assignees={assignees} staff mine={t.mine} />
              : <p className={styles.panelFoot}><TicketControls id={t.id} status={t.status} priority={t.priority} assigneeId={null} assignees={[]} staff={false} mine={t.mine} /></p>}
          </Panel>
          {t.staff && !t.mine ? <Panel title="Raised by"><ul className={styles.list}><li><Link href={`/people/${t.personId}`} className={styles.row}><span className={styles.person}><Avatar name={t.name} id={t.personId} photoAt={t.photoAt} size={28} /><span><span className={styles.rowTitle}>{t.name}</span><span className={styles.cellSub}>Open profile</span></span></span></Link></li></ul></Panel> : null}
        </div>
      </Workspace>
    </Page>
  );
}
