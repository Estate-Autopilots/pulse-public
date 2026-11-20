"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): "an admin triage view that groups duplicates by element and route". Open reports
// grouped by the screen and the first element the reporter picked (GET /api/v0/bug-reports/groups), biggest first; a
// group's numbers open each report. Also the picked elements drawn over a report's picture, and their threads.
import { Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { PinList, type Pin } from "../bug-report/pins";
import { Badge, styles as ui } from "../ui";
import css from "./groups.module.css";

type Group = { key: string; route: string; selector: string | null; label: string | null; component: string | null; n: number; people: number; last: string; reports: { id: string; number: number }[] };

export function BugGroups({ onOpen }: { onOpen: (id: string) => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/v0/bug-reports/groups", { cache: "no-store", signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)).then((d: { groups: Group[] } | null) => setGroups(d?.groups ?? [])).catch(() => {});
    return () => ctl.abort();
  }, []);
  const many = (groups ?? []).filter((g) => g.n > 1);
  if (!groups || !groups.length) return null;
  return <section className={css.groups} aria-label="Grouped by screen and element">
    <button type="button" className={css.head} aria-expanded={shown} onClick={() => setShown(!shown)} data-testid="bug-groups">
      <Layers size={15} aria-hidden="true" /><b>Grouped by screen and element</b>
      <small>{many.length ? `${many.length} place${many.length === 1 ? "" : "s"} reported more than once` : "No place reported twice yet"}</small>
    </button>
    {shown ? <ul className={css.list}>{groups.slice(0, 30).map((g) => <li key={g.key} className={css.row}>
      <span className={css.count}><Badge tone={g.n > 2 ? "danger" : g.n > 1 ? "warning" : "neutral"}>{g.n}</Badge></span>
      <span className={css.main}><b>{g.label ?? g.selector ?? "The whole screen"}{g.component ? ` · ${g.component}` : ""}</b>
        <small><span className={ui.mono}>{g.route}</span>{g.selector ? <> · <code>{g.selector}</code></> : null} · {g.people} {g.people === 1 ? "person" : "people"}</small></span>
      <span className={css.nums}>{g.reports.map((r) => <button key={r.id} type="button" className={css.num} onClick={() => onOpen(r.id)}>#{r.number}</button>)}</span>
    </li>)}</ul> : null}
  </section>;
}

/** The report's picture with the picked elements outlined and numbered where they were on the screen. */
export function PinnedPicture({ src, alt, pins }: { src: string; alt: string; pins: readonly Pin[] }) {
  return <span className={css.pinned}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a private picture streamed by the API */}
    <img src={src} alt={alt} />
    {pins.map((p, i) => p.vw && p.vh ? <span key={i} className={css.box} aria-hidden="true"
      style={{ left: `${(p.box.x / p.vw) * 100}%`, top: `${(p.box.y / p.vh) * 100}%`, width: `${(p.box.w / p.vw) * 100}%`, height: `${(p.box.h / p.vh) * 100}%` }}><i>{i + 1}</i></span> : null)}
  </span>;
}

/** The picked elements' threads on the triage panel; the team answers in each. */
export function PinThreads({ pins, onReply }: { pins: readonly Pin[]; onReply?: (index: number, text: string) => void }) {
  return <PinList pins={pins} onAdd={onReply} />;
}
