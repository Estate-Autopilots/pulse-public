import Link from "next/link";
import { Pencil } from "lucide-react";
import { api } from "../../../lib/api";
import { standingLine, standingPercent } from "../../../lib/training.mjs";
import { Badge, Message, Page, PageHeader, styles } from "../../../ui";
import { LinkedVideo, Quiz, UploadedVideo } from "../parts";
import type { Course } from "../types";
import css from "../training.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Training course" };

/** KAZUK-REST slice 7: one course for the person taking it: its videos (an uploaded clip plays here and keeps how much
 *  was watched; a link opens on its own site with "I watched it"), then the quiz. Managers see it as learners do. */
export default async function TrainingCourse({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<Course>(`training/courses/${encodeURIComponent(id)}`);
  if (!r.data) return <Page><PageHeader title="Training course" back={{ href: "/learn/training", label: "My training" }} /><Message text={r.error} /></Page>;
  const c = r.data, s = c.standing, pct = standingPercent(s);
  const learner = c.assigned;
  return <Page>
    <PageHeader title={c.title} back={{ href: "/learn/training", label: "My training" }}
      context={[`${c.videos.length} ${c.videos.length === 1 ? "video" : "videos"}`, c.questions.length ? `quiz: ${c.questions.length} questions, pass mark ${c.passMark} %` : "no quiz"]}
      actions={c.manage ? <Link href={`/learn/training/manage/${c.id}`} className={styles.btn}><Pencil size={15} aria-hidden="true" />Edit course</Link> : undefined} />
    {c.summary ? <p className={css.muted} style={{ maxWidth: "72ch" }}>{c.summary}</p> : null}
    {s ? <div className={css.section}>
      <p className={css.muted}>{s.done ? <Badge tone="success">Done</Badge> : null} {standingLine(s)}</p>
      <span className={css.bar} aria-label={`${pct} % done`}><i style={{ width: `${pct}%` }} /></span>
    </div> : null}
    <section className={css.section} aria-labelledby="videos">
      <h3 id="videos">Videos</h3>
      {c.videos.length ? c.videos.map((v) => v.kind === "upload" ? <UploadedVideo key={v.id} video={v} learner={learner} /> : <LinkedVideo key={v.id} video={v} learner={learner} />)
        : <p className={css.muted}>No videos in this course yet.</p>}
    </section>
    {c.questions.length ? <section className={css.section} aria-labelledby="quiz">
      <h3 id="quiz">Quiz</h3>
      <p className={css.muted}>Choose one answer for each question. You pass with {c.passMark} % or more, and you can try again.</p>
      {learner ? <Quiz courseId={c.id} questions={c.questions} passMark={c.passMark} />
        : <p className={css.muted}>You manage this course but it is not assigned to you, so the quiz is shown in the editor only.</p>}
    </section> : null}
  </Page>;
}
