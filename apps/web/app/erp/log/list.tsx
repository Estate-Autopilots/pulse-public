"use client";
// UX-BILLING (owner, 5 Nov 2026: screens "ugly, confusing and stupid"): the Billing log said "Quotation draft ·
// approval_asked" and "party · saved", two hundred lines in one block. Now: grouped by day (Today, Yesterday, 3 Nov), each
// line a plain sentence with a stripe in its colour (money in green, approvals amber, cancellations red), who did it and
// when, and My day's chips to show only documents, money, the catalogue and stock, or settings.
import { useMemo, useState } from "react";
import { History } from "lucide-react";
import { Calm, Card, EmptyState, SectionHeader, StripeList, StripeRow, type Tone } from "../../components/calm";
import { ChipFilter } from "../../components/chip-filter";
import { EVENT } from "../documents/chain";
import { TYPE_LABEL } from "../nav";
import { styles } from "../../ui";
import { describeLog, logShow, logTone } from "../../lib/billing-words.mjs";

export type LogEvent = { id: string; subjectType: string; subjectId: string | null; kind: string; detail: Record<string, unknown>; at: string; actor: string | null; number: string | null; docType: string | null; item: string | null };
type Show = "all" | "documents" | "money" | "catalogue" | "other";

// The words, stripes and chips of a log line live in lib/billing-words.mjs (unit-tested).
const tone = (kind: string): Tone => logTone(kind);
const show = (e: LogEvent): Show => logShow(e);
const describe = (e: LogEvent) => describeLog(e, EVENT, TYPE_LABEL);

const ZONE = "Asia/Kolkata";
const dayKey = (at: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(at));
const time = (at: string) => new Date(at).toLocaleTimeString("en-IN", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
function dayName(key: string, today: string, yesterday: string) {
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: key.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
}

export function LogList({ events }: { events: LogEvent[] }) {
  const [only, setOnly] = useState<Show>("all");
  const counts = useMemo(() => events.reduce((n, e) => { n[show(e)]++; return n; }, { all: events.length, documents: 0, money: 0, catalogue: 0, other: 0 } as Record<Show, number>), [events]);
  const days = useMemo(() => {
    const out: { key: string; items: LogEvent[] }[] = [];
    for (const e of events) {
      if (only !== "all" && show(e) !== only) continue;
      const k = dayKey(e.at);
      if (out.at(-1)?.key !== k) out.push({ key: k, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  }, [events, only]);
  // Today and yesterday in India, read once when the list first draws.
  const [now] = useState(() => Date.now());
  const today = dayKey(new Date(now).toISOString()), yesterday = dayKey(new Date(now - 864e5).toISOString());
  return <Calm>
    <ChipFilter label="Show" value={only} onChange={setOnly} hideEmpty chips={[{ value: "all", label: "Everything", count: counts.all }, { value: "documents", label: "Documents", count: counts.documents },
      { value: "money", label: "Payments", count: counts.money, tone: "success", dot: true }, { value: "catalogue", label: "Catalogue and stock", count: counts.catalogue }, { value: "other", label: "Settings and clients", count: counts.other }]} />
    {days.length ? days.map((d) => <Card key={d.key} label={`On ${d.key}`} flat>
      <SectionHeader title={<span suppressHydrationWarning>{dayName(d.key, today, yesterday)}</span>} count={d.items.length} />
      <StripeList label={`What happened, ${d.key}`}>{d.items.map((e) => {
        const x = describe(e);
        return <StripeRow key={e.id} tone={tone(e.kind)} href={x.href} title={`${x.of} · ${x.what}`}
          sub={<span suppressHydrationWarning>{time(e.at)} · {e.actor ?? (e.kind.startsWith("client") || e.kind === "link_opened" ? "the customer" : "Pulse")}</span>} />;
      })}</StripeList>
    </Card>) : <EmptyState icon={<History size={18} aria-hidden="true" />} title="Nothing here yet"
      text={events.length ? "Nothing of this kind in the last 200 entries. Choose Everything to see the rest." : "Every quotation, invoice, payment, catalogue change and setting will be listed here as it happens."}
      action={events.length ? <button type="button" className={styles.btn} onClick={() => setOnly("all")}>Show everything</button> : undefined} />}
    <p className={styles.muted}>Pulse&apos;s audit trail also keeps every field change.</p>
  </Calm>;
}
