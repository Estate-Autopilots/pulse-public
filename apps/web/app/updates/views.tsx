import Link from "next/link";
import { ArrowRight, Newspaper } from "lucide-react";
import type { ReactNode } from "react";
import { AiBadge } from "../kit/ai-badge";
import { Avatar, Empty } from "../ui";
import type { UpdateCounts, UpdateDetail, UpdateItem, UpdateList, UpdateSummary } from "./types";
import css from "./updates.module.css";

export function statusTone(status: string) {
  if (["Live", "Done"].includes(status)) return "good";
  if (["Started", "In progress", "Test site"].includes(status)) return "progress";
  if (status === "Waiting") return "warn";
  return "neutral";
}
export function updateChips(counts: UpdateCounts) {
  return ([ ["needsYou", "Needs you"], ["live", "Live"], ["readyToTry", "Ready to try"], ["requests", "Requests"] ] as const)
    .filter(([key]) => counts[key] > 0).slice(0, 3).map(([key, label]) => `${counts[key]} ${label}`);
}
function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={css.chip} data-tone={tone}>{children}</span>;
}
function UpdateDate({ update, zone }: { update: UpdateSummary; zone: string }) {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric" }).format(new Date(update.createdAt));
  return <span className={css.meta}><time dateTime={update.createdAt}>{date}</time> · {update.period === "morning" ? "Morning" : "Night"} update</span>;
}
function Unread({ update }: { update: UpdateSummary }) {
  return update.openedAt === null ? <span className={css.unread} role="img" aria-label="Unread" /> : null;
}
/** The API labels the poster "<service label> (AI)"; next to the name the shared badge carries that marker. The poster is a
 *  service, not an AI employee, so the badge gets no employee ID. */
export const authorName = (poster: string) => poster.replace(/\s*\(AI\)$/, "");
function Chips({ update }: { update: UpdateSummary }) {
  return <div className={css.chips}>{updateChips(update.counts).map(label => <Chip key={label}>{label}</Chip>)}</div>;
}
export function HomeUpdate({ update, zone }: { update: UpdateSummary | null; zone: string }) {
  if (!update) return null;
  return <section className={css.home} aria-label="Newest update">
    <div className={css.summary}><p className={css.eyebrow}>Updates <Unread update={update} /></p>
      <h2>{update.headline}</h2><UpdateDate update={update} zone={zone} /><Chips update={update} /></div>
    <Link className={css.open} href={`/updates/${update.id}`} prefetch={false} aria-label={`Open update: ${update.headline}`}>Open <ArrowRight size={14} aria-hidden="true" /></Link>
  </section>;
}
export function UpdatesList({ data, zone }: { data: UpdateList; zone: string }) {
  return <div className={css.listPage}>
    {data.items.length ? <ul className={css.list}>{data.items.map(update => <li key={update.id}>
      <Link className={css.row} href={`/updates/${update.id}`} prefetch={false}>
        <UpdateDate update={update} zone={zone} /><h2><Unread update={update} />{update.headline}</h2>
        <Chips update={update} /><span className={css.meta}>{authorName(update.poster)}<AiBadge /> for {update.onBehalf.name}</span>
        <span className={css.rowOpen}>Open update <ArrowRight size={14} aria-hidden="true" /></span>
      </Link></li>)}</ul> : <Empty icon={Newspaper} title="No updates yet" text="Updates shared with you will appear here." />}
    {data.nextCursor ? <Link className={css.open} prefetch={false} href={`/updates?cursor=${encodeURIComponent(data.nextCursor)}`}>Show older</Link> : null}
  </div>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className={css.section}><h2>{title}</h2>{children}</section>;
}
function Item({ item, status, progress }: { item: UpdateItem; status?: string; progress?: number }) {
  const tag = status ?? item.tag;
  return <li className={css.item}><div><strong>{item.title}</strong>{item.note ? <p>{item.note}</p> : null}
    {progress !== undefined ? <div className={css.bar} role="progressbar" aria-label={item.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div> : null}</div>
    {tag ? <Chip tone={statusTone(tag)}>{tag}</Chip> : null}</li>;
}
function Items({ items }: { items: UpdateItem[] }) {
  return <ul className={css.items}>{items.map((item, i) => <Item key={i} item={item} />)}</ul>;
}
export function UpdateCard({ update, zone }: { update: UpdateDetail; zone: string }) {
  const s = update.sections;
  const audience = update.isSender ? update.openedBy?.filter(person => person.personId !== update.onBehalf.id) : undefined;
  return <article className={css.card}>
    <header className={css.band}><p className={css.author}><Avatar ai name={authorName(update.poster)} size={28} /><span>{authorName(update.poster)}</span><AiBadge /></p><UpdateDate update={update} zone={zone} /><h1>{update.headline}</h1></header>
    <div className={css.body}>
      {s.live?.length ? <Section title="Live for everyone"><Items items={s.live} /></Section> : null}
      {s.readyToTry?.length ? <Section title="Ready to try on the test site"><Items items={s.readyToTry} /></Section> : null}
      {s.requests?.length ? <Section title="Your requests"><ul className={css.items}>{s.requests.map((item, i) => <Item key={i} item={item} status={item.status} progress={item.progress} />)}</ul></Section> : null}
      {s.ideas?.length ? <Section title={`${update.onBehalf.name}'s ideas`}><Items items={s.ideas} /></Section> : null}
      {s.needsYou?.length ? <div className={css.needs}><Section title="Needs you"><ol>{s.needsYou.map((item, i) => <li key={i}>{item.text}</li>)}</ol></Section></div> : null}
      {s.plan?.items.length ? <Section title={s.plan.label === "Today" ? "Today's plan" : "Tomorrow"}><Items items={s.plan.items} /></Section> : null}
      <footer className={css.footer}><p>Prepared by {update.poster} for {update.onBehalf.name}</p>
        {audience?.length ? <div className={css.receipts}>{audience.map(person => <p key={person.personId}>{person.openedAt ? <>Opened by {person.name} · <time dateTime={person.openedAt}>{new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(person.openedAt))}</time></> : <>{person.name} · Not opened yet</>}</p>)}</div> : null}
        <div data-slot="update-reply" hidden />
      </footer>
    </div>
  </article>;
}
