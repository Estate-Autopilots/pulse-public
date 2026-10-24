import Link from "next/link";
import { HeaderActions, HeaderContext } from "./header-actions";
import { Children, Fragment, cloneElement, isValidElement, type CSSProperties, type ReactNode } from "react";
import { Sections } from "./sections";
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, CloudOff, Info, type LucideIcon } from "lucide-react";
import { describeFailure } from "./lib/load-error.mjs";
import { RetryButton } from "./retry-button";
import { RecentVisit, type RecentKind } from "@pulse/ui-shell";
import { Pager } from "./fit";
import { PresenceDot } from "./presence";
import type { Delivery, Period, TrendWeek } from "./lib/api";
import { deliveryCreditExplanation } from "./lib/editor-credit.mjs";
import { sparse } from "./lib/sparse.mjs";
import { SparseFacts } from "./charts";
import { destForHref } from "./destinations/registry.mjs";
import { count, day, dayTime, niceMax, plural, projectParts, shiftDay, when } from "./lib/format";
import styles from "./ui.module.css";

export { styles };
type Tone = "neutral" | "warning" | "success" | "danger" | "accent";

/** `fit`: on a desktop the page fills the window and never scrolls; its body (`Fit`) shares out the height. */
export function Page({ children, fit, viewport, calm }: { children: ReactNode; fit?: boolean; viewport?:boolean; /** Calm surfaces in the Focus home's language (Finance): roomy solid cards, one scrolling page. */ calm?: boolean }) {
  return <div className={styles.page} data-fit={fit ? "" : undefined} data-round11={viewport ? "" : undefined} data-calm={calm ? "" : undefined}>{children}</div>;
}

/** The body of a fit page: a grid that takes the height left under the header. Panels inside use `fill` and scroll on their own. */
export function Fit({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`${styles.fit}${className ? ` ${className}` : ""}`} style={style} data-enter="">{children}</div>;
}

/** Compact page header: title, one line of context, actions on the right. */
export function PageHeader({ title, context, actions, back, recent, meta }: { meta?: ReactNode; title: string; context?: ReactNode[]; actions?: ReactNode; back?: { href: string; label: string }; recent?: { title?: string; kind?: RecentKind } | false }) {
  const items = (context ?? []).filter(Boolean);
  return (
    <header className={styles.header} data-page-header="">
      {recent === false ? null : <RecentVisit title={recent?.title ?? title} kind={recent?.kind} />}
      <div className={styles.headerText}>
        {back ? <Link href={back.href} className={styles.back}><ChevronLeft size={13} aria-hidden="true" />{back.label}</Link> : null}
        <h2 className={styles.title} title={[title, ...items.filter((x): x is string => typeof x === "string")].join(" · ")}>{title}</h2>
        {items.length || meta ? <HeaderContext>{items.map((item, i) => <span key={i} title={typeof item === "string" ? item : undefined}>{item}</span>)}{meta}</HeaderContext> : null}
      </div>
      {actions ? <HeaderActions>{actions}</HeaderActions> : null}
    </header>
  );
}

/** A page that cannot show its data. EST-1197: one of Pulse's own sentences (lib/notices.mjs) shows as it is; anything
 *  else says in plain words that the page didn't load, with Try again, so server text never reaches the screen.
 *  `notice`: words this page builds itself at run time (never an API answer); they show as they are. */
// QA-1024 (friendliness): refusals a newcomer meets first say what to do next, with one button, instead of a dead end.
const NEXT_STEP: Record<string, { title: string; text: string; action: { href: string; label: string } }> = {
  "This account is not active in this company's Pulse": { title: "You're not set up in this Pulse yet", text: "Ask the person who runs Pulse for your team to add you, or sign in with the account they invited.", action: { href: "/login", label: "Use another account" } },
  "Sign in to Pulse to see your workspace.": { title: "Sign in to continue", text: "Sign in to Pulse to see your workspace.", action: { href: "/login", label: "Sign in" } },
};

export function Message({ text, notice }: { text?: string; notice?: string }) {
  const next = !notice && text ? NEXT_STEP[text.trim()] : undefined;
  if (next) return <Page><section className={`${styles.panel} ${styles.message}`}><Empty icon={Info} title={next.title} text={next.text} action={next.action} first /></section></Page>;
  const shown = notice ? { retry: false, title: "This view is unavailable", text: notice } : describeFailure(text);
  return <Page><section className={`${styles.panel} ${styles.message}`}><Empty icon={shown.retry ? CloudOff : Info} title={shown.title} text={shown.text} first>{shown.retry ? <RetryButton /> : null}</Empty></section></Page>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={styles.badge} data-tone={tone}>{children}</span>;
}

/** Signed change against a named baseline; shown as text and an arrow, never colour alone. */
export function Delta({ value, previous }: { value: number; previous: number }) {
  // POLISH-2: no change reads as "same", not "−0" (a minus sign and a zero looked like a fall).
  if (!previous && !value) return <span className={`${styles.delta} ${styles.deltaFlat}`}>same</span>;
  if (!previous) return <span className={`${styles.delta} ${styles.deltaUp}`}><ArrowUpRight size={13} aria-hidden="true" />new</span>;
  const pct = Math.round(((value - previous) / previous) * 100);
  if (pct === 0) return <span className={`${styles.delta} ${styles.deltaFlat}`}>same</span>;
  const Icon = pct > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`${styles.delta} ${pct > 0 ? styles.deltaUp : styles.deltaDown}`}><Icon size={13} aria-hidden="true" /><span className={styles.srOnly}>{pct > 0 ? "up" : "down"} </span>{Math.abs(pct)}%</span>;
}

/** Mini column sparkline on one shared scale; `on` marks the columns the tile's value covers. */
export function Spark({ values, on, label }: { values: number[]; on?: (index: number) => boolean; label: string }) {
  // One or two bars say nothing a number does not: the tile shows its number alone.
  if (values.filter((v) => v > 0).length < 3) return null;
  const max = Math.max(1, ...values);
  return <span className={styles.spark} role="img" aria-label={label}>{values.map((v, i) => <i key={i} data-on={(on ? on(i) : i === values.length - 1) ? "" : undefined} style={{ height: `${Math.max(v ? 12 : 0, (v / max) * 100)}%` }} />)}</span>;
}

export function Tiles({ children, count: n, dense }: { children: ReactNode; count?: number; dense?: boolean }) {
  return <section className={styles.tiles} data-count={n} data-dense={dense ? "" : undefined} aria-label="Key numbers">{children}</section>;
}

export function Kpi({ label, value, unit, href, delta, note, spark, tone }: { label: string; value: ReactNode; unit?: string; href?: string; delta?: ReactNode; note?: ReactNode; spark?: ReactNode; tone?: Tone }) {
  const body = <>
    <span className={styles.tileLabel}>{tone ? <span className={styles.stateDot} data-tone={tone} /> : null}{label}</span>
    <span className={styles.tileMain}><strong className={styles.tileValue}>{value}{unit ? <small>{unit}</small> : null}</strong>{delta}</span>
    <span className={styles.tileSpark}>{spark}</span>
    <span className={styles.tileNote} title={typeof note === "string" ? note : undefined}>{note}</span>
  </>;
  return href ? <Link href={href} className={styles.tile}>{body}</Link> : <div className={styles.tile}>{body}</div>;
}

export function Panel({ title, sub, action, tools, children, className, fill, primary, unit, foot, style, min }: { title: string; sub?: ReactNode; action?: { href: string; label: string }; tools?: ReactNode; children: ReactNode; className?: string; fill?: boolean; primary?: boolean; unit?: string; foot?: ReactNode; style?: CSSProperties; min?:number }) {
  return (
    <section className={`${styles.panel}${fill ? ` ${styles.panelFill}` : ""}${className ? ` ${className}` : ""}`} style={style}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{title}{sub !== undefined && sub !== null ? <small title={typeof sub === "string" ? sub : undefined}>{sub}</small> : null}</h3>
        <span className={styles.inline}>
          {tools}
          {action ? <Link href={action.href} className={styles.panelAction}>{action.label}<ChevronRight size={13} aria-hidden="true" /></Link> : null}
        </span>
      </div>
      {fill ? <Pager compact={!primary} primary={primary} min={min} unit={unit} className={styles.panelScroll} label={title}>{children}</Pager> : children}
      {foot ? <div className={styles.panelFoot}>{foot}</div> : null}
    </section>
  );
}

export function Empty({ icon: Icon, title, text, action, children, first, compact }: { icon: LucideIcon; title: string; text?: string; action?: { href: string; label: string }; children?: ReactNode; first?: boolean; compact?: boolean }) {
  return (
    <div className={styles.empty} data-compact={compact ? "" : undefined} style={first ? { borderTop: 0 } : undefined}>
      <span className={styles.emptyIcon}><Icon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
      <p className={styles.emptyTitle}>{title}</p>
      {text ? <p className={styles.emptyText}>{text}</p> : null}
      {action ? <Link href={action.href} className={styles.btn}>{action.label}</Link> : children}
    </div>
  );
}

export function Why({ detail, more }: { detail: string; more?: string }) {
  return <details className={styles.why}><summary aria-label="How Pulse knows this" title="How Pulse knows this"><Info size={14} aria-hidden="true" /></summary><div className={styles.whyPanel}><p>{detail}</p>{more ? <p>{more}</p> : null}</div></details>;
}

/** Deliveries per week on one zero-based scale. Each column links to that week's evidence. */
export function WeekChart({ weeks, period, hrefFor, unit = "delivery" }: { weeks: TrendWeek[]; period: Period; hrefFor: (week: string) => string; unit?: string }) {
  const few = sparse(weeks, (w) => w.deliveries);
  if (few) return <SparseFacts label="Deliveries per week" total={weeks.length} empty="No deliveries in this period."
    facts={few.map((w) => ({ key: w.week, n: w.deliveries, value: count(w.deliveries),
      text: w.deliveries === 1 ? unit : unit === "delivery" ? "deliveries" : `${unit}s`,
      sub: `${day(w.start)} – ${day(shiftDay(w.start, 6))}`, href: hrefFor(w.week) }))} />;
  const max = niceMax(Math.max(...weeks.map((w) => w.deliveries)));
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const selected = (w: TrendWeek) => shiftDay(w.start, 6) >= period.from && w.start <= period.to;
  const anySelected = weeks.some(selected);
  return (
    <div className={styles.chart}>
      <div className={styles.plot}>
        {ticks.map((t) => <div key={t} className={styles.gridline} data-base={t === 0 ? "" : undefined} style={{ bottom: `${(t / max) * 100}%` }}><span>{t}</span></div>)}
        <div className={styles.cols}>
          {weeks.map((w, i) => {
            const on = anySelected ? selected(w) : i === weeks.length - 1;
            const partial = period.inProgress && w.start <= period.today && shiftDay(w.start, 6) >= period.today;
            const span = `${day(w.start)} – ${day(shiftDay(w.start, 6))}`;
            return (
              <Link key={w.week} href={hrefFor(w.week)} className={styles.col} data-on={on ? "" : undefined} style={{ "--h": `${(w.deliveries / max) * 100}%` } as CSSProperties}
                aria-label={`Week ${Number(w.week.slice(-2))}, ${span}: ${plural(w.deliveries, unit, unit === "delivery" ? "deliveries" : undefined)}${partial ? " so far" : ""}`}>
                <span className={styles.bar} data-some={w.deliveries ? "" : undefined} />
                {on ? <span className={styles.barValue}>{w.deliveries}</span> : null}
                <span className={styles.tip} aria-hidden="true">
                  <b>{plural(w.deliveries, unit, unit === "delivery" ? "deliveries" : undefined)}{partial ? " so far" : ""}</b>
                  <span>Week {Number(w.week.slice(-2))} · {span}{w.projects !== undefined ? ` · ${plural(w.projects, "project")}` : ""}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      <div className={styles.axis} aria-hidden="true">{weeks.map((w, i) => <span key={w.week} data-on={(anySelected ? selected(w) : i === weeks.length - 1) ? "" : undefined}>{day(w.start)}</span>)}</div>
    </div>
  );
}

export function ProjectLink({ id, name, className = styles.rowTitle }: { id: string; name: string; className?: string }) {
  return <Link href={`/projects/${id}`} className={className} title={name}>{projectParts(name).title}</Link>;
}

/** Latest deliveries: file opens in Drive, project opens its Pulse page. */
export function DeliveryFeed({ items, today, showProject = true, showCreditHowFor }: { items: Delivery[]; today: string; showProject?: boolean; showCreditHowFor?: string | null }) {
  return (
    <ul className={`${styles.list} ${styles.feed}`}>
      {items.map((d) => {
        const credit = deliveryCreditExplanation(d.credited_to, d.how, showCreditHowFor);
        const more = [credit ? `Delivery credit: ${credit}.` : null, `Source: ${d.path}`].filter(Boolean).join(" ");
        return (
          <li key={d.fileId} className={styles.row}>
            <span className={styles.rowIcon} aria-hidden="true">{d.deliverableType === "draft" ? "D" : "F"}</span>
            <div className={styles.rowMain}>
              <a className={styles.rowTitle} href={`https://drive.google.com/file/d/${encodeURIComponent(d.fileId)}/view`} target="_blank" rel="noreferrer" title={`${d.fileName} — open in Drive`}>{d.fileName}</a>
              <span className={styles.rowMeta}>
                {showProject && d.projectId && d.projectName ? <Link href={`/projects/${d.projectId}`} title={d.projectName}>{projectParts(d.projectName).title}</Link> : null}
                <span>{d.deliverableType === "draft" ? "Draft" : "Final"}</span>
                {d.actorName ? <span title={d.actorBasis ?? undefined}>{d.actorName}</span> : d.sharedLogin ? null : <span title={d.actorBasis ?? 'No upload observation names a person'}>Person not identified</span>}
                {d.editedBy ? <span>Edited by {d.editedBy}</span> : null}
                <span className={styles.hideSmall}>{d.uploaderAccount ? <Link href={`/people/accounts/${encodeURIComponent(d.uploaderAccount)}`} title={`Snapshot account: ${d.uploaderAccount}; uploader attribution is shown separately`}>{d.sharedLogin ? "Shared login" : d.identityVerified ? d.uploaderAccount.split("@")[0] : `${d.uploaderAccount.split("@")[0]} (not linked)`}</Link> : "Unknown account"}</span>
              </span>
            </div>
            <span className={styles.rowEnd}>
              <Link href={`/deliveries/${encodeURIComponent(d.fileId)}`} className={styles.btn} title="View provenance and correct this delivery">Details</Link>
              <time dateTime={d.deliveredAt}>{when(d.deliveredAt, today)}</time>
              <Why detail={d.ruleDetail} more={more} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function Meter({ value, max }: { value: number; max: number }) {
  return <span className={styles.meter} aria-hidden="true"><i style={{ width: `${max ? (value / max) * 100 : 0}%` }} /></span>;
}

export function Tabs({ items, current }: { items: { href: string; label: string }[]; current: string }) {
  return <nav suppressHydrationWarning className={styles.tabs} aria-label="Sections">{items.map((t) => <Link key={t.href} href={t.href} className={styles.tab} aria-current={t.href === current ? "page" : undefined}>{t.label}</Link>)}</nav>;
}

const hue = (text: string) => { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
export const initials = (name: string) => name.replace(/\([^)]*\)/g, " ").trim().replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase() || "?";
export const hueStyle = (name: string) => ({ "--hue": hue(name) }) as CSSProperties;

/** A person's photo, or their initials on a colour that stays the same for the same name. */
/** One avatar everywhere: a fixed square (or circle) of `size`, the photo when there is one, else initials. `status`
 *  adds the person's presence dot (in the office, on a shoot…); `present` is the older "checked in" dot. */
export function Avatar({ name, id, photoAt, size = 32, shape, ai, present, status, className }: { name: string; id?: string; photoAt?: string | null; size?: number; shape?: "square"; ai?: boolean; present?: boolean; status?: boolean; className?: string }) {
  const boxed = ai || present || (status && !!id);
  const face = (
    <span className={`${styles.avatar}${className && !boxed ? ` ${className}` : ""}`} data-shape={ai ? "square" : shape} style={{ "--size": `${size}px`, "--hue": hue(name) } as CSSProperties} aria-hidden="true">
      {/* E2E-4P (owner check): the initials sit under the photo, so a slow or missing photo is never a blank circle. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- served by /photo from the database, already sized */}
      {initials(name)}{id && photoAt ? <img src={`/photo/${id}?v=${Date.parse(photoAt)}`} alt="" width={size} height={size} loading="lazy" /> : null}
    </span>
  );
  // The dot sits outside the clipped circle, so it is never cut in half.
  return boxed ? <span className={`${styles.avatarBox}${className ? ` ${className}` : ""}`} style={{ "--size": `${size}px` } as CSSProperties}>{face}{ai ? <span className={styles.avatarAi} aria-hidden="true">AI</span> : status && id ? <PresenceDot id={id} size={size} /> : <i className={styles.presence} title="Checked in" />}</span> : face;
}

/** Tabs that live in the URL as ?tab=, so a refresh or a shared link opens the same tab. */
export function QueryTabs({ base, items, current, keep, param = "tab", sub, label }: { base: string; items: { key: string; label: ReactNode; count?: number }[]; current: string; keep?: string; /** The query key; sub-tabs use their own. */ param?: string; /** Second level: drawn as a segmented control. */ sub?: boolean; /** The row's name when a page stacks two rows (the group it opens), so no two share one. */ label?: string }) {
  return <nav suppressHydrationWarning className={sub ? styles.segmented : styles.tabs} aria-label={label ?? (sub ? "Views" : "Sections")}>{items.map((t, i) => {
    const q = [keep ?? "", i ? `${param}=${t.key}` : ""].filter(Boolean).join("&");
    // UX-5B: a tab the destinations registry knows is its anchor ("Go there" spotlights it when nothing finer exists).
    const known = destForHref(`${base}?${[keep ?? "", `${param}=${t.key}`].filter(Boolean).join("&")}`);
    return <Link key={t.key} href={q ? `${base}?${q}` : base} scroll={false} className={sub ? styles.segment : styles.tab} aria-current={t.key === current ? (sub ? "true" : "page") : undefined} data-dest={known?.kind === "tab" ? known.id : undefined}>{t.label}{t.count !== undefined ? <span className={styles.muted}> {count(t.count)}</span> : null}</Link>;
  })}</nav>;
}

/** A value, or a quiet prompt to add it when the record is still incomplete. */
export function Fact({ value, missing = "Not set" }: { value?: ReactNode; missing?: string }) {
  return value === null || value === undefined || value === "" ? <span className={styles.muted}>{missing}</span> : <>{value}</>;
}

export function History({ items }: { items: { field: string; from: string | null; to: string | null; at: string; by: string | null }[] }) {
  return <ul className={styles.timeline}>{items.map((h, i) => (
    <li key={i}><span>{h.field === "created" ? <>Record created: <b>{h.to}</b></> : <><b>{label(h.field)}</b> {h.to ? <>set to “{h.to}”</> : "cleared"}{h.from ? <span className={styles.muted}> (was “{h.from}”)</span> : null}</>}</span>
      <small>{h.by ?? "Pulse"} · {dayTime(h.at)}</small></li>
  ))}</ul>;
}
const label = (field: string) => { const text = field.replace(/([A-Z])/g, " $1").replace(/ id$/i, "").toLowerCase(); return text.charAt(0).toUpperCase() + text.slice(1); };

export function Skeleton({ width = "100%", height = 14 }: { width?: number | string; height?: number }) {
  return <span className={styles.skeleton} style={{ display: "block", width, height }} />;
}

export const fmtCount = count;
export { Pager };

/** A component's name for Workspace's labels. Production builds shorten function names (the staff dashboard's
 *  "Needs attention" became "Details"), so client components are read from their reference ("…#TodayCard") and
 *  server components carry a displayName set by `viewNames`. */
const typeName = (type: unknown) => { const t = type as { $$id?: unknown; displayName?: unknown; name?: unknown }; return (typeof t.$$id === "string" ? t.$$id.split("#").pop() : "") || (typeof t.displayName === "string" ? t.displayName : "") || (typeof t.name === "string" ? t.name : ""); };
/** Names server components so Workspace can label and pin them after minification. */
export function viewNames(parts: Record<string, object>) { for (const [name, part] of Object.entries(parts)) (part as { displayName?: string }).displayName = name; }

/** Give existing panel groups secondary views instead of stacking them below the window. */
export function Workspace({ children, param, initial, labels, min, groups, wrap }: { children: ReactNode; param?: string; initial?: number; labels?: string[]; min?:number; groups?:boolean; /** Views wrap on a phone instead of paging behind arrows. */ wrap?: boolean }) {
  const items: { label: string; content: ReactNode }[] = [];
  const pinned: ReactNode[] = [];
  const collect = (nodes: ReactNode) => Children.forEach(nodes, (node) => {
    if (!isValidElement<{ children?: ReactNode; title?: string; className?: string; onSubmit?: unknown; "aria-label"?: string }>(node)) return;
    if (node.type === Tiles || (typeof node.type !== "string" && typeName(node.type) === "WeekTiles")) { pinned.push(node); return; }
    if (node.type === Panel) { items.push({ label: node.props.title ?? "Details", content: cloneElement(node as React.ReactElement<React.ComponentProps<typeof Panel>>, { fill: true }) }); return; }
    if (node.type === "form") {
      let label = "Working rules";
      const body = Children.map(node.props.children, (child) => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return child;
        if (child.type === "fieldset") return <Pager><fieldset {...child.props} data-items="" /></Pager>;
        return child;
      });
      label = /orgForm/.test(node.props.className ?? "") ? "Organisation" : label;
      items.push({ label, content: cloneElement(node, {}, body) }); return;
    }
    if (node.type === "section") {
      const heading = (nodes: ReactNode): string => { let text = ""; Children.forEach(nodes, (child) => { if (text || !isValidElement<{children?: ReactNode}>(child)) return; if (child.type === "h3" || child.type === "b") { const first = Children.toArray(child.props.children).find((c) => typeof c === "string"); if (typeof first === "string") text = first; } else text = heading(child.props.children); }); return text; };
      const body = Children.toArray(node.props.children);
      // QA-1024 (R013): children lifted out of a data-items wrapper keep their keys under the wrapper's key, so they never
      // collide with the section's own children (both had ".2": React's duplicate-key warning on Finance > Budget).
      const flatten = (nodes: ReactNode[]): ReactNode[] => nodes.flatMap(child => isValidElement<{children?:ReactNode;"data-items"?:unknown;className?:string}>(child) && child.props["data-items"] !== undefined ? flatten(Children.toArray(child.props.children)).map(c => isValidElement(c) ? cloneElement(c, { key: `${child.key ?? ""}/${c.key ?? ""}` }) : c) : [child]);
      const content = groups && body.some(child => isValidElement(child) && child.type === Pager) ? cloneElement(node, { className: `${node.props.className ?? ""} ${styles.panelFill}` }, ...body) : cloneElement(node, { className: `${node.props.className ?? ""} ${styles.panelFill}` }, body[0], <Pager compact min={min ?? (groups ? 1 : undefined)}>{groups?<div data-items="" data-tap-ok="">{flatten(body.slice(1))}</div>:body.slice(1)}</Pager>);
      items.push({ label: node.props["aria-label"] ?? (heading(node.props.children) || "Summary"), content }); return;
    }
    // A loose note (restriction notice, hint) explains every view, so it stays above them rather than becoming a view of its own.
    if (node.type === "p") { pinned.push(node); return; }
    if (node.type === Fragment || (node.type === "div" && /__(columns|grid|stack|halves|top|roleGrid|podGrid|narrow|meCol|pods|sources)/.test(node.props.className ?? ""))) { collect(node.props.children); return; }
    if (typeof node.type === "string") { const label = node.type === "details" ? "How Pulse knows" : "Overview"; items.push({label, content: <Panel fill title={label}>{node}</Panel>}); return; }
    // A self-contained component remains intact, with its own view.
    const name = typeof node.type !== "string" ? typeName(node.type) : "";
    const labels: Record<string, string> = { TodayCard: "Today", Appearance: "Appearance", WorkingRules: "Working rules", Organisation: "Organisation", Restricted: "Restricted permissions", PerformancePanel: "Performance", Tiles: "Summary", WeekTiles: "Summary", TrendPanel: "Delivery trend", FeedPanel: "Latest deliveries", TopProjects: "Most active projects", AttentionPanel: "Needs attention", DeliveriesPanel: "Recent deliveries", ProjectsPanel: "Projects delivering", SalaryTable: "Salary history", PodsPanel: "Pods", MixPanel: "Creative mix", ClientsPanel: "Clients", IdentityPanel: "Who delivered", LocationsPanel: "Locations", SegmentsPanel: "Segments", AttendancePanel: "Attendance", RiskList: "Risks", Pipeline: "Pipeline", AttendanceLeaveTab: "Attendance & leave" };
    items.push({ label: node.props.title ?? labels[name] ?? "Details", content: node });
  });
  collect(children);
  if (labels) items.forEach((item, i) => { if (labels[i]) item.label = labels[i]; });
  const seen = new Map<string, number>();
  for (const item of items) { const n = seen.get(item.label) ?? 0; seen.set(item.label, n + 1); if (n) item.label += ` ${n + 1}`; }
  return <div className={styles.taskWorkspace} data-grow="">{pinned}<Sections items={items} param={param} initial={initial} wrap={wrap} /></div>;
}
