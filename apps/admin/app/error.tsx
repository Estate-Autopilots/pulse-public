"use client";

import { RotateCcw } from "lucide-react";

import { Page, kitStyles } from "./ui/kit";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="admin-content" tabIndex={-1}>
      <Page>
        <section className={kitStyles.panel} role="alert">
          <div className={kitStyles.empty}>
            <p className={kitStyles.emptyTitle}>This page couldn’t be shown</p>
            <p className={kitStyles.emptyText}>
              No action was performed. Try again; if it keeps happening, send
              the reference to the team.
            </p>
            {error.digest ? (
              <code className={kitStyles.muted}>Trace {error.digest}</code>
            ) : null}
            <button className={kitStyles.button} type="button" onClick={reset}>
              <RotateCcw size={14} aria-hidden="true" />
              Try again
            </button>
          </div>
        </section>
      </Page>
    </main>
  );
}
