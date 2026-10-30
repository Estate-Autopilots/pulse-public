"use client";

import { ArrowUp, CheckCheck, Inbox, MessageSquare, MessagesSquare, SearchX, ShieldAlert, UserRoundCheck, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ago, dayYear, plural } from "../../lib/format";
import { Avatar, Badge, Empty, styles, Pager } from "../../ui";
import css from "../desk.module.css";
import { CATEGORY, FREQUENCY, TICKET_STATUS, ticketNo, type Ticket, type TicketList, type TicketStatus } from "../types";
import { SelectField } from "../../kit/select-field";

type Show = "open" | "done" | "all";
const LIVE: TicketStatus[] = ["open", "in_progress", "waiting"];
// On the desk, "waiting" means HR is waiting for the person who raised it.
const STATUS_LABEL: Record<TicketStatus, string> = { open: "Open", in_progress: "In progress", waiting: "Waiting for the person", resolved: "Resolved", closed: "Closed" };
const PRIORITY: Record<Ticket["priority"], string> = { low: "Can wait", normal: "Normal", high: "Urgent" };

/** The requests desk: everything staff have raised with HR, filtered in the browser so each click answers at once. */
export function Requests({ data }: { data: TicketList }) {
  const [show, setShow] = useState<Show>("open"); const [category, setCategory] = useState<string | null>(null); const [who, setWho] = useState("");
  const [about, setAbout] = useState<string | null>(null);
  const tickets = data.tickets; const live = (t: Ticket) => LIVE.includes(t.status);
  const inShow = about ? tickets.filter((t) => t.aboutId === about) : tickets.filter((t) => show === "all" || (show === "open") === live(t));
  const byWho = (t: Ticket) => !who || (who === "none" ? !t.assigneeId : t.assigneeId === (who === "mine" ? data.me : who));
  const shown = inShow.filter((t) => byWho(t) && (!category || t.category === category));
  // DATUP-TASKS: complaints about a colleague, counted per person over every request on the desk, open or not.
  const complaints = Object.values(tickets.reduce<Record<string, { id: string; name: string; n: number; open: number; last: string; often: number; topics: string[] }>>((m, t) => {
    if (!t.aboutId) return m; const day = t.happenedOn ?? t.createdAt.slice(0, 10);
    const p = m[t.aboutId] ??= { id: t.aboutId, name: t.aboutName ?? "Someone", n: 0, open: 0, last: day, often: 0, topics: [] };
    p.n += 1; if (live(t)) p.open += 1; if (day > p.last) p.last = day; if (t.frequency === "often" || t.frequency === "always") p.often += 1; if (p.topics.length < 3) p.topics.push(t.subject);
    return m;
  }, {})).sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));
  const aboutName = about ? complaints.find((c) => c.id === about)?.name ?? "this colleague" : null;
  const categories = data.categories.filter((c) => inShow.some((t) => t.category === c && byWho(t)) || category === c);
  const tabs: [Show, string, number][] = [["open", "Open", tickets.filter(live).length], ["done", "Resolved", tickets.filter((t) => !live(t)).length], ["all", "All", tickets.length]];
  const mine = tickets.filter((t) => live(t) && t.assigneeId === data.me).length; const unassigned = tickets.filter((t) => live(t) && !t.assigneeId).length;
  if (!tickets.length) return (
    <section className={`${styles.panel} ${styles.panelFill}`} data-grow="">
      <Empty icon={Inbox} first title="No requests yet" text="This is the desk for everything staff ask HR: a missing salary slip, a leave question, a laptop, a complaint. Nothing gets lost in chats." />
      <div className={css.steps}>
        <div className={css.step}><b><MessageSquare size={14} aria-hidden="true" />1. Someone raises a request</b><p>From “Raise a request” on My desk, with a category and how urgent it is. Only they, HR and admins can read it.</p></div>
        <div className={css.step}><b><UserRoundCheck size={14} aria-hidden="true" />2. You pick it up here</b><p>Assign it, reply to the person or leave a note only HR sees. Urgent and unassigned requests are counted on the dashboard.</p></div>
        <div className={css.step}><b><CheckCheck size={14} aria-hidden="true" />3. You resolve it</b><p>Say how it was resolved. The person reads that and can reopen the request if it is not solved.</p></div>
      </div>
    </section>
  );
  return (
    <section className={`${styles.panel} ${styles.panelFill}`} data-grow="">
      <div className={styles.panelHead}><h3 className={styles.panelTitle}>Requests<small>{plural(tabs[0][2], "open request")}{unassigned ? ` · ${unassigned} unassigned` : ""}</small></h3></div>
      {complaints.length ? <div className={css.complaints} aria-label="Complaints by colleague">
        <p className={css.complaintsHead}><ShieldAlert size={14} aria-hidden="true" />Complaints by colleague<small>HR and admins only. The colleague is never told.</small></p>
        <ul>{complaints.map((c) => <li key={c.id}><button type="button" aria-pressed={about === c.id} onClick={() => setAbout(about === c.id ? null : c.id)}>
          <Avatar name={c.name} id={c.id} size={24} /><span className={css.complaintMain}><b>{c.name}</b><small>{c.topics.join(" · ")}</small></span>
          <span className={css.complaintNums}><b>{plural(c.n, "complaint")}</b><small>{c.open ? `${c.open} open · ` : ""}{c.often ? `${c.often} say often · ` : ""}last {dayYear(c.last)}</small></span>
        </button></li>)}</ul>
      </div> : null}
      {about ? <p className={css.complaintsFilter}>Every complaint about <b>{aboutName}</b>, open or resolved.<button type="button" className={css.chip} onClick={() => setAbout(null)}><X size={12} aria-hidden="true" />Show all requests</button></p> : null}
      <div className={css.filters}>
        <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Status">{tabs.map(([key, label, n]) => <button key={key} type="button" className={styles.segment} aria-current={show === key ? "true" : undefined} onClick={() => setShow(key)}>{label}<span className={styles.muted}>{n}</span></button>)}</div>
        <div className={css.filterGroup} role="group" aria-label="Assigned to">
          <button type="button" className={css.chip} aria-pressed={who === "mine"} onClick={() => setWho(who === "mine" ? "" : "mine")}>Assigned to me<small>{mine}</small></button>
          <button type="button" className={css.chip} aria-pressed={who === "none"} onClick={() => setWho(who === "none" ? "" : "none")}>Unassigned<small>{unassigned}</small></button>
          <SelectField className={css.selectSmall} aria-label="Assigned to" value={who === "mine" || who === "none" ? "" : who} onChange={(event) => setWho(event.target.value)}>
            <option value="">Anyone</option>{data.assignees.filter((a) => a.id !== data.me).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </SelectField>
        </div>
        <div className={css.filterGroup} role="group" aria-label="Category">
          {categories.map((c) => <button key={c} type="button" className={css.chip} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>{CATEGORY[c] ?? c}<small>{inShow.filter((t) => t.category === c && byWho(t)).length}</small></button>)}
        </div>
      </div>
      <Pager primary label="requests">
      {shown.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${css.ticketTable}`}>
        <thead><tr><th>Request</th><th>From</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Raised</th><th>Last update</th></tr></thead>
        <tbody>{shown.map((t) => (
          <tr key={t.id}>
            <td><Link href={`/me/requests/${t.id}`} className={styles.cellLink}><span className={css.ticketNo}>{ticketNo(t.no)}</span> {t.subject}</Link>
              <span className={styles.cellSub}>{CATEGORY[t.category] ?? t.category}{t.aboutName ? ` · about ${t.aboutName}${t.frequency ? ` (${FREQUENCY[t.frequency].toLowerCase()})` : ""}` : ""}{t.comments ? <> · <MessagesSquare size={11} aria-hidden="true" style={{ verticalAlign: "-1px" }} /> {plural(t.comments, "reply", "replies")}</> : null}</span></td>
            <td className={styles.nowrap}>{t.name ? <span className={styles.person}><Avatar name={t.name} id={t.personId} photoAt={t.photoAt} size={22} /><span>{t.name}</span></span> : null}</td>
            <td><span className={css.prio} data-p={t.priority}>{t.priority === "high" ? <ArrowUp size={12} aria-hidden="true" /> : null}{PRIORITY[t.priority]}</span></td>
            <td className={styles.nowrap}><Badge tone={t.status === "waiting" ? "neutral" : TICKET_STATUS[t.status].tone}>{STATUS_LABEL[t.status]}</Badge></td>
            <td className={styles.nowrap} data-label={t.assigneeName ? "With" : undefined}>{t.assigneeName ?? <span className={styles.muted}>Not picked up yet</span>}</td>
            <td className={styles.nowrap} title={t.createdAt} data-label="Raised">{ago(t.createdAt)}</td><td className={`${styles.nowrap} ${styles.muted}`} data-label="Updated">{ago(t.updatedAt)}</td>
          </tr>
        ))}</tbody>
      </table></div> : <Empty icon={SearchX} compact title={show === "open" && !who && !category ? "No open requests" : "No request matches"} text={show === "open" && !who && !category ? "Everything raised so far is resolved or closed." : "Try another status, or clear the filters."}>
        {who || category || show !== "all" ? <button type="button" className={styles.btn} onClick={() => { setShow("all"); setWho(""); setCategory(null); }}>Show all requests</button> : null}</Empty>}
      <p className={styles.panelFoot}><span>Open a request to reply, assign it or resolve it. “Raised” is how long ago the person asked.</span></p>
      </Pager>
    </section>
  );
}
