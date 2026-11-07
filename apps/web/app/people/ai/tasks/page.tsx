// AI-TASKS (owner, 25 Oct 2026): what AI employees did with the tasks people gave them, and what it cost: given, sent for
// review, accepted, returned with a note, open (waiting, with a reviewer), hours from given to sent for review, sub-tasks
// they made for people, runs and tokens on tasks. Admins and leaders see every AI employee; a manager sees theirs
// (GET /api/v0/agents/tasks/throughput, agent_task_throughput decides).
import Link from "next/link";
import { api } from "../../../lib/api";
import { count } from "../../../lib/format";
import { Avatar, Message, Page, PageHeader, styles } from "../../../ui";

type Row = { id: string; name: string; title: string; manager: string | null; given: number; submitted: number; accepted: number; returned: number; open: number; waiting: number;
  inReview: number; hoursToReview: number | null; subtasks: number; runs: number; tokens: number; failedRuns: number; allTokens: number; perDay: { day: string; tokens: number; runs: number }[] };
const DAYS = [7, 14, 30] as const;

export default async function AiTaskThroughput({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const q = await searchParams, days = DAYS.find((d) => String(d) === q.days) ?? 14;
  const r = await api<{ days: number; agents: Row[] }>(`agents/tasks/throughput?days=${days}`);
  if (r.error) return <Message text={r.error} />;
  const rows = r.data!.agents;
  const sum = (k: keyof Row) => rows.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  return <Page>
    <PageHeader title="AI employees: tasks and cost" back={{ href: "/people", label: "Team" }}
      context={[`Last ${days} days`, rows.length ? `${count(sum("submitted"))} sent for review · ${count(sum("accepted"))} accepted · ${count(sum("tokens"))} tokens on tasks` : null]}
      actions={<nav aria-label="Period" style={{ display: "flex", gap: 6 }}>{DAYS.map((d) => <Link key={d} className={`${styles.btn}${d === days ? ` ${styles.btnPrimary}` : ""}`} href={`/people/ai/tasks?days=${d}`} aria-current={d === days ? "page" : undefined}>{d} days</Link>)}</nav>} />
    {rows.length ? <section className={styles.panel}><table className={styles.table}>
      <thead><tr><th scope="col">AI employee</th><th scope="col">Given</th><th scope="col">Sent for review</th><th scope="col">Accepted</th><th scope="col">Returned</th>
        <th scope="col">Open now</th><th scope="col">Hours to review</th><th scope="col">Sub-tasks for people</th><th scope="col">Runs on tasks</th><th scope="col">Tokens on tasks</th></tr></thead>
      <tbody>{rows.map((a) => <tr key={a.id}>
        <td><Link href={`/people/${encodeURIComponent(a.id)}?tab=ai&s=queue`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Avatar name={a.name} id={a.id} size={26} ai /><span><b>{a.name}</b><br /><small className={styles.muted}>{a.title}{a.manager ? ` · reports to ${a.manager}` : ""}</small></span></Link></td>
        <td>{count(a.given)}</td><td>{count(a.submitted)}</td><td>{count(a.accepted)}</td><td>{count(a.returned)}</td>
        <td>{count(a.open + a.inReview)}{a.waiting || a.inReview ? <small className={styles.muted}><br />{[a.waiting ? `${a.waiting} waiting` : null, a.inReview ? `${a.inReview} with a reviewer` : null].filter(Boolean).join(" · ")}</small> : null}</td>
        <td>{a.hoursToReview === null ? "–" : a.hoursToReview}</td><td>{count(a.subtasks)}</td>
        <td>{count(a.runs)}{a.failedRuns ? <small className={styles.muted}><br />{a.failedRuns} went wrong</small> : null}</td>
        <td>{count(a.tokens)}<small className={styles.muted}><br />{count(a.allTokens)} in all its work</small></td>
      </tr>)}</tbody>
    </table>
    <p className={styles.muted} style={{ margin: "12px 16px" }}>Hours to review: the middle value from being given the task to sending it for review. Tokens are what its AI reported for each run (cache reads included). A person reviews every task an AI employee finishes.</p>
    </section> : <section className={styles.panel}><p className={styles.muted} style={{ margin: 16 }}>No AI employee you manage. Admins and leaders see every AI employee here.</p></section>}
  </Page>;
}
