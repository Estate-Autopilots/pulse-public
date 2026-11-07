// BUGKIT-TELEMETRY (owner, 6 Nov 2026): one session's replay, for leadership and admins (the API refuses everyone else).
// Opened from Insights → App friction (alerts, hotspots, the replay list) and the telemetry timeline.
import Link from "next/link";
import { api } from "../../../lib/api";
import { Message, Page, PageHeader, Panel, styles } from "../../../ui";
import type { ReplayMeta } from "../load";
import { ReplayPlayer } from "../player";

const when = (iso: string, zone: string) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export default async function ReplayPage({ params, searchParams }: { params: Promise<{ sid: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { sid } = await params;
  const q = await searchParams;
  const r = await api<ReplayMeta>(`telemetry/replay/${encodeURIComponent(sid)}`);
  if (r.error || !r.data) return <Message text={r.status === 403 ? "Replays are for leadership and admins" : r.error ?? "This replay could not load"} />;
  const m = r.data, first = m.chunks[0], last = m.chunks[m.chunks.length - 1];
  const screens = [...new Set(m.chunks.map((c) => c.route).filter((x): x is string => !!x))];
  const parts = `${m.chunks.length} ${m.chunks.length === 1 ? "part" : "parts"}${m.chunks.some((c) => c.reason === "report") ? " · sent with a bug report" : ""}`;
  return <Page>
    <PageHeader title="Session replay" back={{ href: "/insights?tab=friction", label: "App friction" }}
      context={[m.who ?? "Someone", `${when(first.startedAt, m.zone)} – ${when(last.endedAt, m.zone)}`, parts]}
      actions={<Link className={styles.btn} href={`/telemetry?session=${encodeURIComponent(sid)}`}>Timeline</Link>} />
    <Panel title="Replay" sub={screens.length ? `Screens: ${screens.slice(0, 6).join(", ")}${screens.length > 6 ? "…" : ""}` : undefined}>
      <div style={{ padding: "12px 16px" }}><ReplayPlayer meta={m} at={q.t} /></div>
    </Panel>
  </Page>;
}
