"use client";
// FLOW-B: the Processes library. One grid, live first; a filter by where each stands and a search over names, steps,
// stages and roles. Each card: the name, one line, where it stands, its stage strip and who is involved.
import Link from "next/link";
import { useMemo, useState, type CSSProperties } from "react";
import { ArrowUpRight, CircleAlert, ClipboardList, Ellipsis, FileText, HardDrive, LayoutGrid, Library, Play, Search, Workflow } from "lucide-react";
import { Menu } from "../kit";
import { ago } from "../lib/format";
import { Empty, styles } from "../ui";
import { plural } from "../sops/parts";
import { STATUS_WORD, type ProcessCard, type ProcessStatus } from "./model";
import css from "./processes.module.css";

type Show = "all" | "live" | "drafted" | "written";
const SHOWS: { key: Show; label: string }[] = [{ key: "all", label: "All" }, { key: "live", label: "Live" }, { key: "drafted", label: "Steps drafted" }, { key: "written", label: "Written only" }];
const matches = (c: ProcessCard, show: Show) => show === "all" || (show === "live" ? c.status === "live" || c.status === "paused" : c.status === show);

export function ProcessLibrary({ cards, canEdit, initial }: { cards: ProcessCard[]; canEdit: boolean; initial: Show }) {
  const [show, setShow] = useState<Show>(initial), [q, setQ] = useState("");
  const counts = useMemo(() => Object.fromEntries(SHOWS.map((s) => [s.key, cards.filter((c) => matches(c, s.key)).length])) as Record<Show, number>, [cards]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = cards.filter((c) => matches(c, show) && words.every((w) => c.search.includes(w)));
  if (!cards.length) return <Empty icon={Workflow} first title="No processes yet"
    text={canEdit ? "A process is one way of working: what it is for, its steps, who does each, and every project going through it. Start from a template, a write-up, or a blank page." : "Leadership writes the company's processes here. Steps given to you appear in My steps."}
    action={canEdit ? { href: "/processes/new", label: "New process" } : { href: "/me/steps", label: "My steps" }} />;
  return <div className={css.area}>
    <div className={css.bar}>
      <div className={css.filter} role="group" aria-label="Show">
        {SHOWS.filter((s) => s.key === "all" || counts[s.key]).map((s) => <button key={s.key} type="button" className={css.filterBtn} aria-pressed={show === s.key} onClick={() => setShow(s.key)}>{s.label}<em>{counts[s.key]}</em></button>)}
      </div>
      <label className={css.search}><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a process, a step or a role" aria-label="Find a process" /></label>
    </div>
    <p className={css.lede}>A process is one way of working: its write-up, its steps and who does each, and every project going through it.</p>
    {shown.length ? <ul className={css.grid}>{shown.map((c, i) => <li key={c.key} style={{ "--i": i } as CSSProperties}><Card c={c} /></li>)}</ul>
      : <Empty icon={Search} compact title={q ? "Nothing matches" : "Nothing here"} text={q ? "Try a step's name, a stage or a role." : "Processes move here when they change."} />}
  </div>;
}

const ICON: Record<ProcessCard["kind"], typeof Workflow> = { sop: FileText, workflow: Workflow, board: LayoutGrid };

function Card({ c }: { c: ProcessCard }) {
  const Icon = ICON[c.kind];
  return <Link className={css.card} href={c.href} data-status={c.status}>
    <span className={css.head}>
      <span className={css.icon} aria-hidden="true"><Icon size={18} /></span>
      <span className={css.title}><b>{c.name}</b><small suppressHydrationWarning>{[c.steps ? plural(c.steps, "step") : "No steps yet", c.client ? `for ${c.client}` : null, `edited ${ago(c.updatedAt)}`].filter(Boolean).join(" · ")}</small></span>
      <Status status={c.status} running={c.running} />
    </span>
    {c.line ? <p className={css.line}>{c.line}</p> : null}
    {c.stages.length ? <div className={css.stages}>
      <span className={css.meter} aria-hidden="true">{c.stages.map((s, i) => <i key={i} data-slot={s.slot} style={{ flexGrow: s.steps }} />)}</span>
      <ol className={css.names} aria-label={c.stages.length > 1 ? plural(c.stages.length, "part") : "Steps"}>{c.stages.map((s, i) => <li key={i} data-slot={s.slot}>{s.label}{s.steps > 1 && c.stages.length > 1 ? <small>{s.steps}</small> : null}</li>)}</ol>
    </div> : <p className={css.line}>No steps yet: the write-up is all there is.</p>}
    <span className={css.foot}>
      {c.roles.length ? <span className={css.roles}>{c.roles.slice(0, 4).map((r, i) => <span key={r} className={css.role} data-slot={(i % 6) + 1}>{r}</span>)}
        {c.roles.length > 4 ? <span className={css.role}>+{c.roles.length - 4}</span> : null}</span> : <span className={css.muted}>Nobody named yet</span>}
      {c.late ? <span className={css.late}><CircleAlert size={12} aria-hidden="true" />{plural(c.late, "step")} late</span> : null}
      {c.fromDrive ? <span className={css.muted} title="Its write-up came from Google Drive"><HardDrive size={12} aria-hidden="true" />Drive</span> : null}
      <ArrowUpRight className={css.go} size={16} aria-hidden="true" />
    </span>
  </Link>;
}

function Status({ status, running }: { status: ProcessStatus; running: number }) {
  return <span className={css.status} data-status={status}><i />{STATUS_WORD[status]}{status === "live" && running ? <> · <Play size={10} aria-hidden="true" />{running} running</> : null}</span>;
}

/** The rest of the process area, out of the way: forms live inside steps, a write-up can still be typed by hand, and
 *  (on a phone, where the header has room for two buttons) Import from Drive. */
export function ProcessMore({ canEdit, waiting }: { canEdit: boolean; waiting: number }) {
  return <Menu label="More" className={styles.btn} buttonLabel="More" items={[
    { key: "libraries", label: "Libraries", hint: "Swipe files, reference videos, the word list", href: "/processes/libraries", icon: <Library size={15} aria-hidden="true" /> },
    { key: "forms", label: "Forms", hint: "The forms steps ask people to fill", href: "/sops/forms", icon: <ClipboardList size={15} aria-hidden="true" /> },
    ...(canEdit ? [{ key: "drive", label: "Import from Drive", hint: waiting ? `${waiting} write-ups waiting` : "Write-ups found in Drive", href: "/sops/drive", icon: <HardDrive size={15} aria-hidden="true" /> },
      { key: "write", label: "Write a process by hand", hint: "The write-up only, step by step", href: "/sops/new", icon: <FileText size={15} aria-hidden="true" /> }] : []),
  ]}><Ellipsis size={16} aria-hidden="true" /></Menu>;
}
