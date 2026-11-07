"use client";
// EST-1737: AI employees in the Team list, for leaders and admins only (GET /api/v0/agents/team). An AI row has no presence
// dot, attendance, pod or sign-in: who it is, its owner, lane, state and the daily budget it has left.
import Link from "next/link";
import { AiBadge } from "../kit";
import { count } from "../lib/format";
import { Avatar, Badge, styles } from "../ui";
import css from "./people.module.css";

export type AiTeamRow = { id: string; employeeId: string; name: string; title: string; ownerName: string | null; lane: "quick" | "thinking"; status: "on" | "paused" | "off"; budgetLeft: number };

const LANE = { quick: "Quick lane", thinking: "Thinking lane" } as const;
const href = (a: AiTeamRow) => `/people/ai/${encodeURIComponent(a.id)}`;
const budget = (a: AiTeamRow) => `${count(Math.max(0, a.budgetLeft))} tokens left today`;
function State({ a }: { a: AiTeamRow }) {
  return a.status === "on" ? null : <Badge tone={a.status === "paused" ? "warning" : "neutral"}>{a.status === "paused" ? "Paused" : "Off"}</Badge>;
}

/** Does a Team search name this AI employee? Its name, employee ID, role or owner. */
export const aiMatch = (a: AiTeamRow, q: string) => !q || `${a.name} ${a.employeeId} ${a.title} ${a.ownerName ?? ""}`.toLowerCase().includes(q);

export function AiCards({ rows }: { rows: AiTeamRow[] }) {
  return <>{rows.map((a) => (
    <Link key={a.id} href={href(a)} className={`${css.card} ${css.tight}`} data-ai="" title={`${a.name} · ${a.title}`}>
      <Avatar name={a.name} size={44} ai />
      <span className={css.cardText}>
        <span className={css.cardHead}><span className={css.cardName}>{a.name}</span><AiBadge employeeId={a.employeeId} /></span>
        <span className={css.cardLine}><span className={css.cardRole}>{a.title}</span><span className={css.empId} title="Employee ID"><span className={styles.srOnly}>Employee ID </span>{a.employeeId}</span></span>
        <span className={css.cardTags}><Badge>{LANE[a.lane]}</Badge><State a={a} /></span>
        <span className={css.cardFacts}>{`${a.ownerName ? `Owner ${a.ownerName.split(/\s+/)[0]}` : "No owner"} · ${budget(a)}`}</span>
      </span>
    </Link>
  ))}</>;
}

/** `paged`: below the people table, so the head pages with these rows. */
export function AiTable({ rows, paged }: { rows: AiTeamRow[]; paged?: boolean }) {
  return <table className={styles.table}>
    <thead data-pager-head={paged ? "" : undefined}><tr><th scope="col">AI employee</th><th scope="col">Employee ID</th><th scope="col">Role</th><th scope="col">Owner</th><th scope="col" data-mid="">Lane</th><th scope="col">Budget left today</th><th scope="col">Status</th></tr></thead>
    <tbody>{rows.map((a) => (
      <tr key={a.id} data-ai="">
        <td><Link href={href(a)} className={styles.person}><Avatar name={a.name} size={32} ai /><span className={styles.nowrap}><span className={styles.cellLink}>{a.name}</span><AiBadge employeeId={a.employeeId} /></span></Link></td>
        <td className={`${styles.nowrap} ${styles.mono}`}>{a.employeeId}</td>
        <td><span className={css.clip} title={a.title}>{a.title}</span></td>
        <td className={styles.nowrap}>{a.ownerName ?? <span className={styles.muted}>No owner</span>}</td>
        <td data-mid="" className={styles.nowrap}>{LANE[a.lane]}</td>
        <td className={`${styles.nowrap} ${styles.num}`}>{count(Math.max(0, a.budgetLeft))} tokens</td>
        <td className={styles.nowrap}>{a.status === "on" ? <Badge>On</Badge> : <State a={a} />}</td>
      </tr>
    ))}</tbody>
  </table>;
}
