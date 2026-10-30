"use client";
// INSIGHTS-2: the analysis book's charts in the Insights chart system (WA-REPORT 1074 blocks `kpis`, `bars`, `cols`):
// the same frame, tips, PNG / CSV export and palette as the Client operations tabs. Data comes from the page's blocks.
import { Story } from "../cards";
import { Bars, Columns, Kpis, type Series } from "../viz";

const TONE: Record<string, Series> = { danger: "bad", warning: "warn", success: "good", accent: "accent" };

export function ReportKpis({ items }: { items: { label: string; value: string; unit?: string; note?: string; tone?: string }[] }) {
  return <Kpis items={items.map((k) => ({ label: k.label, value: k.value, unit: k.unit, note: k.note, s: k.tone ? TONE[k.tone] : undefined }))} />;
}

export function ReportBars({ title, sub, unit, total, items }: { title?: string; sub?: string; unit?: string; total?: number; items: { label: string; value: number; sub?: string; href?: string }[] }) {
  return <Story title={title ?? "Counts"} sub={sub} rows={items.map((x) => ({ label: x.label, value: x.value, detail: x.sub ?? "" }))}>
    <Bars rows={items.map((x) => ({ label: x.label, value: x.value, sub: x.sub, href: x.href }))} unit={unit ?? ""} total={total} label={title ?? "Counts"} />
  </Story>;
}

export function ReportCols({ title, sub, suffix, items }: { title?: string; sub?: string; suffix?: string; items: { label: string; value: number; tip?: string }[] }) {
  // a long run of periods reads better as a line; a few categories as columns
  return <Story title={title ?? "Over time"} sub={sub} rows={items.map((x) => ({ label: x.label, value: x.value }))}>
    <Columns rows={items.map((x, i) => ({ x: `${i}`, label: x.label, value: x.value }))} unit={suffix ?? ""} label={title ?? "Over time"} />
  </Story>;
}
