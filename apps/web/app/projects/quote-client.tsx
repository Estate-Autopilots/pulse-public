"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FolderPlus, FolderOpen } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";
import css from "./overview.module.css";

/** KAZUK (Kazuk's screen 0): an accepted quotation starts its project. Every line that was sold becomes work for the lead
 *  (pulse.project_from_quote, migration 1301); running it again adds only what is missing. */
export function QuoteToProject({ documentId, project, people }: { documentId: string; project: { projectId: string | null; title: string | null }; people: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const r = await post<{ projectId: string; created: boolean; tasks: number }>("projects/from-quote", { documentId, leadId: f.get("leadId") || null, startsOn: f.get("startsOn") || null });
      notify({ id: "from-quote", tone: "success", title: r.created ? "Project started" : "Project brought up to date", message: `${r.tasks} ${r.tasks === 1 ? "task" : "tasks"} made from the quotation.`, timeout: 4000 });
      setOpen(false); router.push(`/tasks/projects/${r.projectId}`);
    } catch (err) { setError(err instanceof Error ? err.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  return <>
    {project.projectId ? <Link className={styles.btn} href={`/tasks/projects/${project.projectId}`}><FolderOpen size={13} aria-hidden="true" />Open the project</Link> : null}
    <button type="button" className={`${styles.btn} ${project.projectId ? "" : styles.btnPrimary}`} onClick={() => setOpen(true)}><FolderPlus size={13} aria-hidden="true" />{project.projectId ? "Add missing lines as tasks" : "Start the project"}</button>
    {open ? <Modal title={project.projectId ? `Bring ${project.title ?? "the project"} up to date` : "Start the project from this quotation"} onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="from-quote" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{project.projectId ? "Add the tasks" : "Start the project"}</button></div>}>
      <form id="from-quote" onSubmit={save} className={css.form}>
        <p className={css.hint}>Every line that was sold becomes work: a quantity of 2 videos is two tasks, a monthly line is one. The project then shows sold against delivered, and anything outside the quote can become an add-on quotation.</p>
        <div className={css.twoFields}>
          <label className={styles.field}>Lead (PGS)<SelectField name="leadId" defaultValue=""><option value="">Choose later</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
          <label className={styles.field}>Kick-off day<DateField name="startsOn" /></label>
        </div>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}
  </>;
}
