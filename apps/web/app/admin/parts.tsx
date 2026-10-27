import { ScrollText } from "lucide-react";
import Link from "next/link";
import { Badge, Empty } from "../ui";
import { compact, when } from "./format";
import { ACTION_LABELS, type AuditRow } from "./types";
import css from "./admin.module.css";

// PULSE-ADMIN: pieces the console's pages share.
export function StatusBadge({ status, activation, rehearsal }: { status: string; activation?: string; rehearsal?: boolean }) {
  const main = status === "active" ? (activation === "trial" ? <Badge tone="accent">Trial</Badge> : <Badge tone="success">Active</Badge>)
    : status === "suspended" ? <Badge tone="danger">Suspended</Badge> : status === "setup" ? <Badge tone="warning">Being set up</Badge> : <Badge>{status}</Badge>;
  return <span className={css.badges}>{main}{rehearsal ? <Badge>Rehearsal</Badge> : null}</span>;
}

export function Meter({ used, limit }: { used: number; limit: number | null }) {
  if (!limit) return <span className={css.muted}>{compact(used)}</span>;
  const share = Math.min(1, used / limit);
  return <span className={css.meter} data-over={used > limit ? "" : undefined} title={`${used.toLocaleString("en-IN")} of ${limit.toLocaleString("en-IN")}`}>
    <span>{compact(used)} <small>of {compact(limit)}</small></span><span className={css.track}><i style={{ width: `${Math.round(share * 100)}%` }} /></span></span>;
}

export function AuditTable({ rows, showOrg = true }: { rows: AuditRow[]; showOrg?: boolean }) {
  if (!rows.length) return <Empty icon={ScrollText} compact title="Nothing recorded yet" />;
  return <div className={css.tableWrap}><table className={css.table} aria-label="Platform audit log">
    <thead><tr><th>When</th><th>Who</th><th>What</th>{showOrg ? <th>Organisation</th> : null}<th>About</th><th>Why</th></tr></thead>
    <tbody>{rows.map((a, i) => <tr key={a.id ?? `${a.at}:${i}`}>
      <td className={css.nowrap}>{when(a.at)}</td><td>{a.actor}</td>
      <td>{ACTION_LABELS[a.action] ?? a.action}</td>
      {showOrg ? <td>{a.orgId ? <Link href={`/admin/orgs/${a.orgId}`}>{a.org ?? "Organisation"}</Link> : <span className={css.muted}>Platform</span>}</td> : null}
      <td>{a.label ?? "—"}</td><td>{a.reason ?? <span className={css.muted}>—</span>}</td>
    </tr>)}</tbody></table></div>;
}

