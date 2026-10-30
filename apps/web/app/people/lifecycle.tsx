import Link from "next/link";
import { dayYear } from "../lib/format";
import { LEFT_LABEL, STAGE_LABEL, type PersonLifecycle } from "../hr/moves/types";
import { Panel } from "../ui";
import css from "../hr/moves/moves.module.css";

const FIELD: Record<string, string> = { role: "Role", pod: `Pod`, department: "Team", manager: "Head" };

/** Every move of one person, newest first: stages, role/pod/team changes and HR's review decisions, dated and by whom. */
export function LifecycleTimeline({ life, name }: { life: PersonLifecycle; name: string }) {
  const first = name.split(" ")[0];
  const open = life.cases.find((c) => c.status === "open");
  return <Panel title="Moves" sub={`${STAGE_LABEL[life.stage]}${life.since ? ` since ${dayYear(life.since)}` : ""}`}
    action={open ? { href: `/hr/moves/${open.id}`, label: open.kind === "leaving" ? "Leaving checklist" : "Joining checklist" } : undefined}>
    {life.events.length ? <ul className={css.timeline} style={{ padding: "4px 14px 10px" }}>{life.events.map((e) => <li key={e.id}>
      <span>{e.kind === "stage" ? <>{e.from ? `${STAGE_LABEL[e.from]} → ` : ""}<b>{e.to ? STAGE_LABEL[e.to] : ""}</b>{e.leftType ? ` (${LEFT_LABEL[e.leftType].toLowerCase()})` : ""}{(e.detail as { via?: string }).via === "record" ? " · changed on the record" : ""}</>
        : e.kind === "change" ? Object.entries(e.detail as Record<string, { from: string | null; to: string | null }>).map(([k, v]) => `${FIELD[k] ?? k}: ${v.from ?? "–"} → ${v.to ?? "–"}`).join(" · ")
        : <>Review: {String((e.detail as { decision?: string }).decision ?? "")}</>}</span>
      <small>{dayYear(e.on)} · {e.by ?? "Pulse"}{e.note ? ` · “${e.note}”` : ""}</small></li>)}</ul>
      : <p className={css.note} style={{ padding: "4px 14px 12px" }}>No moves recorded for {first} yet. They are kept from the first one, dated and attributed.</p>}
    {life.cases.filter((c) => c.status !== "open").length ? <p className={css.note} style={{ padding: "0 14px 12px" }}>Earlier checklists: {life.cases.filter((c) => c.status !== "open").map((c, i) => <span key={c.id}>{i ? ", " : ""}<Link href={`/hr/moves/${c.id}`}>{c.kind} {dayYear(c.effectiveOn)}</Link></span>)}</p> : null}
  </Panel>;
}
