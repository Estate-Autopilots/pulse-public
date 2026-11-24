"use client";
// PM-UI 01 Projects home, interactive part: the search field and the filter chips switch the cards on the client (local
// state; the cards are drawn by the server and handed in). `onFilter` / `onQuery` let the real page also sync the URL
// (`?filter=`, `?q=`) or fetch the All list later.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Search, Moon, SearchX } from "lucide-react";
import type { ProjectFilter, ProjectFilterKey } from "../contract/projects-home";
import type { HealthKey } from "../contract/shared";
import { PmButton, PmCard } from "../kit";
import css from "./projects-home.module.css";

/** One server-drawn card plus what the filters and the search need to know about it. */
export type CardEntry = { id: string; health: HealthKey; mine: boolean; quiet: boolean; /** name + client, lower case */ text: string; node: ReactNode };

const passes = (c: CardEntry, f: ProjectFilterKey) =>
  f === "mine" ? c.mine : f === "at_risk" ? c.health === "at_risk" : f === "waiting_client" ? c.health === "waiting_client" : f === "quiet" ? c.quiet : true;

export function ProjectsHomeClient({ filters, initialFilter, initialQuery, cards, action, skeletons, onFilter, onQuery }: {
  filters: ProjectFilter[]; initialFilter: ProjectFilterKey; initialQuery: string; cards: CardEntry[];
  /** The "+ New project" button (or null). */ action: ReactNode;
  /** Skeleton cards while loading (replaces the list). */ skeletons: ReactNode;
  onFilter?: (key: ProjectFilterKey) => void; onQuery?: (q: string) => void;
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [query, setQuery] = useState(initialQuery);
  const chipRow = useRef<HTMLDivElement>(null);
  // Keep the selected chip in view inside its sideways-scrolling row (a phone shows about three chips).
  useEffect(() => {
    const row = chipRow.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip) return;
    const left = chip.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 8);
    else if (left + chip.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left + chip.offsetWidth - row.clientWidth + 8;
  }, [filter]);
  const pick = (k: ProjectFilterKey) => { setFilter(k); onFilter?.(k); };
  const type = (q: string) => { setQuery(q); onQuery?.(q); };
  const q = query.trim().toLowerCase();
  const shown = cards.filter((c) => passes(c, filter) && (!q || c.text.includes(q)));

  let body: ReactNode;
  if (skeletons) body = <ul className={css.grid} aria-busy="true" aria-label="Loading projects">{skeletons}</ul>;
  else if (shown.length) body = <ul className={css.grid} aria-label="Projects">{shown.map((c) => <Fragment key={c.id}>{c.node}</Fragment>)}</ul>;
  else if (q) body = <PmCard className={css.empty}>
    <span className={css.emptyIcon} aria-hidden="true"><SearchX /></span>
    <p className={css.emptyTitle}>No project matches “{query.trim()}”</p>
    <PmButton variant="text" onClick={() => type("")} className={css.emptyLink}>Clear search</PmButton>
  </PmCard>;
  else body = <PmCard className={css.empty}>
    <span className={css.emptyIcon} aria-hidden="true"><Moon /></span>
    <p className={css.emptyTitle}>{filter === "quiet" ? "No quiet projects." : "No projects here."}</p>
    <p className={css.emptyText}>{filter === "quiet" ? "Every project had activity in the last 14 days." : "Nothing matches this filter right now."}</p>
    <PmButton variant="outline" onClick={() => pick("all")}>Show all</PmButton>
  </PmCard>;

  return <div className={css.wrap}>
    <header className={css.header}>
      <h1 className={css.title}>Projects</h1>
      <label className={css.search}>
        <Search aria-hidden="true" />
        <input type="search" aria-label="Search projects" value={query} onChange={(e) => type(e.target.value)} placeholder="Search projects" autoComplete="off" />
      </label>
      {action ? <div className={css.action}>{action}</div> : null}
    </header>
    <div ref={chipRow} className={css.chips} role="group" aria-label="Filter projects">
      {filters.map((f) => <button key={f.key} type="button" className={css.filter} aria-pressed={f.key === filter} onClick={() => pick(f.key)}>
        {f.label}{f.count !== undefined ? ` (${f.count})` : ""}
      </button>)}
    </div>
    {body}
  </div>;
}
