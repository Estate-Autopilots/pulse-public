/**
 * The Sales Xray kit, shared by Admin, Sales Xray web and the phone app
 * (admin revamp, 19 Oct 2026). Calm, dense pieces: headers, panels, KPI
 * tiles, badges, tables with phone cards, rows, fields. No raw colours;
 * text 12-15 px plus 20/24 px titles and figures; controls 32 px (44 px on
 * touch). Pieces that link take the app's router link as `link`; each app's
 * own kit module passes it once, so screens import from there.
 */
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Info,
  Minus,
  type IconComponent,
} from "./icons";
import { Anchor, type KitLink } from "./link";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

import styles from "./kit.module.css";

export { styles as kitStyles };

export type Tone = "neutral" | "accent" | "info" | "good" | "warn" | "bad";

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ");

/* ---------- Page ---------- */

/** Compact page header: title, one line of context, actions on the right. */
export function PageHeader({
  link: Link = Anchor,
  title,
  context,
  actions,
  back,
}: {
  /** The app's router link (Next's Link); a plain anchor otherwise. */
  link?: KitLink;
  title: string;
  context?: ReactNode[];
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  const items = (context ?? []).filter(Boolean);
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        {back ? (
          <Link href={back.href} className={styles.back}>
            <ChevronLeft size={13} aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}
        <h1 className={styles.title} title={title}>
          {title}
        </h1>
        {items.length ? (
          <p className={styles.context}>
            {items.map((item, index) => (
              <span key={index}>{item}</span>
            ))}
          </p>
        ) : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

/** A titled surface. `tools` sit in the head; `action` is one quiet link. */
export function Panel({
  link: Link = Anchor,
  title,
  sub,
  tools,
  action,
  foot,
  children,
  className,
  style,
}: {
  /** The app's router link (Next's Link); a plain anchor otherwise. */
  link?: KitLink;
  title: string;
  sub?: ReactNode;
  tools?: ReactNode;
  action?: { href: string; label: string };
  foot?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section
      className={cx(styles.panel, className)}
      style={style}
      aria-label={title}
    >
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          {title}
          {sub !== undefined && sub !== null ? <small>{sub}</small> : null}
        </h2>
        {tools || action ? (
          <span className={styles.panelTools}>
            {tools}
            {action ? (
              <Link href={action.href} className={styles.panelAction}>
                {action.label}
                <ChevronRight size={13} aria-hidden="true" />
              </Link>
            ) : null}
          </span>
        ) : null}
      </div>
      {children}
      {foot ? <div className={styles.panelFoot}>{foot}</div> : null}
    </section>
  );
}

/* ---------- Numbers ---------- */

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}

/** Change against a named baseline, as text and an arrow, never colour alone. */
export function Delta({
  value,
  previous,
}: {
  value: number;
  previous: number;
}) {
  if (!previous && !value)
    return (
      <span className={styles.delta} data-trend="flat">
        <Minus size={12} aria-hidden="true" />0
      </span>
    );
  if (!previous)
    return (
      <span className={styles.delta} data-trend="up">
        <ArrowUpRight size={13} aria-hidden="true" />
        new
      </span>
    );
  const pct = Math.round(((value - previous) / previous) * 100);
  if (pct === 0)
    return (
      <span className={styles.delta} data-trend="flat">
        <Minus size={12} aria-hidden="true" />
        0%
      </span>
    );
  const Icon = pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={styles.delta} data-trend={pct > 0 ? "up" : "down"}>
      <Icon size={13} aria-hidden="true" />
      <span className={styles.srOnly}>{pct > 0 ? "up " : "down "}</span>
      {Math.abs(pct)}%
    </span>
  );
}

/** Mini columns on one shared scale; under three busy points it says nothing. */
export function Spark({
  values,
  label,
  on,
}: {
  values: number[];
  label: string;
  on?: (index: number) => boolean;
}) {
  if (values.filter((value) => value > 0).length < 3) return null;
  const max = Math.max(1, ...values);
  return (
    <span className={styles.spark} role="img" aria-label={label}>
      {values.map((value, index) => (
        <i
          key={index}
          data-on={
            (on ? on(index) : index === values.length - 1) ? "" : undefined
          }
          style={{
            height: `${Math.max(value ? 12 : 0, (value / max) * 100)}%`,
          }}
        />
      ))}
    </span>
  );
}

/** A row of KPI tiles that reflows from 4 across to 2 on phones. */
export function Tiles({
  children,
  label = "Key numbers",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className={styles.tiles} aria-label={label}>
      {children}
    </section>
  );
}

export function Kpi({
  link: Link = Anchor,
  label,
  value,
  unit,
  delta,
  note,
  spark,
  href,
  tone,
}: {
  /** The app's router link (Next's Link); a plain anchor otherwise. */
  link?: KitLink;
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: ReactNode;
  note?: ReactNode;
  spark?: ReactNode;
  href?: string;
  tone?: Tone;
}) {
  const body = (
    <>
      <span className={styles.tileLabel}>
        {tone ? <span className={styles.dot} data-tone={tone} /> : null}
        {label}
      </span>
      <span className={styles.tileMain}>
        <strong
          className={styles.tileValue}
          // Words ("Not available") read at heading size; numbers stay large.
          data-words={
            typeof value === "string" && !/\d/.test(value) ? "" : undefined
          }
        >
          {value}
          {unit ? <small>{unit}</small> : null}
        </strong>
        {delta}
        {spark ? <span className={styles.tileSpark}>{spark}</span> : null}
      </span>
      {note ? <span className={styles.tileNote}>{note}</span> : null}
    </>
  );
  return href ? (
    <Link href={href} className={styles.tile}>
      {body}
    </Link>
  ) : (
    <div className={styles.tile}>{body}</div>
  );
}

/** A thin bar for a share; the number beside it says the value. */
export function Meter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label?: string;
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <span
      className={styles.meter}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <i style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/* ---------- States ---------- */

const isLinkAction = (
  value: unknown,
): value is { href: string; label: string } =>
  typeof value === "object" &&
  value !== null &&
  "href" in value &&
  "label" in value;

/** One empty state with at most one action. */
export function Empty({
  link: Link = Anchor,
  icon: Icon,
  title,
  text,
  action,
}: {
  /** The app's router link (Next's Link); a plain anchor otherwise. */
  link?: KitLink;
  icon: IconComponent;
  title: string;
  text?: string;
  action?: { href: string; label: string } | ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      {text ? <p className={styles.emptyText}>{text}</p> : null}
      {isLinkAction(action) ? (
        <Link href={action.href} className={styles.button}>
          {action.label}
        </Link>
      ) : (
        (action ?? null)
      )}
    </div>
  );
}

/** "How we know this": a small (i) that opens the source of a figure. */
export function Why({
  detail,
  more,
  label = "How we know this",
}: {
  detail: string;
  more?: string;
  label?: string;
}) {
  return (
    <details className={styles.why}>
      <summary aria-label={label} title={label}>
        <Info size={14} aria-hidden="true" />
      </summary>
      <div className={styles.whyPanel}>
        <p>{detail}</p>
        {more ? <p>{more}</p> : null}
      </div>
    </details>
  );
}

/** A value, or a quiet prompt when the record doesn't have it yet. */
export function Fact({
  value,
  missing = "Not set",
}: {
  value?: ReactNode;
  missing?: string;
}) {
  return value === null || value === undefined || value === "" ? (
    <span className={styles.muted}>{missing}</span>
  ) : (
    <>{value}</>
  );
}

/** A placeholder the size of what will arrive, so nothing moves. */
export function Skeleton({
  width = "100%",
  height = 12,
}: {
  width?: number | string;
  height?: number;
}) {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/* ---------- Navigation ---------- */

/** Tabs that live in the address (?tab=), so reload and links keep them. */
export function QueryTabs({
  link: Link = Anchor,
  base,
  items,
  current,
  param = "tab",
  keep,
}: {
  /** The app's router link (Next's Link); a plain anchor otherwise. */
  link?: KitLink;
  base: string;
  items: { key: string; label: ReactNode; count?: number }[];
  current: string;
  param?: string;
  keep?: string;
}) {
  return (
    <nav className={styles.tabs} aria-label="Sections">
      {items.map((item, index) => {
        const query = [keep ?? "", index ? `${param}=${item.key}` : ""]
          .filter(Boolean)
          .join("&");
        return (
          <Link
            key={item.key}
            href={query ? `${base}?${query}` : base}
            scroll={false}
            className={styles.tab}
            aria-current={item.key === current ? "page" : undefined}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className={styles.tabCount}>{item.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/* ---------- People ---------- */

export const hue = (text: string) => {
  let value = 0;
  for (const ch of text) value = (value * 31 + ch.charCodeAt(0)) % 360;
  return value;
};

export const initials = (name: string) =>
  name
    .replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase() || "?";

/* ---------- Lists, tables and cards ---------- */

export function List({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <ul className={styles.list} aria-label={label}>
      {children}
    </ul>
  );
}

/** One 40 px+ row: icon, title with its meta line, and an end slot. */
export function Row({
  link: Link = Anchor,
  icon,
  title,
  href,
  meta,
  end,
}: {
  /** The app's router link (Next's Link); a plain anchor otherwise. */
  link?: KitLink;
  icon?: ReactNode;
  title: ReactNode;
  href?: string;
  meta?: ReactNode[];
  end?: ReactNode;
}) {
  const items = (meta ?? []).filter(Boolean);
  return (
    <li className={styles.row}>
      {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
      <span className={styles.rowMain}>
        {href ? (
          <Link href={href} className={styles.rowTitle}>
            {title}
          </Link>
        ) : (
          <span className={styles.rowTitle}>{title}</span>
        )}
        {items.length ? (
          <span className={styles.rowMeta}>
            {items.map((item, index) => (
              <span key={index}>{item}</span>
            ))}
          </span>
        ) : null}
      </span>
      {end ? <span className={styles.rowEnd}>{end}</span> : null}
    </li>
  );
}

/**
 * A Linear-style table on wide screens. Pass `cards` to show the same rows
 * as cards on phones (below 760 px) instead of a sideways-scrolling table.
 */
export function Table({
  label,
  children,
  cards,
}: {
  label: string;
  children: ReactNode;
  cards?: ReactNode;
}) {
  return (
    <>
      <div className={styles.tableWrap} data-has-cards={cards ? "" : undefined}>
        <table className={styles.table} aria-label={label}>
          {children}
        </table>
      </div>
      {cards ? (
        <div className={styles.cards} aria-label={label} role="list">
          {cards}
        </div>
      ) : null}
    </>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <article className={styles.card} role="listitem">
      {children}
    </article>
  );
}

/* ---------- Controls ---------- */

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "icon";
}) {
  return (
    <button
      type="button"
      {...props}
      className={cx(styles.button, className)}
      data-variant={variant}
    />
  );
}

/** A labelled field with its hint or error underneath, at one fixed height. */
export function Field({
  label,
  hint,
  error,
  children,
  wide,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={styles.field} data-wide={wide ? "" : undefined}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {error ? (
        <small className={styles.fieldError} role="alert">
          {error}
        </small>
      ) : hint ? (
        <small className={styles.fieldHint}>{hint}</small>
      ) : null}
    </label>
  );
}

/* ---------- Console additions ---------- */

/** The page column: header, then surfaces 16 px apart. `wide` drops the max width. */
export function Page({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={styles.page} data-wide={wide ? "" : undefined}>
      {children}
    </div>
  );
}

/**
 * What a panel shows when its data couldn't be read: a small card with the
 * reason, never a red banner, never a crash. The rest of the page still works.
 */
export function Unavailable({
  title,
  reason,
}: {
  title: string;
  reason: string;
}) {
  return (
    <section className={styles.unavailable} role="status" aria-label={title}>
      <Info size={14} aria-hidden="true" />
      <span>
        <strong>{title} is unavailable</strong>
        <small>{reason}</small>
      </span>
    </section>
  );
}

/** A key the person can press. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>;
}

/** One row of filters or actions above a list; wraps on phones. */
export function Toolbar({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className={styles.toolbar} role="group" aria-label={label}>
      {children}
    </div>
  );
}
