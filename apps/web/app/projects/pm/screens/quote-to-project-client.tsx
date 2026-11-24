"use client";
// PM-UI 14 Quote to project: the note + action row. Ready → "Create draft project" (the one filled button); tap →
// "Creating…" with a spinner (button off; nothing else moves) → the quiet green "Draft project created" line with a
// filled "Open draft". When a draft already exists for the quote, the only button is an outline "Open draft".
// Local state only (the preview simulates the create); `onCreate` takes the real mutation later.
import { useEffect, useRef, useState } from "react";
import { CalendarDays, FolderPlus, Loader2 } from "lucide-react";
import type { DraftVM, QuoteToProjectVM } from "../contract/quote-to-project";
import { HealthChip, PmButton } from "../kit";
import css from "./quote-to-project.module.css";

type Status = QuoteToProjectVM["status"];

export function QuoteAction({ status: initial, note, create, draft, openLabel, fallbackHref, onCreate }: {
  status: Status; note: string; create: QuoteToProjectVM["create"]; draft: DraftVM; openLabel: string; fallbackHref: string;
  /** The real create (POST quotes/:id/project); resolves with the draft's href. Absent in the preview: simulated. */
  onCreate?: () => Promise<string | null>;
}) {
  const [status, setStatus] = useState<Status>(initial);
  const [href, setHref] = useState<string | null>(draft.href);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = async () => {
    if (status !== "ready") return;
    setStatus("creating");
    if (onCreate) {
      try { setHref(await onCreate()); setStatus("created"); } catch { setStatus("ready"); }
      return;
    }
    timer.current = setTimeout(() => setStatus("created"), 1200);
  };

  const open = href ?? fallbackHref;
  const noteLine = <p className={css.note}><CalendarDays aria-hidden="true" />{note}</p>;

  // Created: the green line replaces the note + button row (its "Starts when invoice is paid" says the note once).
  if (status === "created") return <div className={css.foot} data-created="">
    <div className={css.made} role="status">
      <p className={css.madeLine}>
        <FolderPlus className={css.madeIcon} aria-hidden="true" />
        <span className={css.madeText}>Draft project created: <strong>{draft.project.name}</strong></span>
        <span className={css.madeState}><HealthChip health={draft.health} short /><span className={css.muted}>{draft.health.reason}</span></span>
      </p>
      <PmButton variant="primary" size="lg" href={open} className={css.action}>{openLabel}</PmButton>
    </div>
  </div>;

  if (status === "exists") return <div className={css.foot}>
    {noteLine}
    <PmButton variant="outline" size="lg" href={open} className={css.action}>{openLabel}</PmButton>
  </div>;

  const busy = status === "creating";
  return <div className={css.foot}>
    {noteLine}
    <PmButton variant="primary" size="lg" className={`${css.action} ${busy ? css.busy : ""}`} disabled={busy} aria-busy={busy || undefined}
      icon={busy ? Loader2 : undefined} onClick={start}>{busy ? create.busyLabel : create.label}</PmButton>
  </div>;
}
