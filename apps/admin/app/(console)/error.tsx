"use client";

import { RotateCcw } from "lucide-react";

import { Page, kitStyles } from "@/app/ui/kit";

/** One card with Try again. Nothing was changed; the shell stays usable. */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Page>
      <section className={kitStyles.panel} role="alert">
        <div className={kitStyles.empty}>
          <p className={kitStyles.emptyTitle}>This page couldn’t be shown</p>
          <p className={kitStyles.emptyText}>
            Nothing was changed. Try again; if it keeps happening, send the
            reference below to the team.
            {error.digest ? ` Reference ${error.digest}.` : ""}
          </p>
          <button type="button" className={kitStyles.button} onClick={reset}>
            <RotateCcw size={14} aria-hidden="true" />
            Try again
          </button>
        </div>
      </section>
    </Page>
  );
}
