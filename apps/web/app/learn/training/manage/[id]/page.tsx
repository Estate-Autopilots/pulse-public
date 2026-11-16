import Link from "next/link";
import { Eye } from "lucide-react";
import { api, vocabulary } from "../../../../lib/api";
import { day } from "../../../../lib/format";
import { groupLabel, providerLabel, standingLine } from "../../../../lib/training.mjs";
import { Badge, Message, Page, PageHeader, Panel, styles } from "../../../../ui";
import { AddVideo, AssignForm, CourseForm, QuizEditor, RemoveButton } from "../../parts";
import type { Course, ReportRow } from "../../types";
import css from "../../training.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit course" };

/** KAZUK-REST slice 7: one course for its managers: details, videos (link or upload), the quiz with its answers, who it is
 *  assigned to, and who has and hasn't finished. */
export default async function EditCourse({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, report, words] = await Promise.all([api<Course>(`training/courses/${encodeURIComponent(id)}`), api<{ people: ReportRow[] }>(`training/courses/${encodeURIComponent(id)}/progress`), vocabulary()]);
  const back = { href: "/learn/training/manage", label: "Manage training" };
  if (!r.data || !r.data.manage) return <Page><PageHeader title="Edit course" back={back} /><Message text={r.error ?? "Training courses are managed by admins, leadership and HR."} /></Page>;
  const c = r.data, people = report.data?.people ?? [];
  const done = people.filter((p) => p.standing.done).length;
  return <Page>
    <PageHeader title={c.title} back={back} context={[c.status === "published" ? "Published" : c.status === "draft" ? "Draft" : "Archived", people.length ? `${done} of ${people.length} people done` : "Not assigned yet"]}
      actions={c.status === "published" ? <Link href={`/learn/training/${c.id}`} className={styles.btn}><Eye size={15} aria-hidden="true" />See it as a learner</Link> : undefined} />
    <Panel title="Course"><div style={{ padding: 14 }}><CourseForm course={c} /></div></Panel>
    <Panel title="Videos" sub={`${c.videos.length}`}>
      <div style={{ padding: 14, display: "grid", gap: 14 }}>
        {c.videos.length ? <ol className={css.list} aria-label="Videos">{c.videos.map((v, i) => <li key={v.id} className={css.video}>
          <div className={css.videoHead}><b>{i + 1}. {v.title}</b><RemoveButton path={`training/videos/${v.id}/remove`} label={`Remove ${v.title}`} what={`Remove the video ${v.title}`} /></div>
          <span className={css.muted}>{v.kind === "upload" ? `Uploaded${v.size ? ` · ${(v.size / 1048576).toFixed(1)} MB` : ""}` : `Link · ${providerLabel(v.provider)}`}{v.minutes ? ` · ${v.minutes} min` : ""}</span>
        </li>)}</ol> : <p className={css.muted}>No videos yet. Add a link or upload a short clip.</p>}
        <AddVideo courseId={c.id} />
      </div>
    </Panel>
    <Panel title="Quiz" sub={c.questions.length ? `${c.questions.length} ${c.questions.length === 1 ? "question" : "questions"} · pass mark ${c.passMark} %` : "None yet"}>
      <div style={{ padding: 14 }}><QuizEditor courseId={c.id} questions={c.questions} /></div>
    </Panel>
    <Panel title="Assigned to">
      <div style={{ padding: 14, display: "grid", gap: 14 }}>
        {c.assignments?.length ? <ul className={css.chips} aria-label="Assigned to">{c.assignments.map((a) => <li key={a.id} className={css.chip}>
          {a.kind === "person" ? a.name : groupLabel(a.kind, a.target, words.team, words.heads)}{a.dueOn ? ` · due ${day(a.dueOn)}` : ""}
          <RemoveButton path={`training/assignments/${a.id}/remove`} label={`Take back from ${a.kind === "person" ? a.name : groupLabel(a.kind, a.target, words.team, words.heads)}`} what="Take this assignment back" />
        </li>)}</ul> : <p className={css.muted}>Nobody yet.{c.status !== "published" ? " People see the course once it is published." : ""}</p>}
        <AssignForm courseId={c.id} people={c.people ?? []} team={words.team} />
      </div>
    </Panel>
    <Panel title="Who has finished" sub={people.length ? `${done} of ${people.length}` : undefined}>
      {people.length ? <div style={{ padding: "4px 14px 14px" }}><table className={css.people} aria-label="Who has finished">
        <thead><tr><th>Person</th><th>Group</th><th>Where they are</th></tr></thead>
        <tbody>{people.map((p) => <tr key={p.id}>
          <td>{p.name}</td><td>{groupLabel("side", p.side)}</td>
          <td>{p.standing.done ? <Badge tone="success">Done</Badge> : <Badge tone="warning">Not done</Badge>} {p.standing.done ? "" : standingLine(p.standing)}</td>
        </tr>)}</tbody>
      </table></div> : <p className={css.muted} style={{ padding: 14 }}>When the course is assigned, everyone who must take it shows here.</p>}
    </Panel>
  </Page>;
}
