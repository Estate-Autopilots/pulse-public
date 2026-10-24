import Link from "next/link";
import { Bell, BellRing, MessageCircle } from "lucide-react";
import { api, getMe } from "../lib/api";
import { ago, dayTime } from "../lib/format";
import { Empty, Message, Page, PageHeader, Pager, Panel, styles } from "../ui";
import { RecordForm } from "../records";
import { Action } from "../company/actions";
import { s, type Row } from "../company/common";
import css from "./notifications.module.css";
import {NotificationPreferences,type NotificationSettings} from './preferences';
import { NotificationStatus } from "../notify-status";
import { CardActions, type NoticeCard } from "../tasks/work-client";
import type { Notice } from "../notify/store";

const EMAIL:Record<string,string>={sent:"Email sent from HR",queued:"Email queued",disabled:"Email delivery is disabled",failed:"Email delivery failed",sink:"Email test sink"};
const TELEGRAM: Record<string, string> = { sent: "Also sent to your Telegram", queued: "Being sent to your Telegram", failed: "Telegram delivery failed", recipient_not_connected: "In Pulse only" };
const WORK_CARDS = ["task.ask", "project.ask", "task.done", "task.blocked"];

export default async function Notifications({searchParams}:{searchParams:Promise<{event?:string}>}) {
  const {event}=await searchParams;
  const telegramBot = process.env.PULSE_TELEGRAM_BOT?.trim().replace(/^@/, "");
  const [r, me, preferences, notices] = await Promise.all([api<{ rows: Row[] }>("notifications"+(event?'?event='+encodeURIComponent(event):'')), getMe(),api<{settings:NotificationSettings}>('companion/notification-settings'),
    event ? Promise.resolve(null) : api<{ rows: Notice[]; counts: { unread: number } }>("notices")]);
  if (r.error) return <Message text={r.error} />;
  const connections = me.data?.role === "admin" ? await api<{ people: Row[]; connections: Row[] }>("notifications/connections") : null;
  // POLISH-2 (QA-E2E P1-6, P2-18): the same list as the bell's panel. Messages fold into one row per conversation with
  // the panel's words ("Ahoro sent you a message", "3 new messages in Pod 1"), and the unread count is the bell's.
  const chatCards = (notices?.data?.rows ?? []).filter((c) => c.channelId);
  const folded = !!notices?.data;
  type Line = Row & { card: Notice | null };
  const plain: Line[] = (r.data?.rows ?? []).filter((n) => !folded || !s(n.eventType).startsWith("chat.")).map((n) => ({ ...n, card: null }));
  const folds: Line[] = chatCards.map((c) => ({ id: c.id, title: c.title, href: c.open.href, at: c.at, readAt: c.readAt, active: true, eventType: c.eventType, card: c }));
  const rows = [...plain, ...folds].sort((a, b) => s(b.at).localeCompare(s(a.at)));
  const unread = notices?.data ? notices.data.counts.unread : rows.filter((n) => !n.readAt&&n.active===true).length;
  // Asks (take, invite, join), finished work to review and blocked work carry the bell's own actions from the Work
  // notices contract: a review is the one quality rating (and "above and beyond"), never effort × impact (PROMOTE-4B).
  const cards = me.data?.person && rows.some((n) => WORK_CARDS.includes(s(n.eventType))) ? new Map(((await api<{ rows: NoticeCard[] }>(event ? `work/notices?id=${encodeURIComponent(event)}` : "work/notices?limit=60")).data?.rows ?? []).map((c) => [c.id, c])) : null;
  return (
    <Page fit>
      <PageHeader title="Notifications" context={[unread ? `${unread} unread` : "All read", "Chats, tasks, company updates and your requests"]}
        actions={connections?.data ? <RecordForm path="notifications/connect" title="Connect a verified personal Telegram chat" label="Connect a person’s Telegram" fields={[{ key: "personId", label: "Person", type: "select", required: true, options: connections.data.people.map((p) => ({ value: s(p.id), label: s(p.name) })) }, { key: "chatId", label: "Private chat ID (blank disconnects)", ...(telegramBot ? { hint: `The person starts @${telegramBot} and confirms their personal chat ID to HR.` } : {}) }, { key: "confirmation", label: "Recipient confirmation", type: "select", required: true, options: [{ value: "verified_private_recipient", label: "I verified this person owns this private chat" }] }]} note="Only the decision and a Pulse link are sent. Salary, money and request reasons stay inside Pulse." /> : null} />
      {preferences.data?<><section className={`${styles.panel} ${css.status}`} aria-label="Notifications on this device"><NotificationStatus/></section><NotificationPreferences initial={preferences.data.settings}/></>:null}
      {rows.length ? <Pager primary unit="notifications" mobile={10}>
        <ul className={`${styles.panel} ${css.list}`} data-items="">{rows.map((n) => (
          n.card ? <li key={s(n.id)} className={css.item} data-unread={n.readAt ? undefined : ""}>
            <span className={css.icon}><MessageCircle size={15} aria-hidden="true" strokeWidth={n.readAt ? 2 : 2.4} /></span>
            <span className={css.text}><Link href={n.card.open.href} className={css.title}>{n.card.title}</Link>
              <small title={dayTime(s(n.at))}>{ago(s(n.at))}{n.card.body ? ` · ${n.card.body.slice(0, 80)}` : ""}</small></span>
            <span className={css.itemActions}>{n.readAt ? <span className={styles.muted}>Read</span> : <Action path="notices/read" body={{ ids: n.card.ids.slice(0, 200) }} label="Mark read" />}</span>
          </li> :
          <li key={s(n.id)} className={css.item} data-unread={n.readAt ? undefined : ""}>
            <span className={css.icon}>{n.readAt ? <Bell size={15} aria-hidden="true" /> : <BellRing size={15} aria-hidden="true" />}</span>
            <span className={css.text}><Link href={s(n.href) || "/me"} className={css.title}>{s(n.title)}</Link>
              {/* POLISH-2: "In Pulse only" on every row said nothing; only a copy that went (or failed) elsewhere is named. */}
              <small title={dayTime(s(n.at))}>{ago(s(n.at))}{n.telegramStatus && n.telegramStatus !== "recipient_not_connected" ? ` · ${TELEGRAM[s(n.telegramStatus)] ?? s(n.telegramStatus)}` : ""}{n.emailStatus?` · ${EMAIL[s(n.emailStatus)]??s(n.emailStatus)}`:""}</small></span>
            <span className={css.itemActions}>{cards?.get(s(n.id))?<CardActions card={cards.get(s(n.id))!} />:null}{n.readAt ? <span className={styles.muted}>Read</span> : <Action path="notifications/read" body={{ id: n.id }} label="Mark read" />}
             {/* Snooze and Dismiss only where they still do something: an unread alert. */}
             {n.readAt ? null : n.active===true?<><Action path="companion/snooze" body={{id:n.id,minutes:60}} label="Snooze 1h"/><Action path="companion/snooze" body={{id:n.id,minutes:60,dismiss:true}} label="Dismiss"/></>:<span className={styles.muted}>No longer active</span>}
            </span>
          </li>
        ))}</ul>
      </Pager> : <Panel title="Notifications"><Empty icon={Bell} first title="Nothing yet" text="New messages, mentions, tasks, company updates and request decisions appear here and on the bell in the top bar." action={me.data?.side === "client" ? { href: "/tasks", label: "Go to your work" } : { href: "/me", label: "Open My desk" }} /></Panel>}
      {telegramBot ? <p className={css.foot}>Telegram copies need your own private chat: start @{telegramBot}, then ask an admin to connect it. The company group is never used for personal decisions.</p> : null}
    </Page>
  );
}
