"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { reportError } from "./lib/telemetry.mjs";
import { openBugReport } from "./bug-report/open";
import { recordError } from "./bug-report/recorder";
import styles from "./ui.module.css";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // TELEMETRY: the error rate on /telemetry counts screens that could not load.
  useEffect(() => { reportError(error, "boundary"); recordError({ kind: "boundary", message: `${error.name}: ${error.message}` }); }, [error]);
  return (
    <div className={styles.page}>
      <section className={`${styles.panel} ${styles.message}`} role="alert">
        <div className={styles.empty} style={{ borderTop: 0 }}>
          <span className={styles.emptyIcon}><TriangleAlert size={16} aria-hidden="true" /></span>
          <p className={styles.emptyTitle}>This view could not load</p>
          <p className={styles.emptyText}>Your information is safe. Try again when your connection is ready.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}><button className={`${styles.btn} ${styles.btnPrimary}`} type="button" onClick={reset}>Try again</button>
          {/* BUG-REPORT: tell the team, with the error attached. */}<button className={styles.btn} type="button" onClick={() => openBugReport({ title: "This view could not load", reference: error.digest })}>Report this</button></div>
        </div>
      </section>
    </div>
  );
}
