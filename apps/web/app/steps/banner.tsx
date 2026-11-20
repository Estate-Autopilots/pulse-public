import Link from "next/link";
import { ArrowRight, Workflow } from "lucide-react";
import { styles } from "../ui";
import css from "../sops/sops.module.css";

/** FLOW-C: on a Work task that is a process step, where it sits and the way to its own work screen. */
export function FlowStepBanner({ taskId, step }: { taskId: string; step: { id: string; runId: string; key: string; title: string; stateText: string; run: string; process: string } }) {
  return <div className={css.banner} role="note" aria-label="Process step">
    <span><Workflow size={16} aria-hidden="true" />Step {step.key} of <Link className={css.linkBtn} href={`/runs/${step.runId}?step=${encodeURIComponent(step.id)}`}>{step.process} · {step.run}</Link>: {step.stateText}</span>
    <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/steps/${encodeURIComponent(step.id)}?from=task:${encodeURIComponent(taskId)}`}>Open the work<ArrowRight size={14} aria-hidden="true" /></Link>
  </div>;
}
