"use client";
// PM-UI: the interactive part of the project page: the phase strip card (clock line + nine segments) and the step list
// under it. Tapping a segment filters the list to that phase with local state when the page already holds that phase's
// list; otherwise the segment's link loads it (`?phase=<id>`). Under ~720 px of content (phone) the strip turns into
// nine small nodes on one connected line (number + two-line name under each), all nine across the card, no scrolling.
// The strip is drawn here, not with the kit's PhaseStrip, because this page needs what the kit strip lacks: a number
// dot per phase with a FILLED violet dot for "you are here", a diamond for the gate (Ads live), and the selected filter
// shown apart from the current phase (judge r1, fix 6 + nice-to-have).
import Link from "next/link";
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ClockLineVM, HueKey, Phase } from "../contract/shared";
import { ClockLine, fmtDayShort, hued } from "../kit";
import css from "./project-detail.module.css";

type SegState = "done" | "current" | "late" | "later";
const segState = (p: Phase): SegState => (p.status === "done" ? "done" : p.isCurrent ? "current" : p.status === "late" ? "late" : "later");

/** The nine phases as tappable segments: bar, marker (tick / number dot / gate diamond), name. */
function Strip({ phases, hue, hrefFor, selectedId }: { phases: Phase[]; hue: HueKey; hrefFor: (p: Phase) => string; selectedId: string | null }) {
  return <nav {...hued(hue, css.strip)} aria-label="Phases">
    <ol className={css.segs}>{phases.map((p, i) => {
      const st = segState(p);
      return <li key={p.id}>
        <Link href={hrefFor(p)} className={css.seg} data-state={st} data-selected={p.id === selectedId ? "" : undefined} aria-current={p.isCurrent ? "step" : undefined}
          aria-label={`${p.name} (phase ${i + 1}${p.isGate ? ", gate" : ""}${st === "done" ? ", done" : st === "current" ? ", current" : st === "late" ? ", late" : ""})`}>
          <i className={css.segBar} aria-hidden="true" />
          <span className={css.segMark} data-gate={p.isGate ? "" : undefined} aria-hidden="true">
            {p.isGate ? <i className={css.diamond} /> : st === "done" ? <Check /> : i + 1}
          </span>
          <span className={css.segNum} aria-hidden="true">{i + 1}</span>
          <span className={css.segName}>{p.name}</span>
        </Link>
      </li>;
    })}</ol>
  </nav>;
}

export function PhasePanel({ phases, hue, clockLine, selectedId, phaseHref, lists }: {
  phases: Phase[]; hue: HueKey; clockLine: ClockLineVM; selectedId: string | null;
  /** `/projects/<id>?phase={phase}`. */ phaseHref: string;
  /** The step-list card of each phase the page already holds, by phase id (drawn on the server). */ lists: Record<string, ReactNode>;
}) {
  const [selected, setSelected] = useState(selectedId);
  const strip = useRef<HTMLDivElement>(null);
  const hrefFor = (p: Phase) => phaseHref.replace("{phase}", encodeURIComponent(p.id));

  // Bring the selected (else current) phase into view inside the strip's own scroller; the page never scrolls sideways.
  useEffect(() => {
    const root = strip.current; if (!root) return;
    const nav = root.querySelector<HTMLElement>("nav"); const at = root.querySelector<HTMLElement>("[data-selected]") ?? root.querySelector<HTMLElement>('[aria-current="step"]');
    if (!nav || !at || nav.scrollWidth <= nav.clientWidth) return;
    const n = nav.getBoundingClientRect(), a = at.getBoundingClientRect();
    nav.scrollLeft += a.left - n.left - (n.width - a.width) / 2;
  }, [selected]);

  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const id = phases.find((p) => link.getAttribute("href") === hrefFor(p))?.id;
    if (id && lists[id]) { e.preventDefault(); setSelected(id); }
  };

  // The grey "selected" box marks a filter only: none while the list shows the current phase.
  const current = phases.find((p) => p.isCurrent)?.id ?? null;
  return <>
    <div className={css.stripCard} ref={strip} onClickCapture={pick}>
      {/* On a phone the clock line drops the day count the Clocks card already gives ("Day 0 of 45 · Ads live 5 Jan"). */}
      <div className={css.clockSlot}>
        <span className={css.clockFull}><ClockLine line={clockLine} /></span>
        {clockLine.state === "running"
          ? <span className={css.clockShort}><ClockLine line={{ state: "unset", note: `Day ${clockLine.day} of ${clockLine.of} · ${clockLine.target} ${fmtDayShort(clockLine.date)}` }} /></span>
          : null}
      </div>
      <Strip phases={phases} hue={hue} hrefFor={hrefFor} selectedId={selected && selected !== current ? selected : null} />
    </div>
    <div className={css.listSlot}>{selected ? lists[selected] ?? null : null}</div>
  </>;
}
