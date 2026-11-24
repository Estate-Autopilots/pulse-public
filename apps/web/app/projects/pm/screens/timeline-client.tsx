"use client";
// PM-UI 18 Timeline, interactive part: the phase list (phone) and the phase Gantt (tablet, laptop) with one phase that
// can be opened: a small popover by its bar from tablet up, a bottom sheet on a phone. Local state only; the server
// screen hands in every word, date and position already worked out (fixed locale), so nothing here formats dates.
import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import Link from "next/link";
import { CircleCheck, Database, Diamond, Flag, Image as ImageIcon, Laptop, Layers, ListChecks, Megaphone, Users, Video, X, type LucideIcon } from "lucide-react";
import type { TimelinePhaseIcon, TimelineStatus } from "../contract/timeline";
import { Chip, PmButton, PmSheet, type Tone } from "../kit";
import css from "./timeline.module.css";

const ICONS: Record<TimelinePhaseIcon, LucideIcon> = {
  flag: Flag, layers: Layers, video: Video, image: ImageIcon, laptop: Laptop, database: Database, users: Users, check: ListChecks, megaphone: Megaphone,
};

/** One phase, ready to draw. `x`/`w` are fractions of the chart (0–1); a gate has `w` 0 and sits at `x`. */
export type TLRow = {
  id: string; no: number; name: string; range: string; /** `range` split at its last space ("11–14" · "Nov") for a two-line label. */ head: string; tail: string; word: string; tone: Tone; status: TimelineStatus; current: boolean; gate: boolean;
  icon: TimelinePhaseIcon; href: string; x: number; w: number;
  /** Length class of the date words (a ≤ 8 chars, b = 9, c ≥ 10): how wide a bar must be to hold them inside. */ len: "a" | "b" | "c";
  /** Where the dates go when the bar is too short for them. */ side: "right" | "left";
  /** The Today line is just after this bar (≤ 7 days): on tablet its dates go on two lines so they never touch the line. */ near: boolean;
};
/** A clock: in the phone's clock card and as a marker above the bars. */
export type TLClock = { key: string; label: string; short: string; date: string; done: boolean; x: number; /** room to the next marker (fraction) */ room: number | null; end: boolean;
  /** The next marker is close: on tablet this label ends at its dot (grows left) so the two never touch. */ tight: boolean };
export type TLWeek = { n: number; range: string; /** "11 Nov" */ from: string; /** "17 Nov" */ to: string };

type Props = {
  rows: TLRow[] | null; clocks: TLClock[] | null; weeks: TLWeek[]; todayX: number; todayLabel: string;
  initialSelected: string | null; listHref: string; /** This page without an open phase (the sheet's close link). */ selfHref: string;
  /** Called when a phase opens or closes (real wiring may sync the URL). */ onSelect?: (id: string | null) => void;
};

const pct = (f: number) => `${(f * 100).toFixed(4)}%`;

export function TimelineBody({ rows, clocks, weeks, todayX, todayLabel, initialSelected, listHref, selfHref, onSelect }: Props) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const pick = (id: string | null) => { setSelected(id); onSelect?.(id); };
  const toggle = (id: string) => pick(selected === id ? null : id);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelected(null); onSelect?.(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onSelect]);

  const loading = !rows;
  const sel = rows?.find((r) => r.id === selected) ?? null;
  const total = rows?.length ?? 9;

  /* The kit sheet closes with a link; here it closes in place (the close link or a tap on the dimmed backdrop). */
  const sheetClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('a[aria-label="Close"]') || t === e.currentTarget.firstElementChild) { e.preventDefault(); pick(null); }
  };

  return <>
    {/* ---------- Phone: clocks in one row, then the phase list ---------- */}
    <div className={css.phone}>
      <section className={css.clockCard} aria-label="Clocks" aria-busy={loading || undefined}>
        {clocks ? clocks.map((c) => <div key={c.key} className={css.clockCell}>
          {c.done ? <CircleCheck className={css.clockDone} role="img" aria-label="Done" /> : <Diamond className={css.clockGate} role="img" aria-label="Planned" />}
          <span className={css.clockText}><span className={css.clockLabel}>{c.label}</span><span className={css.clockDate}>{c.date}</span></span>
        </div>) : [0, 1, 2].map((i) => <div key={i} className={css.clockCell}><i className={css.skelDot} /><span className={css.clockText}><i className={css.skel} data-w="m" /><i className={css.skel} data-w="s" /></span></div>)}
      </section>

      <ol className={css.list} aria-label="Phases" aria-busy={loading || undefined}>
        {rows ? rows.map((r) => {
          const Icon = ICONS[r.icon];
          return <li key={r.id}>
            <button type="button" className={css.item} data-current={r.current ? "" : undefined} aria-current={r.current ? "step" : undefined} aria-expanded={selected === r.id} onClick={() => toggle(r.id)}>
              <span className={css.itemIcon} aria-hidden="true"><Icon /></span>
              <span className={css.itemText}><span className={css.itemName}>{r.name}</span><span className={css.itemDate}>{r.range}</span></span>
              <Chip tone={r.tone}>{r.word}</Chip>
            </button>
          </li>;
        }) : Array.from({ length: total }, (_, i) => <li key={i}><span className={css.item} data-skeleton=""><span className={css.itemIcon} /><span className={css.itemText}><i className={css.skel} data-w="m" /><i className={css.skel} data-w="s" /></span><i className={css.skel} data-w="chip" /></span></li>)}
      </ol>

      <Link href={listHref} className={css.bigger}>Timeline works best on a bigger screen</Link>

      {sel ? <div className={css.sheetWrap} onClick={sheetClick}>
        <PmSheet title={sel.name} sub={`Phase ${sel.no} of ${total}`} closeHref={selfHref} label={`${sel.name} · ${sel.range} · ${sel.word}`}
          footer={<PmButton href={sel.href} variant="outline" size="lg" block>Open phase</PmButton>}>
          <p className={css.sheetLine}><span>{sel.range}</span><Chip tone={sel.tone}>{sel.word}</Chip></p>
        </PmSheet>
      </div> : null}
    </div>

    {/* ---------- Tablet and laptop: the phase Gantt ---------- */}
    <section className={css.chartCard} aria-label="Timeline chart" aria-busy={loading || undefined}>
      <div className={css.scroll}>
        <div className={css.gantt} style={{ "--weeks": weeks.length, "--x": todayX } as CSSProperties}>
          <div className={css.gHead}>
            <div className={css.corner}><span>Phase</span><span className={css.cornerStatus}>Status</span></div>
            <div className={css.weeks}>{weeks.map((w) => <div key={w.n} className={css.week}><b>Week {w.n}</b><span className={css.wRange}>{w.range}</span><span className={css.wFrom}>{w.from}</span><span className={css.wTo}>– {w.to}</span></div>)}</div>
          </div>

          <div className={css.gMarks}>
            <div />
            <div className={css.track} data-marks="">
              {clocks?.map((c) => <span key={c.key} className={css.mark} data-end={c.end ? "" : undefined} data-tight={c.tight && !c.end ? "" : undefined}
                style={c.end ? { right: pct(1 - c.x) } : { left: pct(c.x) }}>
                <b>{c.short}</b><span>{c.date}</span>
              </span>)}
              {clocks?.map((c) => <i key={c.key} className={css.markDot} data-planned={c.done ? undefined : ""} style={{ left: pct(c.x) }} aria-hidden="true" />)}
              {loading ? null : <span className={css.todayTag} style={{ left: pct(todayX) }}>{todayLabel}</span>}
            </div>
          </div>

          <ol className={css.gRows} aria-label="Phases">
            {rows ? rows.map((r, i) => <li key={r.id} className={css.gRow} data-selected={selected === r.id ? "" : undefined}>
              <span className={css.gName}><span className={css.gNo}>{r.no}.</span> {r.name}</span>
              <span className={css.gStatus}><Chip tone={r.tone}>{r.word}</Chip></span>
              <div className={css.track}>
                {i > 0 ? <i className={css.elbow} data-gate={r.gate ? "" : undefined} style={{ left: pct(r.x) }} aria-hidden="true" /> : null}
                {r.gate
                  ? <button type="button" className={css.gate} style={{ left: pct(r.x) }} aria-expanded={selected === r.id} onClick={() => toggle(r.id)} aria-label={`${r.name} · ${r.range} · ${r.word}`}>
                      <Diamond aria-hidden="true" /><span className={css.gateText}>{r.name} · {r.range}</span>
                    </button>
                  : <button type="button" className={css.bar} data-status={r.status} data-current={r.current ? "" : undefined} data-len={r.len} data-side={r.side} data-near={r.near ? "" : undefined}
                      style={{ left: pct(r.x), width: pct(r.w) }} aria-expanded={selected === r.id} onClick={() => toggle(r.id)} aria-label={`${r.name} · ${r.range} · ${r.word}`}>
                      <span className={css.barText}><span>{r.head}</span> <span>{r.tail}</span></span>
                    </button>}
                {selected === r.id ? <div className={css.pop} role="dialog" aria-label={`${r.name} · ${r.range} · ${r.word}`}
                  data-up={i >= rows.length - 3 ? "" : undefined} data-end={r.x + r.w > 0.62 ? "" : undefined}
                  style={r.x + r.w > 0.62 ? { right: pct(Math.max(0, 1 - r.x - r.w)) } : { left: pct(r.x) }}>
                  <div className={css.popHead}>
                    <p className={css.popTitle}>{r.name}</p>
                    <button type="button" className={css.popClose} aria-label="Close" onClick={() => pick(null)}><X aria-hidden="true" /></button>
                  </div>
                  <p className={css.popLine}><span>{r.range}</span><Chip tone={r.tone}>{r.word}</Chip></p>
                  <PmButton href={r.href} variant="outline" size="sm">Open phase</PmButton>
                </div> : null}
              </div>
            </li>) : Array.from({ length: total }, (_, i) => <li key={i} className={css.gRow}>
              <span className={css.gName}><i className={css.skel} data-w="m" /></span>
              <span className={css.gStatus}><i className={css.skel} data-w="chip" /></span>
              <div className={css.track} />
            </li>)}
          </ol>
          {loading ? null : <i className={css.todayLine} aria-hidden="true" />}
        </div>
      </div>

      <ul className={css.legend} aria-label="Legend">
        <li><i className={css.swatch} data-status="done" />Done</li>
        <li><i className={css.swatch} data-status="doing" />Doing</li>
        <li><i className={css.swatch} data-status="todo" />To do</li>
        <li><i className={css.swatch} data-status="waiting_client" />Waiting on client</li>
        <li><i className={css.swatch} data-status="late" />Late</li>
        <li className={css.legendGate}><Diamond aria-hidden="true" />Gate</li>
      </ul>
    </section>
  </>;
}
