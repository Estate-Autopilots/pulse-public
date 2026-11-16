import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { api } from "../../../lib/api";
import { Badge, Empty, Message, Page, PageHeader, Panel } from "../../../ui";
import { CourseForm } from "../parts";
import type { CourseRow } from "../types";
import css from "../training.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manage training" };

const STATUS: Record<CourseRow["status"], { label: string; tone: "neutral" | "success" | "warning" }> = {
  draft: { label: "Draft", tone: "warning" }, published: { label: "Published", tone: "success" }, archived: { label: "Archived", tone: "neutral" } };

/** KAZUK-REST slice 7: the company's courses for admins, leadership and HR: each with its videos, quiz, the people it is
 *  assigned to and how many have finished; and a new course. */
export default async function ManageTraining() {
  const r = await api<{ courses: CourseRow[] }>("training/courses");
  const head = <PageHeader title="Manage training" back={{ href: "/learn/training", label: "My training" }} context={["Courses for your team and your channel partners"]} />;
  if (!r.data) return <Page>{head}<Message text={r.error} /></Page>;
  const list = r.data.courses;
  return <Page>
    {head}
    <Panel title="Courses" sub={`${list.length}`}>
      {list.length ? <ul className={css.list} style={{ padding: 12 }} aria-label="Courses">{list.map((c) => <li key={c.id}><Link href={`/learn/training/manage/${c.id}`} className={css.course}>
        <span className={css.courseTop}><strong>{c.title}</strong><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></span>
        <span className={css.muted}>{c.videos} {c.videos === 1 ? "video" : "videos"} · {c.questions ? `${c.questions} quiz ${c.questions === 1 ? "question" : "questions"}` : "no quiz"} · {c.people ? `${c.done} of ${c.people} people done` : "not assigned yet"}</span>
      </Link></li>)}</ul> : <Empty icon={GraduationCap} title="No courses yet" text="Make the first one below: add videos, a short quiz, then assign it." />}
    </Panel>
    <Panel title="New course"><div style={{ padding: 14 }}><CourseForm /></div></Panel>
  </Page>;
}
