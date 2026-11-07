"use client";
import { openBugReport } from "./open";
import styles from "./bug-report.module.css";

/** SIGNED-OUT-SHELL: the signed-out pages' visible way to the bug reporter (a phone has no Ctrl+B, and the corner button
 *  stays off signed-out pages on a phone, where it covered their buttons). The sign-in page has its own line. */
export function ReportProblemLink({ title, className }: { title: string; className?: string }) {
  return <p className={className}><button type="button" className={styles.problemLink} onClick={() => openBugReport({ title })}>Something not working? Report a problem</button></p>;
}
