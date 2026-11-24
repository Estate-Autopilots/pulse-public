"use client";
// PM-UI: the live part of 04 My day: the hero "Your next step" and the groups of rows. Quick actions work on local state
// (Start → Doing, Submit → In review) so the preview is clickable; pass `onAction` / `onNeedHelp` to wire real writes.
// Phone: swipe a row right for its action (Start or Submit), left for Need help. Tablet/laptop: the "⋯" menu holds Need help.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type TouchEvent } from "react";
import { ArrowLeft, ArrowRight, MoreHorizontal, UserRound } from "lucide-react";
import type { MyDayAction, MyDayGroup, MyDayItem } from "../contract/my-day";
import type { IsoDate, StepStatus } from "../contract/shared";
import { Chip, DueText, LateFlag, PmButton, ProjectTile, StatusChip, firstName, fmtDay, fmtTime, nDays, stepViewer } from "../kit";
import css from "./my-day.module.css";

type Props = {
  today: IsoDate;
  hero: MyDayItem | null;
  groups: MyDayGroup[];
  /** Called after the local change; wire to the real write later (e.g. `post()` from records.tsx). */
  onAction?: (stepId: string, kind: "start" | "submit") => void;
  onNeedHelp?: (stepId: string) => void;
};

/** Where a touch began, per row (kept outside React state: it never affects what is drawn). */
const touchStarts = new WeakMap<EventTarget, { x: number; y: number }>();
type Swipe = { onTouchStart: (e: TouchEvent) => void; onTouchEnd: (e: TouchEvent) => void };
const START: MyDayAction = { kind: "start", label: "Start" };
const SUBMIT: MyDayAction = { kind: "submit", label: "Submit" };

/** The quick action that fits the step's current (possibly local) state; null once it is sent for review. */
function actionFor(item: MyDayItem, status: StepStatus): MyDayAction | null {
  if (item.action.kind === "review") return item.action;
  if (status === "todo" || status === "changes") return START;
  if (status === "doing") return SUBMIT;
  return null;
}
const NEXT: Record<"start" | "submit", StepStatus> = { start: "doing", submit: "in_review" };

/** "Due today, 5:00 PM" or "Due Mon, 23 Nov"; `short` (phone rows) drops "Due": "Today, 5:00 PM", "Mon, 23 Nov". */
function dueWords(item: MyDayItem, today: IsoDate, short = false): string {
  const { due, dueAt } = item.step;
  if (!due) return "No date yet";
  if (due === today) return `${short ? "Today" : "Due today"}${dueAt ? `, ${fmtTime(dueAt).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase())}` : ""}`;
  return short ? fmtDay(due) : `Due ${fmtDay(due)}`;
}

/** "project · from Ira · due" as parts with even dots between them (one line; the project name truncates first). */
function MetaLine({ parts, className }: { parts: { text: string; cls?: string }[]; className: string }) {
  // No whitespace between the spans: the dot's margins alone make the gap, the same on both sides.
  return <span className={className}>{parts.map((x, i) => <span key={i} className={css.metaPart}>{i > 0 ? <span className={css.dot} aria-hidden="true">·</span> : null}<span className={x.cls}>{x.text}</span></span>)}</span>;
}

export function MyDayList({ today, hero, groups, onAction, onNeedHelp }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<Record<string, StepStatus>>({});
  const [help, setHelp] = useState<Record<string, true>>({});
  const [menu, setMenu] = useState<string | null>(null);

  const statusOf = (item: MyDayItem) => status[item.step.id] ?? item.step.status;
  const act = (item: MyDayItem, a: MyDayAction) => {
    if (a.kind === "review") { router.push(a.href); return; }
    setStatus((s) => ({ ...s, [item.step.id]: NEXT[a.kind] }));
    onAction?.(item.step.id, a.kind);
  };
  const needHelp = (item: MyDayItem) => {
    setHelp((h) => ({ ...h, [item.step.id]: true }));
    setMenu(null);
    onNeedHelp?.(item.step.id);
  };

  // Close the "⋯" menu on an outside tap or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target instanceof Element && e.target.closest(`[data-menu="${menu}"]`))) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [menu]);

  // Swipe (phone): right = the row's action, left = Need help. A mostly sideways move of 64 px or more.
  const swipe = (item: MyDayItem): Swipe => ({
    onTouchStart: (e: TouchEvent) => { const t = e.touches[0]; touchStarts.set(e.currentTarget, { x: t.clientX, y: t.clientY }); },
    onTouchEnd: (e: TouchEvent) => {
      const from = touchStarts.get(e.currentTarget); touchStarts.delete(e.currentTarget);
      if (!from) return;
      const t = e.changedTouches[0]; const dx = t.clientX - from.x; const dy = t.clientY - from.y;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx > 0) { const a = actionFor(item, statusOf(item)); if (a) act(item, a); } else if (!help[item.step.id]) needHelp(item);
    },
  });

  return <>
    {hero ? <Hero item={hero} today={today} status={statusOf(hero)} helped={!!help[hero.step.id]} onAct={(a) => act(hero, a)} onHelp={() => needHelp(hero)} touch={swipe(hero)} /> : null}
    {groups.map((g) => <section key={g.key} className={css.group} aria-labelledby={`md-${g.key}`}>
      <h2 id={`md-${g.key}`} className={css.groupTitle}>{g.title} <span className={css.count}>({g.items.length})</span></h2>
      <ul className={css.rows}>{g.items.map((item) => {
        const st = statusOf(item);
        const a = actionFor(item, st);
        const s = { ...item.step, status: st };
        const late = s.late && st !== "done" && st !== "skipped" ? s.late : undefined;
        const p = s.project;
        return <li key={s.id} className={css.row} {...swipe(item)}>
          <span className={css.tileCell}>{p ? <ProjectTile project={p} /> : null}</span>
          {/* The whole title + chip + meta block is the row's link (one tall tap area). */}
          <Link href={item.href} className={css.main}>
            <span className={css.title}>{s.title}</span>
            <span className={css.stateCell}>{late && st === "todo" ? <LateFlag late={late} /> : <StatusChip status={st} who={stepViewer(s)} />}</span>
            {/* Long words from 600 px; the short form ("Ira", no "Due") keeps the phone row to two lines. */}
            {([false, true] as const).map((short) => <MetaLine key={String(short)} className={short ? css.metaShort : css.metaLong} parts={[
              ...(p ? [{ text: p.name, cls: css.project }] : []),
              ...(s.toReview && s.owner ? [{ text: short ? firstName(s.owner) : `from ${firstName(s.owner)}` }] : []),
              { text: dueWords(item, today, short) },
              ...(help[s.id] ? [{ text: "Help asked", cls: css.helped }] : []),
            ]} />)}
          </Link>
          <span className={css.actCell}>
            {a ? (a.kind === "review"
              ? <PmButton href={a.href} size="sm" className={css.rowBtn}>{a.label}</PmButton>
              : <PmButton size="sm" className={css.rowBtn} onClick={() => act(item, a)}>{a.label}</PmButton>)
              : <span className={css.sent}>Sent</span>}
          </span>
          <span className={css.moreCell} data-menu={s.id}>
            <button type="button" className={css.more} aria-label={`More for ${s.title}`} aria-haspopup="menu" aria-expanded={menu === s.id} onClick={() => setMenu(menu === s.id ? null : s.id)}>
              <MoreHorizontal aria-hidden="true" />
            </button>
            {menu === s.id ? <span className={css.menu} role="menu">
              <button type="button" role="menuitem" className={css.menuItem} disabled={!!help[s.id]} onClick={() => needHelp(item)}>{help[s.id] ? "Help asked" : "Need help"}</button>
              <Link role="menuitem" href={item.href} className={css.menuItem}>Open step</Link>
            </span> : null}
          </span>
        </li>;
      })}</ul>
    </section>)}
  </>;
}

function Hero({ item, today, status, helped, onAct, onHelp, touch }: { item: MyDayItem; today: IsoDate; status: StepStatus; helped: boolean; onAct: (a: MyDayAction) => void; onHelp: () => void; touch: Swipe }) {
  const s = { ...item.step, status };
  const late = s.late && status !== "done" && status !== "skipped" ? s.late : undefined;
  const a = actionFor(item, status);
  return <section className={css.hero} aria-labelledby="md-hero" {...touch}>
    <h2 id="md-hero" className={css.eyebrow}>Your next step</h2>
    <div className={css.heroMain}>
      <span className={css.heroTile}>{s.project ? <ProjectTile project={s.project} size="lg" /> : null}</span>
      <div className={css.heroText}>
        <p className={css.heroTitle}><Link href={item.href}>{s.title}</Link></p>
        {s.project ? <p className={css.heroProject}>{s.project.name}</p> : null}
        <div className={css.heroMeta}>
          {s.owner ? <span className={css.owner}><UserRound aria-hidden="true" />{s.toReview ? `From: ${firstName(s.owner)}` : `Owner: ${firstName(s.owner)}`}</span> : null}
          {status === "todo" ? null : <StatusChip status={status} who={stepViewer(s)} />}
          {late ? (item.lateReason ? <Chip tone="problem">Late · {nDays(late.days)} · {item.lateReason}</Chip> : <LateFlag late={late} />)
            : s.due === today ? <Chip tone="action">{dueWords(item, today)}</Chip> : <DueText due={s.due} today={today} at={s.dueAt} />}
          {helped ? <span className={css.helped}>Help asked</span> : null}
        </div>
      </div>
    </div>
    <div className={css.heroActions}>
      {a ? (a.kind === "review"
        ? <PmButton variant="primary" size="lg" href={a.href} className={css.heroBtn}>{a.label}</PmButton>
        : <PmButton variant="primary" size="lg" className={css.heroBtn} onClick={() => onAct(a)}>{a.label}</PmButton>)
        : <span className={css.sentHero}>Sent for review</span>}
      <p className={css.hint}>
        <span><ArrowRight aria-hidden="true" />{a?.kind === "submit" ? "Swipe right for Submit" : "Swipe right for Start or Done"}</span>
        <span><ArrowLeft aria-hidden="true" />Swipe left for Need help</span>
      </p>
      {helped ? null : <button type="button" className={css.helpLink} onClick={onHelp}>Need help</button>}
    </div>
  </section>;
}
