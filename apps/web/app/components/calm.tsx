// UX-BILLING (owner, 5 Nov 2026: "there is no UX/UI improvement in anything", and Work → My day is the one he likes): the
// pieces My day is made of, for every area to build its screens from instead of styling each page again. Quiet stat tiles,
// a numbered "Start with", cards and rows with a stripe in their state's colour, a section heading with its count, an
// empty state that says what to do, a main column with a quiet rail beside it from 1024 px. Theme tokens only (light and
// dark); 44 px tap targets on a phone; server-safe (the chip filter, which needs a click, is in chip-filter.tsx).
// The one main action of a screen carries `data-primary` (PRIMARY below), which the browser runners count.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import css from "./calm.module.css";

/** A state's colour: the stripe, the number of a pick, a tile's figure. */
export type Tone = "danger" | "warning" | "accent" | "success" | "neutral";
const HUE: Record<Tone, number> = { danger: 2, warning: 36, accent: 214, success: 146, neutral: 220 };
export const toneStyle = (tone: Tone = "neutral") => ({ "--stripe-h": HUE[tone], "--stripe-s": tone === "neutral" ? "12%" : "70%" }) as CSSProperties;
/** Spread on the screen's one main button or link. */
export const PRIMARY = { "data-primary": "" } as const;

/** The screen: a column with My day's calm spacing. */
export function Calm({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`${css.calm}${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** The main column and, from 1024 px, a quiet rail beside it (below it on a phone). */
export function CalmGrid({ children, rail, railLabel, wide }: { children: ReactNode; rail?: ReactNode; railLabel?: string; /** a wider rail (a live preview) */ wide?: boolean }) {
  return <div className={css.grid} data-rail={rail ? (wide ? "wide" : "") : undefined}>
    <div className={css.main}>{children}</div>
    {rail ? <aside className={css.rail} aria-label={railLabel}>{rail}</aside> : null}
  </div>;
}

/** Up to four quiet figures at the top of a screen. */
export function StatTiles({ label, children }: { label: string; children: ReactNode }) {
  return <div className={css.stats} role="group" aria-label={label}>{children}</div>;
}
export function StatTile({ label, value, sub, href, tone }: { label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: "bad" | "good" | "warn" }) {
  const body = <><span className={css.statLabel}>{label}</span><b className={css.statValue}>{value}</b>{sub ? <small className={css.statSub}>{sub}</small> : null}</>;
  return href ? <Link href={href} className={css.stat} data-tone={tone}>{body}</Link> : <div className={css.stat} data-tone={tone}>{body}</div>;
}

/** A card: a section of the screen on its own surface. */
export function Card({ label, children, id, className, flat }: { label?: string; children: ReactNode; id?: string; className?: string; /** rows reach the edge */ flat?: boolean }) {
  return <section id={id} aria-label={label} className={`${css.card}${className ? ` ${className}` : ""}`} data-flat={flat ? "" : undefined}>{children}</section>;
}

/** A card's heading: an icon, the words, a count or a quiet hint on the right, or a link. */
export function SectionHeader({ icon, title, count, hint, action, id, tone }: { icon?: ReactNode; title: ReactNode; count?: number; hint?: ReactNode; action?: ReactNode; id?: string; tone?: "danger" }) {
  return <h2 className={css.head} id={id} data-tone={tone}>{icon}<span className={css.headTitle}>{title}</span>
    {count !== undefined ? <small className={css.headCount}>{count}</small> : null}
    {hint ? <small className={css.headHint}>{hint}</small> : null}
    {action ? <span className={css.headAction}>{action}</span> : null}</h2>;
}

export type Pick = { key: string; title: ReactNode; sub?: ReactNode; href?: string; onClick?: () => void; tone?: Tone; icon?: ReactNode; label?: string };
/** My day's "Start with": the few things to do first, numbered, each opening the one thing it is about. */
export function StartWith({ picks, empty, title = "Start with", icon }: { picks: Pick[]; empty: ReactNode; title?: string; icon?: ReactNode }) {
  return <Card label={title}>
    <SectionHeader icon={icon} title={title} count={picks.length || undefined} />
    {picks.length ? <ol className={css.picks}>{picks.map((x, n) => {
      const body = <><b>{x.title}</b>{x.sub ? <small>{x.icon}{x.sub}</small> : null}</>;
      return <li key={x.key} style={toneStyle(x.tone ?? "accent")}>
        <span className={css.pickNo} aria-hidden="true">{n + 1}</span>
        {x.href ? <Link className={css.pickOpen} href={x.href} aria-label={x.label}>{body}</Link>
          : <button type="button" className={css.pickOpen} onClick={x.onClick} aria-label={x.label}>{body}</button>}
      </li>;
    })}</ol> : <p className={css.calmNote}>{empty}</p>}
  </Card>;
}

/** Rows with a stripe in their state's colour (inside a Card, or on their own as cards). */
export function StripeList({ label, children, cards }: { label: string; children: ReactNode; /** each row its own card */ cards?: boolean }) {
  return <ul className={css.rows} aria-label={label} data-cards={cards ? "" : undefined}>{children}</ul>;
}
export function StripeRow({ tone = "neutral", href, onClick, title, sub, amount, end, badge, lead, label, current, expanded, controls, children }: {
  tone?: Tone; href?: string; onClick?: () => void; title: ReactNode; sub?: ReactNode; amount?: ReactNode; badge?: ReactNode; lead?: ReactNode;
  /** a row that folds open what follows it (aria-expanded / aria-controls on its button) */ expanded?: boolean; controls?: string;
  /** controls of their own, beside the row's link (a menu, a button) */ end?: ReactNode; label?: string; current?: boolean; children?: ReactNode;
}) {
  const body = <>{lead ? <span className={css.rowLead}>{lead}</span> : null}
    <span className={css.rowMain}><b>{title}</b>{sub ? <small>{sub}</small> : null}</span>
    {amount !== undefined || badge ? <span className={css.rowEnd}>{amount !== undefined ? <b>{amount}</b> : null}{badge}</span> : null}</>;
  return <li className={css.row} style={toneStyle(tone)} data-current={current ? "" : undefined}>
    {href ? <Link href={href} className={css.rowOpen} aria-label={label}>{body}</Link>
      : onClick ? <button type="button" className={css.rowOpen} onClick={onClick} aria-label={label} aria-expanded={expanded} aria-controls={controls}>{body}</button>
      : <div className={css.rowOpen}>{body}</div>}
    {end ? <span className={css.rowControls}>{end}</span> : null}
    {children}
  </li>;
}

/** Nothing here yet: what it is, what to do, and the button that does it. */
export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return <div className={css.empty} data-empty="">{icon ? <span className={css.emptyIcon}>{icon}</span> : null}<b>{title}</b>{text ? <p>{text}</p> : null}{action ? <div className={css.emptyAction}>{action}</div> : null}</div>;
}

/** A sentence that needs reading (a warning or a plain note), with its way on. */
export function Notice({ tone = "info", children, action }: { tone?: "info" | "warning" | "danger" | "success"; children: ReactNode; action?: ReactNode }) {
  return <div className={css.notice} data-tone={tone} role={tone === "danger" ? "alert" : undefined}><p>{children}</p>{action ? <span className={css.noticeAction}>{action}</span> : null}</div>;
}

/** A quiet line of facts in the rail: label above, value below. */
export function Facts({ items, label }: { items: { label: string; value: ReactNode; tone?: "bad" | "good" }[]; label: string }) {
  return <dl className={css.facts} aria-label={label}>{items.map((x) => <div key={x.label} data-tone={x.tone}><dt>{x.label}</dt><dd>{x.value}</dd></div>)}</dl>;
}

/** A quiet sentence of explanation inside a card. */
export function Quiet({ children }: { children: ReactNode }) { return <p className={css.calmNote}>{children}</p>; }
