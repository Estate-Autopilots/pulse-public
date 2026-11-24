"use client";
// PM-UI: the interactive part of the client's page: card 1 "Needs your OK" (Approve / Ask for changes, the changes box)
// and "We need from you" under it (its first Upload becomes the one filled button once nothing waits for an OK).
// Works on local state so the preview is clickable; the real wiring posts to the actions' hrefs.
// "Ask for changes": from 600 px the button row turns into a comment box in the card; on a phone the same box opens as a
// bottom sheet with a sticky "Send changes" (the card behind keeps its buttons, Approve no longer filled).
import { useRef, useState, type MouseEvent } from "react";
import { CircleCheck, FileText, Image as ImageIcon, MessageSquare, Maximize, Play, Send, Upload, Volume2 } from "lucide-react";
import type { ClientApproved, ClientMilestone, ClientNeed, ClientReview } from "../contract/client-view";
import type { HueKey, IsoDate } from "../contract/shared";
import { Chip, PmButton, PmCard, PmSheet, SectionCard, fmtDayShort, hued } from "../kit";
import css from "./client-view.module.css";

type Mode = "idle" | "changes" | "approved" | "sent";

/** The video under review: the project's colour, a skyline, a play button and a quiet control bar ("0:00 / 0:30"). */
function Player({ review, hue }: { review: ClientReview; hue: HueKey }) {
  return <figure className={css.player} aria-label={`Video: ${review.title}, v${review.round.version}, ${review.media.length}`}>
    <span {...hued(hue, css.stage)}>
      <span className={css.art} aria-hidden="true" />
      <button type="button" className={css.bigPlay} aria-label={`Play ${review.title}`}><Play aria-hidden="true" /></button>
      <span className={css.controls} aria-hidden="true">
        <Play />
        <span className={css.time}>0:00 / {review.media.length}</span>
        <span className={css.track}><i /></span>
        <Volume2 />
        <Maximize />
      </span>
    </span>
  </figure>;
}

/** The changes box (inline from 600 px, or inside the phone sheet). */
function ChangesBox({ id, text, error, onText, hideLabel }: { id: string; text: string; error: string | null; onText: (t: string) => void; /** The sheet title already asks the question. */ hideLabel?: boolean }) {
  return <div className={css.compose}>
    <label htmlFor={id} className={hideLabel ? css.srOnly : css.composeLabel}>What should we change?</label>
    <textarea id={id} className={css.textarea} rows={3} value={text} onChange={(e) => onText(e.target.value)}
      placeholder="For example: make the opening shorter" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} />
    {error ? <p id={`${id}-err`} className={css.error} role="alert">{error}</p> : null}
  </div>;
}

export function ClientMain({ review, approved, needs, hue, today, pageHref, nothing }: {
  review: ClientReview | null; approved: ClientApproved | null; needs: ClientNeed[]; hue: HueKey; today: IsoDate;
  /** This page (the sheet's close link without JavaScript). */ pageHref: string;
  /** Nothing waits on the client: the short card with the next date and a chat link. */
  nothing: { next: ClientMilestone | null; chat: { label: string; href: string } | null } | null;
}) {
  const [mode, setMode] = useState<Mode>(approved ? "approved" : review?.compose ? "changes" : "idle");
  const [text, setText] = useState(review?.compose?.text ?? "");
  const [error, setError] = useState<string | null>(review?.compose?.error ?? null);
  const card = useRef<HTMLDivElement>(null);

  const focusBox = () => requestAnimationFrame(() => {
    const boxes = card.current?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? [];
    for (const b of boxes) if (b.offsetParent !== null) { b.focus(); break; }
  });
  const ask = () => { setMode("changes"); focusBox(); };
  const cancel = () => { setMode("idle"); setError(null); };
  const send = () => {
    if (!text.trim()) { setError("Please write what to change"); focusBox(); return; }
    setError(null); setMode("sent");
  };
  const onText = (t: string) => { setText(t); if (error && t.trim()) setError(null); };
  // The sheet's close (X) is a link for no-JS; here it just closes the sheet.
  const closeSheet = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[aria-label="Close"]');
    if (a) { e.preventDefault(); cancel(); }
  };

  const done = approved ?? (review && mode === "approved" ? { title: review.title, version: review.round.version, on: today } : null);
  const waiting = !!review && (mode === "idle" || mode === "changes");

  return <div className={css.mainIn} ref={card}>
    {review && waiting ? <section className={css.review} aria-labelledby="cv-review-title" data-mode={mode}>
      <div className={css.reviewHead}>
        <span className={css.reviewChip}><Chip tone="action">Your turn</Chip></span>
        <h2 id="cv-review-title" className={css.reviewTitle}>Needs your OK: {review.title}</h2>
        <p className={css.reviewMeta}>v{review.round.version} · Round {review.round.round} of {review.round.maxRounds} · Due {fmtDayShort(review.due)}</p>
      </div>
      <Player review={review} hue={hue} />
      {/* The decision row: always on a phone (Approve outline while the sheet is open); from 600 px only while idle. */}
      <div className={css.decide} data-hide-wide={mode === "changes" ? "" : undefined}>
        <PmButton variant={mode === "changes" ? "outline" : "primary"} size="lg" icon={CircleCheck}
          onClick={() => setMode("approved")}>{review.approve.label}</PmButton>
        <PmButton variant="outline" size="lg" icon={MessageSquare} onClick={ask}>{review.askChanges.label}</PmButton>
      </div>
      {mode === "changes" ? <div className={css.inline}>
        <ChangesBox id="cv-changes-inline" text={text} error={error} onText={onText} />
        <div className={css.composeActions}>
          <PmButton variant="primary" size="lg" icon={Send} onClick={send}>{review.sendChanges.label}</PmButton>
          <button type="button" className={css.cancel} onClick={cancel}>Cancel</button>
        </div>
      </div> : null}
    </section> : null}

    {review && mode === "changes" ? <div className={css.sheetLayer} onClickCapture={closeSheet}>
      <PmSheet title="What should we change?" sub={`${review.title} · v${review.round.version}`} closeHref={pageHref}
        label="Ask for changes" footer={<>
          <button type="button" className={css.cancel} onClick={cancel}>Cancel</button>
          <PmButton variant="primary" size="lg" icon={Send} onClick={send}>{review.sendChanges.label}</PmButton>
        </>}>
        <ChangesBox id="cv-changes-sheet" text={text} error={error} onText={onText} hideLabel />
      </PmSheet>
    </div> : null}

    {done ? <p className={css.okRow} role="status">
      <CircleCheck aria-hidden="true" />
      <span><b>Approved</b> · {done.title} v{done.version} · {fmtDayShort(done.on)}</span>
    </p> : null}
    {review && mode === "sent" ? <p className={css.sentRow} role="status">
      <Send aria-hidden="true" />
      <span><b>Changes sent</b> · {review.title} v{review.round.version} · {fmtDayShort(today)}</span>
    </p> : null}

    {needs.length ? <SectionCard title="We need from you" className={css.needs}>
      <ul className={css.needList}>{needs.map((n, i) => {
        const Icon = n.kind === "photos" ? ImageIcon : FileText;
        return <li key={n.id} className={css.need}>
          <span className={css.needIcon} aria-hidden="true"><Icon /></span>
          <span className={css.needText}><b>{n.label}</b><span className={css.muted}>Due by {fmtDayShort(n.due)}</span></span>
          <PmButton variant={i === 0 && !waiting ? "primary" : "outline"} size="lg" icon={Upload} href={n.upload.href} className={css.upload}
            aria-label={`${n.upload.label} ${n.label}`}>{n.upload.label}</PmButton>
        </li>;
      })}</ul>
    </SectionCard> : null}

    {nothing ? <PmCard className={css.nothing}>
      <p className={css.nothingText}><b>Nothing needs you right now.</b>{nothing.next ? <> Next: {nothing.next.label} on {fmtDayShort(nothing.next.date)}</> : null}</p>
      {nothing.chat ? <PmButton variant="outline" size="lg" icon={MessageSquare} href={nothing.chat.href}>{nothing.chat.label}</PmButton> : null}
    </PmCard> : null}
  </div>;
}
