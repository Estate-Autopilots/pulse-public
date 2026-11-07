// UX-SETTINGS-CHAT (owner, 5 Nov 2026: "there is no UX/UI improvement in anything"): the calm kit, taken from Work → My
// day so every area can read the same way: a header with stat tiles, chips with counts, numbered "Start with" picks,
// cards with a colour stripe, a quiet right rail, section headers and empty states that say what to do. Plain
// components (no state): server pages and client screens both use them. Styles: page-kit.module.css, the theme's tokens.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import css from "./page-kit.module.css";
import { Counted } from "../kit/count-up";

export type Tone = "bad" | "warn" | "good";
/** A stripe's colour: a hue (0-360, light and dark shades from the theme) or a colour. */
export type Stripe = number | string | undefined;
export const stripeStyle = (s: Stripe): CSSProperties | undefined =>
  s === undefined ? undefined : typeof s === "number" ? { "--stripe-hue": s } as CSSProperties : { "--stripe-hue": 0, "--stripe-color": s } as CSSProperties;

/** The page column (max 1240px), as My day's. */
export function CalmPage({ children }: { children: ReactNode }) {
  return <div className={css.page} data-calm-page="">{children}</div>;
}

/** Eyebrow, title and one plain line; stat tiles sit on the right from 640px. `back` leads to the page above. */
export function PageHeader({ eyebrow, title, lede, back, actions, stats }: { eyebrow?: ReactNode; title: string; lede?: ReactNode; back?: { href: string; label: string }; actions?: ReactNode; stats?: ReactNode }) {
  return <header className={css.head} data-stats={stats ? "" : undefined}>
    <div className={css.headText}>
      {back ? <Link className={css.back} href={back.href}><ChevronLeft size={16} aria-hidden="true" />{back.label}</Link> : null}
      {eyebrow ? <p className={css.eyebrow}>{eyebrow}</p> : null}
      <h1 className={css.title}>{title}</h1>
      {lede ? <p className={css.lede}>{lede}</p> : null}
      {actions ? <div className={css.headActions}>{actions}</div> : null}
    </div>
    {stats}
  </header>;
}

/** A row of stat tiles ("at a glance"). */
export function StatTiles({ label = "At a glance", children, count }: { label?: string; children: ReactNode; count: number }) {
  return <dl className={css.stats} aria-label={label} data-count={count} style={{ "--stat-count": count } as CSSProperties}>{children}</dl>;
}
/** One number and its name; `href` makes the tile a way in. */
export function StatTile({ label, value, tone, href }: { label: string; value: ReactNode; tone?: Tone; href?: string }) {
  // A list of terms holds only groups, so a tile that leads somewhere carries its link on the name, stretched over the tile.
  return <div className={css.stat} data-tone={tone} data-stat="" data-link={href ? "" : undefined}>
    <dt>{href ? <Link className={css.statLink} href={href}>{label}</Link> : label}</dt><dd><Counted value={value} /></dd>
  </div>;
}

export type Chip = { key: string; label: ReactNode; count?: number; tone?: Tone; stripe?: Stripe; href?: string; onClick?: () => void; title?: string };
/** Filters or sections as pills with counts. Links mark the current one (a navigation landmark); buttons are toggles
 *  (aria-pressed) in a labelled group, not a landmark. */
export function ChipFilter({ label, items, current, wrap }: { label: string; items: readonly Chip[]; current?: string | readonly string[]; /** Wrap in place (inside a card) instead of one sideways row. */ wrap?: boolean }) {
  const on = (k: string) => Array.isArray(current) ? current.includes(k) : current === k;
  const Tag = items.length && items.every((c) => c.href) ? "nav" : "div";
  return <Tag className={css.chips} aria-label={label} role={Tag === "div" ? "group" : undefined} data-chip-filter="" data-wrap={wrap ? "" : undefined}>
    {items.map((c) => {
      const inner = <>{c.stripe !== undefined ? <i className={css.dot} aria-hidden="true" /> : null}{c.label}{c.count ? <span className={css.chipCount}>{c.count > 99 ? "99+" : c.count}</span> : null}</>;
      return c.href ? <Link key={c.key} href={c.href} className={css.chip} data-tone={c.tone} style={stripeStyle(c.stripe)} aria-current={on(c.key) ? "page" : undefined} title={c.title} scroll={false}>{inner}</Link>
        : <button key={c.key} type="button" className={css.chip} data-tone={c.tone} style={stripeStyle(c.stripe)} aria-pressed={on(c.key)} onClick={c.onClick} title={c.title}>{inner}</button>;
    })}
  </Tag>;
}

/** The work column and a quiet rail beside it (below it on a phone). */
export function CalmGrid({ children, rail, railLabel }: { children: ReactNode; rail?: ReactNode; railLabel?: string }) {
  return <div className={css.grid} data-rail={rail ? "" : undefined}>
    <div className={css.main}>{children}</div>
    {rail ? <aside className={css.rail} aria-label={railLabel}>{rail}</aside> : null}
  </div>;
}

/** A section's name with an icon and a quiet count or note on the right. */
export function SectionHeader({ icon: Icon, title, note, tone, as: Tag = "h2" }: { icon?: LucideIcon; title: ReactNode; note?: ReactNode; tone?: Tone; as?: "h2" | "h3" }) {
  return <Tag className={css.sectionHead} data-tone={tone}>{Icon ? <Icon size={15} aria-hidden="true" /> : null}{title}{note !== undefined && note !== null ? <small>{note}</small> : null}</Tag>;
}

/** A card holding a section (the rail's cards too). */
export function Card({ children, label, area }: { children: ReactNode; label?: string; area?: string }) {
  return <section className={css.card} aria-label={label} data-area={area}>{children}</section>;
}

export type Pick = { key: string; title: string; sub?: ReactNode; href?: string; onClick?: () => void; stripe?: Stripe };
/** "Start with": the few things to do first, numbered. Nothing to do: nothing shown. */
export function StartWith({ picks, title = "Start with", icon }: { picks: readonly Pick[]; title?: string; icon?: LucideIcon }) {
  if (!picks.length) return null;
  return <section className={css.card} aria-label={title} data-start-with="">
    <SectionHeader icon={icon} title={title} />
    <ol className={css.picks}>{picks.map((p, n) => <li key={p.key} style={stripeStyle(p.stripe)}>
      <span className={css.pickNo} aria-hidden="true">{n + 1}</span>
      {p.href ? <Link className={css.pickOpen} href={p.href}><b>{p.title}</b>{p.sub ? <small>{p.sub}</small> : null}</Link>
        : <button type="button" className={css.pickOpen} onClick={p.onClick}><b>{p.title}</b>{p.sub ? <small>{p.sub}</small> : null}</button>}
    </li>)}</ol>
  </section>;
}

/** A place or a thing with its colour on the left: icon, name, one line, and a badge or count at the end. */
export function StripeCard({ title, text, icon: Icon, stripe, href, onClick, end, badge, current }: { title: ReactNode; text?: ReactNode; icon?: LucideIcon; stripe?: Stripe; href?: string; onClick?: () => void; end?: ReactNode; badge?: { label: ReactNode; tone?: Tone }; current?: boolean }) {
  const inner = <>
    {Icon ? <span className={css.stripeIcon} aria-hidden="true"><Icon size={18} /></span> : <span />}
    <span className={css.stripeText}><b>{title}</b>{text ? <small>{text}</small> : null}{badge ? <span className={css.badge} data-tone={badge.tone}>{badge.label}</span> : null}</span>
    <span className={css.stripeEnd}>{end}{href || onClick ? <ChevronRight size={16} aria-hidden="true" /> : null}</span>
  </>;
  if (href) return <Link className={css.stripe} href={href} style={stripeStyle(stripe)} aria-current={current ? "page" : undefined} data-stripe-card="">{inner}</Link>;
  if (onClick) return <button type="button" className={css.stripe} style={stripeStyle(stripe)} onClick={onClick} data-stripe-card="">{inner}</button>;
  return <div className={css.stripe} style={stripeStyle(stripe)} data-stripe-card="">{inner}</div>;
}
/** Stripe cards in a list (two columns from 640px when `columns` is 2). */
export function StripeList({ children, columns, label }: { children: ReactNode; columns?: 1 | 2; label?: string }) {
  return <div className={css.stripeList} data-columns={columns} aria-label={label} role={label ? "group" : undefined}>{children}</div>;
}

/** Nothing here: what it means and what to do next. */
export function EmptyState({ icon: Icon, title, text, action, tone }: { icon: LucideIcon; title: string; text?: ReactNode; action?: { href: string; label: string } | { onClick: () => void; label: string }; tone?: Tone }) {
  return <div className={css.empty} data-tone={tone} data-empty-state="">
    <Icon size={22} aria-hidden="true" /><b>{title}</b>{text ? <span>{text}</span> : null}
    {action ? "href" in action ? <Link className={css.btnPrimary} href={action.href}>{action.label}</Link> : <button type="button" className={css.btnPrimary} onClick={action.onClick}>{action.label}</button> : null}
  </div>;
}

/** Label: value lines for a rail card. */
export function Facts({ items }: { items: readonly [string, ReactNode][] }) {
  return <dl className={css.facts}>{items.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
export function Quiet({ children }: { children: ReactNode }) { return <p className={css.quiet}>{children}</p>; }
export function RailLinks({ links }: { links: readonly { href: string; label: string }[] }) {
  return <ul className={css.railLinks}>{links.map((l) => <li key={l.href}><Link href={l.href}>{l.label}</Link></li>)}</ul>;
}
export const calm = css;
