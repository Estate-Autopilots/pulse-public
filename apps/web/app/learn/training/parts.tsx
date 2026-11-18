"use client";
// KAZUK-REST slice 7: Learn → Training's interactive parts: watching a video (progress kept at 25/50/75/90/100 %), a
// linked video's "I watched it", taking the quiz, and the manager's forms (course, videos, quiz, assignments).
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Check, ExternalLink, Plus, Trash2, Upload, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { styles } from "../../ui";
import { SelectField } from "../../kit/select-field";
import { ROLES, SIDES, groupLabel, milestone, providerLabel } from "../../lib/training.mjs";
import type { Assignment, Course, Question, Video } from "./types";
import css from "./training.module.css";
import { useConfirm } from "../../kit/dialogs";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
const failed = (title: string, e: unknown) => notify({ id: "training", tone: "error", title, message: message(e) });

/** An uploaded clip plays here; the share watched is kept as it passes each milestone. */
export function UploadedVideo({ video, learner }: { video: Video; learner: boolean }) {
  const kept = useRef(video.percent);
  const [percent, setPercent] = useState(video.percent);
  const sending = useRef(false);
  const tick = async (el: HTMLVideoElement) => {
    const m = milestone(el.currentTime, el.duration, kept.current);
    if (!learner || m === null || sending.current) return;
    sending.current = true;
    try { await post(`training/videos/${video.id}/seen`, { percent: m }); kept.current = m; setPercent(m); } catch { /* the next milestone tries again */ } finally { sending.current = false; }
  };
  return <div className={css.video}>
    <div className={css.videoHead}><b>{video.title}</b><span className={css.muted}>{percent >= 90 ? "Watched" : percent ? `${percent} % watched` : video.minutes ? `${video.minutes} min` : "Not watched yet"}</span></div>
    <video controls preload="metadata" playsInline src={`/api/v0/training/videos/${video.id}/file`} onTimeUpdate={(e) => void tick(e.currentTarget)} onEnded={(e) => void tick(e.currentTarget)} aria-label={video.title} />
  </div>;
}

/** A linked video opens on its own site; the learner says when they have watched it. */
export function LinkedVideo({ video, learner }: { video: Video; learner: boolean }) {
  const [percent, setPercent] = useState(video.percent), [busy, setBusy] = useState(false);
  const router = useRouter();
  const watched = async () => {
    setBusy(true);
    try { await post(`training/videos/${video.id}/seen`, { percent: 100 }); setPercent(100); router.refresh(); } catch (e) { failed("Not kept", e); } finally { setBusy(false); }
  };
  return <div className={css.video}>
    <div className={css.videoHead}><b>{video.title}</b><span className={css.muted}>{percent >= 90 ? "Watched" : video.minutes ? `${video.minutes} min` : "Not watched yet"}</span></div>
    <div className={css.row}>
      <a className={styles.btn} href={video.url ?? "#"} target="_blank" rel="noreferrer noopener">Watch on {providerLabel(video.provider)}<ExternalLink size={14} aria-hidden="true" /></a>
      {learner && percent < 90 ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void watched()} disabled={busy}><Check size={15} aria-hidden="true" />{busy ? "Saving…" : "I watched it"}</button> : null}
    </div>
  </div>;
}

type Result = { score: number; passed: boolean; passMark: number; right: number; questions: number; wrong: number[] };

/** The course's quiz: one choice per question; the score comes back from Pulse, with the questions to look at again. */
export function Quiz({ courseId, questions }: { courseId: string; questions: Question[]; passMark: number }) {
  const [answers, setAnswers] = useState<(number | null)[]>(() => questions.map(() => null));
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Result | null>(null);
  const router = useRouter();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (answers.some((a) => a === null)) { notify({ id: "training", tone: "error", title: "Answer every question", message: "Choose one answer for each question, then send." }); return; }
    setBusy(true);
    try { const r = await post<Result>(`training/courses/${courseId}/attempt`, { answers }); setResult(r); router.refresh(); } catch (err) { failed("Not sent", err); } finally { setBusy(false); }
  };
  const wrong = new Set(result?.wrong ?? []);
  return <form className={css.section} onSubmit={(e) => void submit(e)} aria-label="Quiz">
    <ol className={css.quiz}>{questions.map((q, i) => <li key={q.id} className={`${css.question}${wrong.has(i + 1) ? ` ${css.wrong}` : ""}`}>
      <fieldset><legend>{i + 1}. {q.prompt}</legend>
        {q.options.map((o, j) => <label key={j} className={css.choice}><input type="radio" name={`q-${q.id}`} checked={answers[i] === j} onChange={() => setAnswers((a) => a.map((x, k) => (k === i ? j : x)))} />{o}</label>)}
      </fieldset>
      {wrong.has(i + 1) ? <p className={css.muted}>Look at this one again.</p> : null}
    </li>)}</ol>
    {result ? <p className={css.result} role="status" data-passed={result.passed}>{result.passed ? `Passed: ${result.score} % (pass mark ${result.passMark} %).` : `${result.score} %: not passed yet (pass mark ${result.passMark} %). ${result.right} of ${result.questions} right; try again.`}</p> : null}
    <div className={css.row}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Checking…" : result ? "Send again" : "Send answers"}</button></div>
  </form>;
}

/** Make or change a course: title, what it covers, the pass mark and whether people can see it. */
export function CourseForm({ course }: { course?: Pick<Course, "id" | "title" | "summary" | "passMark" | "status"> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = { title: f.get("title"), summary: f.get("summary"), passMark: Number(f.get("passMark")), status: f.get("status") };
    setBusy(true);
    try {
      if (course) { await post(`training/courses/${course.id}`, body); notify({ id: "training", tone: "success", title: "Course saved", timeout: 3000 }); router.refresh(); }
      else { const r = await post<{ id: string }>("training/courses", body); router.push(`/learn/training/manage/${r.id}`); }
    } catch (err) { failed("Not saved", err); } finally { setBusy(false); }
  };
  return <form className={css.form} onSubmit={(e) => void submit(e)} aria-label={course ? "Course" : "New course"}>
    <label>Title<input className={styles.input} name="title" required maxLength={160} defaultValue={course?.title ?? ""} placeholder="For example: Installing the starter kit" /></label>
    <label>What it covers<textarea className={styles.input} name="summary" rows={3} maxLength={2000} defaultValue={course?.summary ?? ""} /></label>
    <div className={css.two}>
      <label>Pass mark for the quiz (%)<input className={styles.input} name="passMark" type="number" min={1} max={100} required defaultValue={course?.passMark ?? 70} /></label>
      <label>Who can see it<SelectField className={styles.input} name="status" defaultValue={course?.status ?? "draft"}>
        <option value="draft">Draft: only course managers</option>
        <option value="published">Published: the people it is assigned to</option>
        <option value="archived">Archived: hidden</option>
      </SelectField></label>
    </div>
    <div className={css.row}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : course ? "Save course" : "Make course"}</button></div>
  </form>;
}

const toBase64 = (file: File) => new Promise<string>((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(new Error("This file could not be read"));
  r.readAsDataURL(file);
});

/** Add a video: paste a link (YouTube, Vimeo, Google Drive or any https page) or upload a clip up to 25 MB. */
export function AddVideo({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"link" | "upload">("link"), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    const base = { title: f.get("title"), minutes: f.get("minutes") || null };
    setBusy(true);
    try {
      if (mode === "upload") {
        const file = f.get("file");
        if (!(file instanceof File) || !file.size) throw new Error("Choose a video file");
        if (file.size > 25 * 1024 * 1024) throw new Error("Videos up to 25 MB can be uploaded; link a longer one");
        await post(`training/courses/${courseId}/videos`, { ...base, name: file.name, mime: file.type, bytes: await toBase64(file) });
      } else await post(`training/courses/${courseId}/videos`, { ...base, url: f.get("url") });
      form.reset(); notify({ id: "training", tone: "success", title: "Video added", timeout: 3000 }); router.refresh();
    } catch (err) { failed("Not added", err); } finally { setBusy(false); }
  };
  return <form className={css.form} onSubmit={(e) => void submit(e)} aria-label="Add a video">
    <div className={css.row} role="group" aria-label="How to add it">
      <button type="button" className={`${styles.btn} ${mode === "link" ? styles.btnPrimary : ""}`} aria-pressed={mode === "link"} onClick={() => setMode("link")}><ExternalLink size={14} aria-hidden="true" />Link</button>
      <button type="button" className={`${styles.btn} ${mode === "upload" ? styles.btnPrimary : ""}`} aria-pressed={mode === "upload"} onClick={() => setMode("upload")}><Upload size={14} aria-hidden="true" />Upload</button>
    </div>
    <div className={css.two}>
      <label>Video title<input className={styles.input} name="title" required maxLength={160} /></label>
      <label>Length in minutes (optional)<input className={styles.input} name="minutes" type="number" min={1} max={600} /></label>
    </div>
    {mode === "link" ? <label>Link<input className={styles.input} name="url" type="url" required placeholder="https://…" maxLength={500} /></label>
      : <label>Video file (MP4, WebM or MOV, up to 25 MB)<input className={styles.input} name="file" type="file" accept="video/mp4,video/webm,video/quicktime" required /></label>}
    <div className={css.row}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}><Plus size={15} aria-hidden="true" />{busy ? "Adding…" : "Add video"}</button></div>
  </form>;
}

/** Remove a video or take an assignment back. */
export function RemoveButton({ path, label, what }: { path: string; label: string; what: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!(await confirm({ title: `${what}?`, body: "You can add it again later.", confirmLabel: /^take/i.test(what) ? "Take it back" : "Remove", danger: true }))) return;
    setBusy(true);
    try { await post(path, {}); router.refresh(); } catch (e) { failed("Not done", e); } finally { setBusy(false); }
  };
  return <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => void go()} disabled={busy} aria-label={label} title={label}><Trash2 size={14} aria-hidden="true" /></button>;
}

type Draft = { prompt: string; options: string[]; answer: number };

/** The quiz editor: questions with 2 to 6 choices each and the right one marked; saved as a whole. */
export function QuizEditor({ courseId, questions }: { courseId: string; questions: Question[] }) {
  const router = useRouter();
  const [list, setList] = useState<Draft[]>(() => questions.map((q) => ({ prompt: q.prompt, options: [...q.options], answer: q.answer ?? 0 })));
  const [busy, setBusy] = useState(false);
  const set = (i: number, d: Partial<Draft>) => setList((l) => l.map((q, k) => (k === i ? { ...q, ...d } : q)));
  const save = async () => {
    setBusy(true);
    try { await post(`training/courses/${courseId}/quiz`, { questions: list }); notify({ id: "training", tone: "success", title: "Quiz saved", timeout: 3000 }); router.refresh(); }
    catch (e) { failed("Not saved", e); } finally { setBusy(false); }
  };
  return <div className={css.form}>
    {list.map((q, i) => <div key={i} className={css.qEdit} role="group" aria-label={`Question ${i + 1}`}>
      <label>Question {i + 1}<input className={styles.input} value={q.prompt} maxLength={500} onChange={(e) => set(i, { prompt: e.target.value })} /></label>
      {q.options.map((o, j) => <div key={j} className={css.row}>
        <input type="radio" name={`answer-${i}`} checked={q.answer === j} onChange={() => set(i, { answer: j })} aria-label={`Choice ${j + 1} is the right answer`} />
        <input className={styles.input} style={{ flex: 1, minWidth: 0 }} value={o} maxLength={200} aria-label={`Choice ${j + 1}`} onChange={(e) => set(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} />
        {q.options.length > 2 ? <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} aria-label={`Remove choice ${j + 1}`} onClick={() => set(i, { options: q.options.filter((_, k) => k !== j), answer: q.answer === j ? 0 : q.answer > j ? q.answer - 1 : q.answer })}><X size={14} aria-hidden="true" /></button> : null}
      </div>)}
      <div className={css.row}>
        {q.options.length < 6 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => set(i, { options: [...q.options, ""] })}>Add a choice</button> : null}
        <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => setList((l) => l.filter((_, k) => k !== i))}>Remove question</button>
      </div>
      <p className={css.muted}>Tick the right answer.</p>
    </div>)}
    <div className={css.row}>
      {list.length < 20 ? <button type="button" className={styles.btn} onClick={() => setList((l) => [...l, { prompt: "", options: ["", ""], answer: 0 }])}><Plus size={15} aria-hidden="true" />Add a question</button> : null}
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save quiz"}</button>
    </div>
  </div>;
}

/** Assign the course to one person, a group (e.g. partners and dealers) or everyone holding a role. */
export function AssignForm({ courseId, people, team }: { courseId: string; people: { id: string; name: string; side: string }[]; team: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Assignment["kind"]>("side"), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await post(`training/courses/${courseId}/assign`, { kind, personId: kind === "person" ? f.get("personId") : undefined, target: kind === "person" ? undefined : f.get("target"), dueOn: f.get("dueOn") || null });
      notify({ id: "training", tone: "success", title: "Assigned", timeout: 3000 }); router.refresh();
    } catch (err) { failed("Not assigned", err); } finally { setBusy(false); }
  };
  return <form className={css.form} onSubmit={(e) => void submit(e)} aria-label="Assign this course">
    <div className={css.two}>
      <label>Assign to<SelectField className={styles.input} value={kind} onChange={(e) => setKind(e.target.value as Assignment["kind"])}>
        <option value="side">A group of people</option><option value="role">Everyone with a role</option><option value="person">One person</option>
      </SelectField></label>
      {kind === "person" ? <label>Person<SelectField className={styles.input} name="personId" required defaultValue="">
          <option value="" disabled>Choose a person…</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.side !== "staff" ? ` (${groupLabel("side", p.side)})` : ""}</option>)}
        </SelectField></label>
        : <label>{kind === "side" ? "Group" : "Role"}<SelectField key={kind} className={styles.input} name="target" defaultValue={kind === "side" ? "channel_partner" : "member"}>
          {(kind === "side" ? SIDES : ROLES).map((t) => <option key={t} value={t}>{groupLabel(kind, t, team)}</option>)}
        </SelectField></label>}
    </div>
    <label>Due by (optional)<input className={styles.input} name="dueOn" type="date" /></label>
    <div className={css.row}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Assigning…" : "Assign"}</button></div>
  </form>;
}
