// TASKS-4B: where a task stands, at a glance, and its story. Server-safe (no hooks): the stepper (To do → Doing → Done
// → Accepted), the state banner ("Done by Kedab · Sun 11 Oct 20:33 · on time · waiting for your review", with photos;
// accepted quietly celebrated; cancelled, blocked and late impossible to miss) and the history as a timeline grouped by
// day, with avatars, icons and sentences.
import Link from "next/link";
import type { ReactNode } from "react";
import { Ban, BadgeCheck, Check, CircleDot, CornerDownRight, Flag, Gem, Hand, Hourglass, ListChecks, MessageCircleQuestion, Paperclip, PartyPopper, Pencil, Play, Plus,
  MapPin, Repeat, RotateCcw, ShieldCheck, Sparkles, Timer, Trash2, Undo2, Unlock, UserRound, UsersRound } from "lucide-react";
import { longDay, time } from "../lib/format";
import { Avatar } from "../ui";
import type { Detail, Life, Task } from "./types";
import css from "./life.module.css";

const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const when = (iso: string) => `${longDay(iso)} ${time(iso)}`;
const QUALITY: Record<number, string> = { 5: "Great", 4: "Good", 3: "Okay", 2: "Needs work", 1: "Poor" };

// ------------------------------------------------------------------------------------------------------- stepper
const STEPS = [{ key: "todo", label: "To do" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done" }, { key: "accepted", label: "Accepted" }] as const;
const stepOf = (s: string) => s === "accepted" ? 3 : s === "done" || s === "in_review" ? 2 : s === "in_progress" || s === "blocked" ? 1 : s === "cancelled" ? -1 : 0;
/** Where the task is in its life, as four steps; Blocked shows on Doing, Cancelled greys the whole line. */
export function Stepper({ status }: { status: string }) {
  const at = stepOf(status);
  return <ol className={css.stepper} aria-label="Where this task is" data-cancelled={status === "cancelled" ? "" : undefined}>
    {STEPS.map((s, i) => {
      const state = at < 0 ? "off" : i < at ? "past" : i === at ? "now" : "next";
      const label = i === 1 && status === "blocked" ? "Blocked" : s.label;
      return <li key={s.key} data-state={state} data-tone={i === 1 && status === "blocked" ? "danger" : i === 3 && at === 3 ? "success" : undefined} aria-current={state === "now" ? "step" : undefined}>
        <i aria-hidden="true">{state === "past" || (state === "now" && i === 3) ? <Check size={11} strokeWidth={3} /> : i + 1}</i><span>{label}</span>
      </li>;
    })}
    {status === "cancelled" ? <li data-state="now" data-tone="muted" aria-current="step"><i aria-hidden="true"><Ban size={11} /></i><span>Cancelled</span></li> : null}
  </ol>;
}

// --------------------------------------------------------------------------------------------------- the banner
type Tone = "neutral" | "action" | "success" | "celebrate" | "danger" | "warning" | "muted";
function Person({ id, name, photoAt, me }: { id: string | null | undefined; name: string | null | undefined; photoAt?: string | null; me?: string | null }) {
  if (!name) return null;
  return <span className={css.who}><Avatar name={name} id={id ?? undefined} photoAt={photoAt ?? null} size={24} /><b>{id && id === me ? "You" : first(name)}</b></span>;
}
/** The one line that says where the task stands, for whoever looks at it. `actions` sit at its end (the viewer's main
 *  action and the menu). */
export function StateBanner({ d, now, actions, dock }: { d: Detail; now: number; actions?: ReactNode; /** E2E-4P: on a phone the actions sit in a bar above the tabs. */ dock?: boolean }) {
  const t = d.task; const life = d.life as Life | undefined; const me = d.me;
  const doer = <Person id={t.assigneeId} name={t.assigneeName} photoAt={t.assigneePhotoAt} me={me} />;
  const reviewerName = t.reviewerId === me ? "your" : t.reviewerName ? `${first(t.reviewerName)}’s` : "leadership’s";
  const today = istDay(new Date(now).toISOString());
  const due = t.dueOn ? daysBetween(today, t.dueOn) : null;
  const dueWords = t.dueOn ? due === 0 ? "due today" : due! > 0 ? `due ${longDay(t.dueOn)}${due! <= 6 ? ` (in ${due} day${due === 1 ? "" : "s"})` : ""}` : `was due ${longDay(t.dueOn)}` : null;
  const cancel = t.status === "cancelled" ? d.events.find((e) => e.kind === "status" && e.to === "cancelled") : null;
  let tone: Tone = "neutral"; let icon: ReactNode = <CircleDot size={18} />; let line: ReactNode; let sub: ReactNode = null;
  if (t.status === "cancelled") {
    tone = "muted"; icon = <Ban size={18} />;
    line = <><b>Cancelled</b>{cancel ? <> by <Person id={cancel.byId} name={cancel.by} photoAt={cancel.byPhotoAt} me={me} /> · {when(cancel.at)}</> : null}</>;
    sub = cancel?.note ? <>“{cancel.note}”</> : "Nothing more happens on this task. Reopen it from the menu if it is needed after all.";
  } else if (t.status === "accepted") {
    const kind = t.reviewKind ?? "legacy";
    tone = "celebrate"; icon = <PartyPopper size={18} />;
    const by = life?.acceptedBy;
    line = <><b>{kind === "acknowledged" ? "Accepted" : kind === "auto" ? "Accepted with its proof" : "Accepted"}</b>
      {by && kind !== "auto" ? <> by <Person id={by.id} name={by.name} photoAt={by.photoAt} me={me} /></> : null}{t.acceptedAt ? <> · {when(t.acceptedAt)}</> : null}</>;
    sub = <>{doer ? <>{doer} finished it{life?.timing ? ` ${life.timing.words}` : ""}</> : null}
      {kind === "rated" && t.reviewQuality ? <> · <span className={css.quality} data-q={t.reviewQuality}>{QUALITY[t.reviewQuality] ?? `${t.reviewQuality} of 5`}</span></> : null}
      {t.reviewAbove ? <> · <span className={css.above}><Sparkles size={12} aria-hidden="true" />above and beyond</span></> : null}</>;
  } else if (t.status === "done" || t.status === "in_review") {
    tone = "success"; icon = <Check size={18} strokeWidth={2.6} />;
    const by = life?.doneBy ?? (t.assigneeId ? { id: t.assigneeId, name: t.assigneeName ?? "" } : null);
    line = <><b>Done</b>{by ? <> by <Person id={by.id} name={by.name} photoAt={by.id === t.assigneeId ? t.assigneePhotoAt : null} me={me} /></> : null}{t.doneAt ? <> · {when(t.doneAt)}</> : null}
      {life?.timing ? <> · <span className={css.timing} data-key={life.timing.key}>{life.timing.words}</span></> : null}</>;
    sub = <>Waiting for {reviewerName} review{life?.waited ? <> · <span className={css.waited} data-long={life.waited.includes("day") ? "" : undefined}>{life.waited}</span></> : null}
      {life?.mode === "acknowledge" ? " · leadership’s work is acknowledged, not graded" : null}</>;
  } else if (t.status === "blocked") {
    tone = "danger"; icon = <Hourglass size={18} />;
    const b = d.blockedBy[0];
    line = <><b>Blocked</b>{b ? <> · waiting on <Link href={`/tasks/${b.id}`}>“{b.title}”</Link>{b.assigneeName ? <> ({first(b.assigneeName)})</> : null}{d.blockedBy.length > 1 ? ` and ${d.blockedBy.length - 1} more` : ""}</> : " by hand"}</>;
    sub = b ? <>since {longDay(b.since)}{doer ? <> · {doer} carries on when it clears</> : null}</> : "Add what it waits on, so someone owns it and you hear when it clears.";
  } else if ((t.status === "open" || t.status === "in_progress") && due !== null && due < 0) {
    tone = "danger"; icon = <Flag size={18} />;
    line = <><b>{-due} day{due === -1 ? "" : "s"} late</b> · {dueWords}</>;
    sub = <>{doer ? <>{doer} {t.status === "in_progress" ? "is on it" : "has not started"}</> : "Nobody has it yet"}{t.startedAt ? ` · started ${longDay(t.startedAt)}` : ""}</>;
  } else if (t.status === "in_progress") {
    tone = "action"; icon = <Play size={18} />;
    line = <>{doer ?? <b>Nobody</b>} {t.assigneeId === me ? "are" : "is"} doing it{t.startedAt ? <> · since {longDay(t.startedAt)}</> : null}</>;
    sub = dueWords ?? "No deadline";
  } else if (t.status === "unknown") {
    tone = "neutral"; icon = <CircleDot size={18} />;
    line = <><b>No status yet</b>{doer ? <> · {doer}</> : null}</>;
    sub = t.source === "imported" ? "Imported from the team tracker: give it To do, Doing or Done once and Pulse keeps your choice." : dueWords ?? "No deadline";
  } else {
    tone = due === 0 ? "warning" : "neutral"; icon = <CircleDot size={18} />;
    line = <><b>To do</b>{doer ? <> · {doer}</> : t.poolScope ? " · in the pool" : " · nobody has it yet"}</>;
    sub = dueWords ?? "No deadline";
  }
  return <section className={css.banner} data-tone={tone} aria-label="Where this task stands">
    <span className={css.bannerIcon} aria-hidden="true">{icon}</span>
    <div className={css.bannerText}>
      <p className={css.bannerLine}>{line}</p>
      {sub ? <p className={css.bannerSub}>{sub}</p> : null}
      {life?.returned ? <p className={css.returned}><Undo2 size={13} aria-hidden="true" />Sent back by {life.returned.byId === me ? "you" : first(life.returned.by)} · {when(life.returned.at)}{life.returned.note ? <>: “{life.returned.note}”</> : null}</p> : null}
    </div>
    {actions ? <div className={css.bannerActions} data-dock={dock ? "" : undefined}>{actions}</div> : null}
  </section>;
}

// ------------------------------------------------------------------------------------------------- the timeline
const SENTENCE: Record<string, (e: Detail["events"][number]) => string> = {
  created: () => "created the task",
  edited: (e) => e.note ? e.note.replace(/^(\d+) min logged$/, "logged $1 min") : "edited the details",
  assigned: (e) => e.to === "Anyone" ? "took it off whoever had it" : e.from ? `gave it to ${e.to} (from ${first(e.from)})` : `gave it to ${e.to}`,
  reviewer: (e) => e.to ? `made ${e.to} the reviewer` : "removed the reviewer",
  blocked: (e) => `said it waits on “${e.to}”`, unblocked: (e) => e.from === "blocked" ? "can carry on: what it waited on is finished" : `cleared “${e.to}”`,
  proof: (e) => `attached proof: ${e.to}`, accepted: (e) => `accepted it${e.note ? ` · ${e.note}` : ""}`, acknowledged: (e) => e.note === "Accepted automatically: proof attached" ? "was accepted automatically: proof attached" : `acknowledged it${e.note ? `: “${e.note}”` : ""}`,
  returned: (e) => `sent it back: “${e.note ?? ""}”`, moved: (e) => e.to ? `moved it under “${e.to}”` : "made it a task of its own",
  asked: (e) => `asked ${e.to ?? "someone"} to take it`, joined: (e) => `added ${e.to ?? "someone"}`, pooled: (e) => `put it in the ${e.to === "Company" ? "company" : e.to} pool`,
  claimed: () => "claimed it from the pool", valued: (e) => `set the value to ${e.to ?? "none"} pts${e.from ? ` (was ${e.from})` : ""}${e.note && e.note !== "leadership" && e.note !== "creator" && e.note !== "reviewer" ? ` · ${e.note}` : ""}`,
  handover: () => "handed it over", unlocked: (e) => `was unlocked by “${e.to}”`, step: (e) => `ticked “${e.to ?? "a step"}”`, same: (e) => `linked it as the same work as “${e.to}”`,
  merged: (e) => `merged “${e.to}” into it`, deleted: () => "deleted it", restored: () => "restored it", flagged: () => "flagged it", resolved: (e) => `marked the open ${e.to ?? "subtasks"} as seen${e.note ? `: “${e.note}”` : ""}`,
  estimated: (e) => `estimated about ${String(e.to ?? "").replace(/\.0 h$/, " h")}${e.note ? ` (${e.note})` : ""}`, timer: (e) => e.note ?? "corrected the time", help: (e) => `asked for help${e.note ? `: “${e.note}”` : ""}`,
  // UX-5B: the companion's trail.
  auto_done: (e) => `marked it done itself. ${e.note ?? ""}`.trim(), signals: (e) => e.note ?? "changed what Pulse watches for", target: () => "chose where in Pulse this is done",
  repeat: (e) => e.note?.startsWith("Made by itself") ? e.note.replace(/^Made by itself: it/, "made it: it") : e.to ? `made it repeat every ${e.to}` : "stopped it repeating",
};
const STATUS_SENTENCE: Record<string, string> = { open: "moved it back to To do", in_progress: "started it", blocked: "marked it blocked", done: "marked it done", cancelled: "cancelled it", accepted: "accepted it", unknown: "cleared its status" };
const ICON: Record<string, ReactNode> = { created: <Plus size={13} />, edited: <Pencil size={13} />, assigned: <UserRound size={13} />, reviewer: <ShieldCheck size={13} />, blocked: <Hourglass size={13} />,
  unblocked: <Unlock size={13} />, proof: <Paperclip size={13} />, accepted: <BadgeCheck size={13} />, acknowledged: <BadgeCheck size={13} />, returned: <Undo2 size={13} />, moved: <CornerDownRight size={13} />,
  asked: <Hand size={13} />, joined: <UsersRound size={13} />, valued: <Gem size={13} />, step: <ListChecks size={13} />, deleted: <Trash2 size={13} />, restored: <RotateCcw size={13} />, flagged: <Flag size={13} />,
  resolved: <ShieldCheck size={13} />, timer: <Timer size={13} />, help: <MessageCircleQuestion size={13} />, auto_done: <Sparkles size={13} />, signals: <Sparkles size={13} />,
  target: <MapPin size={13} />, repeat: <Repeat size={13} /> };
function sentence(e: Detail["events"][number]) {
  if (e.kind === "status") return `${STATUS_SENTENCE[e.to ?? ""] ?? `moved it to ${e.to}`}${e.to === "in_progress" && e.from === "blocked" ? " again" : ""}${e.note ? `: “${e.note}”` : ""}`;
  return (SENTENCE[e.kind] ?? ((x) => `${x.kind}${x.to ? `: ${x.to}` : ""}`))(e);
}
function tone(e: Detail["events"][number]) {
  if (e.kind === "status") return e.to === "done" ? "success" : e.to === "blocked" ? "danger" : e.to === "cancelled" ? "muted" : "action";
  return e.kind === "accepted" || e.kind === "acknowledged" || e.kind === "auto_done" ? "success" : e.kind === "returned" || e.kind === "blocked" || e.kind === "flagged" ? "warning" : undefined;
}
/** The task's story: grouped by day (newest first), each line who did what, in words; the latest few open, the rest folded. */
export function Timeline({ events, me, now, task }: { events: Detail["events"]; me: string | null; now: number; task: Pick<Task, "source" | "createdAt"> }) {
  if (!events.length) return <p className={css.timelineEmpty}>{task.source === "imported" ? "Imported from the team tracker; nothing has happened in Pulse yet." : "Nothing has happened yet."}</p>;
  const today = istDay(new Date(now).toISOString());
  const label = (day: string) => { const n = daysBetween(day, today); return n === 0 ? "Today" : n === 1 ? "Yesterday" : longDay(day); };
  const groups: { day: string; items: Detail["events"] }[] = [];
  for (const e of events) { const day = istDay(e.at); const g = groups[groups.length - 1]; if (g && g.day === day) g.items.push(e); else groups.push({ day, items: [e] }); }
  const render = (gs: typeof groups) => gs.map((g) => <li key={g.day} className={css.day}>
    <h4>{label(g.day)}</h4>
    <ol>{g.items.map((e, i) => <li key={`${e.at}-${i}`} data-tone={tone(e)}>
      <span className={css.dot} aria-hidden="true">{e.kind === "status" ? e.to === "done" ? <Check size={13} /> : e.to === "blocked" ? <Hourglass size={13} /> : e.to === "cancelled" ? <Ban size={13} /> : <Play size={13} /> : ICON[e.kind] ?? <CircleDot size={13} />}</span>
      {e.by ? <Avatar name={e.by} id={e.byId ?? undefined} photoAt={e.byPhotoAt ?? null} size={22} /> : <span className={css.pulseFace} aria-hidden="true">P</span>}
      <p><b>{e.byId && e.byId === me ? "You" : e.by ? first(e.by) : "Pulse"}</b> {sentence(e)}</p>
      <time dateTime={e.at}>{time(e.at)}</time>
    </li>)}</ol>
  </li>);
  // The latest three days stay open; older days fold under one line.
  const shown = groups.slice(0, 3), older = groups.slice(3);
  return <div className={css.timeline}>
    <ol className={css.days}>{render(shown)}</ol>
    {older.length ? <details className={css.older}><summary>Show {older.reduce((n, g) => n + g.items.length, 0)} earlier change{older.reduce((n, g) => n + g.items.length, 0) === 1 ? "" : "s"}</summary><ol className={css.days}>{render(older)}</ol></details> : null}
  </div>;
}
