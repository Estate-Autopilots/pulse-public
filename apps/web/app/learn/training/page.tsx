import Link from "next/link";
import { GraduationCap, Settings2 } from "lucide-react";
import { api } from "../../lib/api";
import { day } from "../../lib/format";
import { standingLine, standingPercent } from "../../lib/training.mjs";
import { Badge, Empty, Message, Page, PageHeader, styles } from "../../ui";
import type { Mine } from "./types";
import css from "./training.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "My training" };

/** KAZUK-REST slice 7: My training: the company's courses assigned to this person (directly, as a channel partner or
 *  dealer, or by their role), each with how far they are. Course managers also get Manage courses. */
export default async function MyTraining() {
  const r = await api<Mine>("training");
  const head = (manage: boolean) => <PageHeader title="My training" back={{ href: "/learn", label: "Learn Pulse" }} context={["Courses your company assigned to you"]}
    actions={manage ? <Link href="/learn/training/manage" className={styles.btn}><Settings2 size={15} aria-hidden="true" />Manage courses</Link> : undefined} />;
  if (!r.data) return <Page>{head(false)}<Message text={r.error} /></Page>;
  const { courses, manage } = r.data;
  return <Page>
    {head(manage)}
    {courses.length ? <ul className={css.list} aria-label="My courses">{courses.map((c) => {
      const pct = standingPercent(c.standing);
      return <li key={c.id}><Link href={`/learn/training/${c.id}`} className={css.course}>
        <span className={css.courseTop}><strong>{c.title}</strong>{c.standing.done ? <Badge tone="success">Done</Badge> : c.dueOn ? <Badge tone="warning">Due {day(c.dueOn)}</Badge> : null}</span>
        {c.summary ? <span className={css.muted}>{c.summary}</span> : null}
        <span className={css.muted}>{standingLine(c.standing)}</span>
        <span className={css.bar} aria-label={`${pct} % done`}><i style={{ width: `${pct}%` }} /></span>
      </Link></li>;
    })}</ul> : <Empty icon={GraduationCap} title="No training assigned to you" text={manage ? "Make a course and assign it to your team or your channel partners." : "When your company assigns you a course, it shows here."}
      action={manage ? { href: "/learn/training/manage", label: "Manage courses" } : { href: "/learn", label: "Learn Pulse" }} />}
  </Page>;
}
