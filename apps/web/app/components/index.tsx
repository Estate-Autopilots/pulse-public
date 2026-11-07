// UX-PEOPLE (owner, 5 Nov 2026): the calm parts of Work → My day as shared components, so a screen is built from them
// instead of forking its own styles: CalmHeader, StatTile(s), ChipFilter, StartWith, StripeCard, SectionHeader,
// EmptyState and the main column + quiet right rail (CalmGrid). No hooks here: each works in a server page, and the
// ones that take an onClick work in client components (or take an href instead).
import Link from "next/link";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Page } from "../ui";
import css from "./people-calm.module.css";

export { css as calm };
export type Tone = "good" | "warn" | "bad" | "quiet";

/** The page's frame (inside the app's Page, which gives the gutters): one centred column, calm spacing. */
export function CalmPage({ children, label }: { children: ReactNode; label?: string }) {
  return <Page><div className={css.page} aria-label={label} role={label ? "region" : undefined}>{children}</div></Page>;
}

/** Eyebrow, title, one plain sentence and the page's one primary action; stat tiles sit beside it on a computer.
 *  (Named apart from ui.tsx's PageHeader. The title is an h2: the shell's breadcrumb is the page's one h1.) */
export function CalmHeader({ eyebrow, title, lede, actions, stats, back }: { eyebrow?: ReactNode; title: string; lede?: ReactNode; actions?: ReactNode; stats?: ReactNode; back?: { href: string; label: string } }) {
  return <header className={css.head} data-stack={stats && actions ? "" : undefined}>
    <div className={css.headText}>
      {back ? <Link href={back.href} className={css.back}><ChevronLeft size={14} aria-hidden="true" />{back.label}</Link> : null}
      {eyebrow ? <p className={css.eyebrow}>{eyebrow}</p> : null}
      <h2 className={css.title}>{title}</h2>
      {lede ? <p className={css.lede}>{lede}</p> : null}
    </div>
    {actions ? <div className={css.headActions}>{actions}</div> : null}
    {stats}
  </header>;
}

/** A row of stat tiles ("Today at a glance"). */
export function StatTiles({ children, label, count }: { children: ReactNode; label: string; count?: number }) {
  return <dl className={css.stats} aria-label={label} style={count ? ({ "--n": count } as CSSProperties) : undefined}>{children}</dl>;
}

/** One number with its label; `href` makes the tile open the list behind it. */
export function StatTile({ label, value, note, tone, href }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone; href?: string }) {
  return <div className={css.stat} data-tone={tone} data-link={href ? "" : undefined}>
    <dt className={css.statLabel}>{href ? <Link href={href} className={css.statLink}>{label}</Link> : label}</dt>
    <dd className={css.statValue}>{value}</dd>{note ? <dd className={css.statNote}>{note}</dd> : null}
  </div>;
}

export type Chip = { key: string; label: ReactNode; count?: number; hue?: number; tone?: Tone; href?: string; title?: string };
/** Filter chips with counts. One pick (`value`) or several (`values`); `href` chips navigate instead of calling back. */
export function ChipFilter({ label, chips, value, values, onPick }: { label: string; chips: Chip[]; value?: string | null; values?: string[]; onPick?: (key: string) => void }) {
  const on = (k: string) => values ? values.includes(k) : value === k;
  return <nav className={css.chips} aria-label={label}>
    {chips.map((c) => {
      const style = c.hue !== undefined ? ({ "--hue": c.hue } as CSSProperties) : undefined;
      const inner = <>{c.hue !== undefined || c.tone ? <i className={css.chipDot} aria-hidden="true" /> : null}{c.label}{c.count !== undefined ? <span className={css.chipCount}>{c.count}</span> : null}</>;
      return c.href ? <Link key={c.key} href={c.href} className={css.chip} aria-current={on(c.key) ? "page" : undefined} aria-pressed={on(c.key)} data-tone={c.tone} style={style} title={c.title}>{inner}</Link>
        : <button key={c.key} type="button" className={css.chip} aria-pressed={on(c.key)} data-tone={c.tone} style={style} title={c.title} onClick={() => onPick?.(c.key)}>{inner}</button>;
    })}
  </nav>;
}

/** A section's heading: icon, words, a quiet count on the right. */
export function SectionHeader({ icon: Icon, title, count, tone, id, as: Tag = "h2" }: { icon?: LucideIcon; title: ReactNode; count?: ReactNode; tone?: Tone; id?: string; as?: "h2" | "h3" }) {
  return <Tag className={css.sectionHead} data-tone={tone} id={id}>{Icon ? <Icon size={15} aria-hidden="true" /> : null}{title}{count !== undefined ? <small>{count}</small> : null}</Tag>;
}

/** A quiet card that holds one section. */
export function Card({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return <section className={`${css.card}${className ? ` ${className}` : ""}`} aria-label={label}>{children}</section>;
}

/** A card with a left colour stripe (tone, or a hue from a name). A link with `href`, a button with `onClick`. */
export function StripeCard({ title, meta, children, tone, hue, href, onClick, pressed, label, className }: { title: ReactNode; meta?: ReactNode; children?: ReactNode; tone?: Tone; hue?: number; href?: string; onClick?: () => void; pressed?: boolean; label?: string; className?: string }) {
  const style = hue !== undefined ? ({ "--hue": hue } as CSSProperties) : undefined;
  const cls = `${css.stripe}${className ? ` ${className}` : ""}`;
  const body = <><span className={css.stripeTitle}>{title}</span>{meta ? <span className={css.stripeMeta}>{meta}</span> : null}{children}</>;
  if (href) return <Link href={href} className={cls} data-tone={tone} style={style} aria-label={label}>{body}</Link>;
  if (onClick) return <button type="button" className={cls} data-tone={tone} style={style} aria-label={label} aria-pressed={pressed} onClick={onClick}>{body}</button>;
  return <div className={cls} data-tone={tone} style={style} aria-label={label}>{body}</div>;
}

export type Pick = { key: string; title: string; why?: string; href?: string; onClick?: () => void; tone?: Tone };
/** Numbered "Start with" picks: what to do first, in plain words. Renders nothing when there is nothing to do. */
export function StartWith({ picks, title = "Start with", icon }: { picks: Pick[]; title?: string; icon?: LucideIcon }) {
  if (!picks.length) return null;
  return <Card label={title}>
    <SectionHeader icon={icon} title={title} />
    <ol className={css.startList}>{picks.map((p, n) => <li key={p.key} data-tone={p.tone}>
      <span className={css.startNo} aria-hidden="true">{n + 1}</span>
      {p.href ? <Link href={p.href} className={css.startOpen}><b>{p.title}</b>{p.why ? <small>{p.why}</small> : null}</Link>
        : <button type="button" className={css.startOpen} onClick={p.onClick}><b>{p.title}</b>{p.why ? <small>{p.why}</small> : null}</button>}
    </li>)}</ol>
  </Card>;
}

/** Nothing here yet: what it is and what to do, with the action. */
export function EmptyState({ icon: Icon, title, text, children }: { icon: LucideIcon; title: string; text?: ReactNode; children?: ReactNode }) {
  return <div className={css.empty} role="status"><Icon size={22} aria-hidden="true" /><b>{title}</b>{text ? <p>{text}</p> : null}{children ? <div className={css.emptyActions}>{children}</div> : null}</div>;
}

/** The main column and the quiet right rail (below the main column on a phone). */
export function CalmGrid({ main, rail, mainLabel, railLabel }: { main: ReactNode; rail?: ReactNode; mainLabel?: string; railLabel?: string }) {
  return <div className={css.grid}>
    <div className={css.main} aria-label={mainLabel} role={mainLabel ? "region" : undefined}>{main}</div>
    {rail ? <aside className={css.rail} aria-label={railLabel}>{rail}</aside> : null}
  </div>;
}
