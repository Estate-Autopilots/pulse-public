"use client";
// PM-UI: the live part of 16 Notifications. "Mark all read" and opening a row clear unread dots on local state so the
// preview is clickable; pass `onRead` / `onReadAll` to wire the real writes later (e.g. `post()` from records.tsx).
import Link from "next/link";
import { useState } from "react";
import { BellOff } from "lucide-react";
import type { ActivityGroup, ActivityItem } from "../contract/notifications";
import { Chip, PmButton, ProjectTile } from "../kit";
import css from "./notifications.module.css";

/** "10:42": a 24-hour time, fixed locale and zone (no hydration drift). */
const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

type Props = {
  groups: ActivityGroup[];
  /** Skeleton rows (inert, no links). */
  loading: boolean;
  myDayHref: string;
  /** Called after an item is marked read locally. */
  onRead?: (id: string) => void;
  onReadAll?: () => void;
};

export function ActivityFeed({ groups, loading, myDayHref, onRead, onReadAll }: Props) {
  const [read, setRead] = useState<Record<string, true>>({});
  const isUnread = (i: ActivityItem) => i.unread && !read[i.id];
  const unread = loading ? 0 : groups.reduce((n, g) => n + g.items.filter(isUnread).length, 0);
  const mark = (i: ActivityItem) => { if (!isUnread(i)) return; setRead((r) => ({ ...r, [i.id]: true })); onRead?.(i.id); };
  const markAll = () => {
    const all: Record<string, true> = {};
    for (const g of groups) for (const i of g.items) all[i.id] = true;
    setRead(all); onReadAll?.();
  };

  return <div className={css.screen} aria-busy={loading || undefined}>
    <header className={css.head}>
      <h1 className={css.h1}>Activity</h1>
      {unread > 0 ? <span className={css.unread}>{unread} unread</span> : null}
      <button type="button" className={css.markAll} onClick={markAll} disabled={unread === 0}>Mark all read</button>
    </header>

    {!loading && groups.length === 0
      ? <section className={css.empty} aria-label="Nothing new">
          <span className={css.emptyIcon} aria-hidden="true"><BellOff /></span>
          <p className={css.emptyText}>Nothing new. Steps that need you will show here.</p>
          <PmButton href={myDayHref} size="lg">Open My day</PmButton>
        </section>
      : groups.map((g) => <section key={g.key} className={css.group} aria-labelledby={`act-${g.key}`}>
          <h2 id={`act-${g.key}`} className={css.groupTitle}>{g.title}</h2>
          <ul className={css.rows}>{g.items.map((i) => <Row key={i.id} item={i} unread={isUnread(i)} ghost={loading} onOpen={() => mark(i)} />)}</ul>
        </section>)}
  </div>;
}

function Row({ item, unread, ghost, onOpen }: { item: ActivityItem; unread: boolean; ghost: boolean; onOpen: () => void }) {
  const p = item.project;
  const primary = item.action.kind === "start";
  const titleText = <span className={css.titleText}>{unread ? <span className={css.srOnly}>Unread: </span> : null}{item.title}</span>;
  const body = <>
    <span className={css.title}>{titleText}</span>
    <span className={css.meta}><span className={css.metaText}><span className={css.project}>{p.name}</span> · {item.detail}</span></span>
  </>;
  return <li className={css.row} data-unread={unread ? "" : undefined} data-ghost={ghost ? "" : undefined} aria-hidden={ghost || undefined}>
    <span className={css.dot} aria-hidden="true" />
    <span className={css.tile}><ProjectTile project={p} /></span>
    {/* The text block (title + project line) is the row's link (32px+ tall); its ::after stretches over the whole row
        (the button sits above it). */}
    {ghost ? <span className={css.text}>{body}</span> : <Link href={item.href} className={css.text} onClick={onOpen}>{body}</Link>}
    <time className={css.time} dateTime={item.at}><span className={css.timeText}>{TIME.format(new Date(item.at))}</span></time>
    <span className={css.foot}>
      <span className={css.chipCell}><Chip tone={item.chip.tone}>{item.chip.word}</Chip></span>
      <span className={css.actCell}>
        {ghost
          ? <PmButton size="md" className={css.btn} disabled tabIndex={-1}>{item.action.label}</PmButton>
          : <PmButton href={item.action.href} variant={primary ? "primary" : "outline"} size="md" className={css.btn} onClick={onOpen}>{item.action.label}</PmButton>}
      </span>
    </span>
  </li>;
}
