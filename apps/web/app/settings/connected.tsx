import { Cable, CircleCheck, CircleX, FileSpreadsheet, FileText, FolderSync, HardDrive, LoaderCircle, Megaphone, UsersRound, type LucideIcon } from "lucide-react";
import { ago, dayTime, time } from "../lib/format";
import { Badge, Empty, Panel, styles } from "../ui";
import { Sections } from "../sections";
import { Connectors } from "./connectors";
import css from "./settings.module.css";
import type { SettingsData, Source, SyncRun } from "./types";

const ICONS: Record<string, LucideIcon> = { drive: HardDrive, "drive-changes": FolderSync, "drive-text": FileText, connectors: Cable, workspace: UsersRound, "hr-documents": FileSpreadsheet, groups: FileSpreadsheet, "ops-hub": FileSpreadsheet, "meta-ads": Megaphone };
const STATE: Record<Source["state"], { label: string; tone: "success" | "neutral" | "warning" }> = {
  connected: { label: "Connected", tone: "success" }, manual: { label: "Kept by hand", tone: "warning" }, planned: { label: "Not connected", tone: "neutral" },
  attention: { label: "Needs review", tone: "warning" },
};
const seconds = (run: SyncRun) => run.finishedAt ? Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)) : null;
const took = (s: number) => s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;

/** Where Pulse's data comes from, how fresh it is, and the recent sync runs. Read-only. */
/** `connectors`: R52's Connectors tab shows only while its module is on (RELEASE-6; off on a server without PULSE_CONNECTORS). */
export function Connected({ sources, sync, runs, connectors }: Pick<SettingsData, "sources" | "sync" | "runs"> & { connectors: boolean }) {
  const last = sync?.lastRun;
  const live = sources.filter((s) => s.state === "connected" || s.state === "attention").length;
  // Two views: every source at a glance as wide cards, then the sync schedule with its run history.
  return <Sections items={[{ label: "Sources", content: <Panel fill title="Sources" sub={`${live} of ${sources.length} connected · Pulse only reads them`}>
    <div className={css.sources} data-items="">
      {sources.map((s, i) => { const Icon = ICONS[s.key] ?? Cable; const state = STATE[s.state] ?? STATE.planned; return (
        <section key={s.key} className={css.source} data-state={s.state} style={{ animationDelay: `${Math.min(i, 8) * 24}ms` }}>
          <div className={css.sourceTop}><span className={css.sourceIcon}><Icon size={15} strokeWidth={1.75} aria-hidden="true" /></span><b title={s.label}>{s.label}</b><Badge tone={state.tone}>{state.label}</Badge></div>
          <p>{s.detail}</p>
          <div className={css.sourceFoot}>{s.lastAt ? <>Last activity <time dateTime={s.lastAt} title={dayTime(s.lastAt)}>{ago(s.lastAt)}</time></> : "No activity recorded"}</div>
        </section>
      ); })}
    </div>
  </Panel> }, { label: "Sync", content: <section className={css.syncView} aria-label="Sync">
    {sync ? <Panel title="Sync" sub="Pulse reads the sources on a timer; nothing is written back to them">
      <div className={css.syncFacts}>
        <div className={css.syncFact}><span>Schedule</span><b>Every {sync.everyMinutes} minutes</b><small>{last ? last.finishedAt ? last.ok ? "The last run finished without errors" : "The last run failed" : "A run is in progress" : "No run recorded yet"}</small></div>
        <div className={css.syncFact}><span>Last successful sync</span><b>{sync.lastIndexedAt ? ago(sync.lastIndexedAt) : "Never"}</b><small>{sync.lastIndexedAt ? dayTime(sync.lastIndexedAt) : "Pulse has not finished a sync"}</small></div>
        <div className={css.syncFact}><span>Drive itself last read</span><b>{sync.upstreamAt ? ago(sync.upstreamAt) : "Unknown"}</b><small>{sync.upstreamAt ? `${dayTime(sync.upstreamAt)} · when the Drive index was last refreshed` : "The Drive index has not reported a time"}</small></div>
      </div>
      {last && last.ok === false && last.error ? <p className={css.note} style={{ marginTop: 12 }}><CircleX size={15} aria-hidden="true" /><span>The last run failed: {last.error}</span></p> : null}
    </Panel> : null}
    <Panel fill title="Recent sync runs" sub={runs.length ? `Last ${runs.length}` : undefined}>
      {runs.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Started</th><th>Result</th><th className={styles.hideSmall}>Source</th><th className={styles.right}>Took</th><th className={styles.hideSmall}>Drive read at</th></tr></thead>
        <tbody>{runs.map((run) => { const s = seconds(run); return (
          <tr key={run.id}>
            <td className={styles.nowrap}><time dateTime={run.startedAt}>{dayTime(run.startedAt)}</time></td>
            <td>{run.ok === true ? <span className={styles.inline} style={{ gap: 6, flexWrap: "nowrap" }}><CircleCheck size={14} color="var(--theme-success)" aria-hidden="true" />Finished</span>
              : run.ok === false ? <><span className={styles.inline} style={{ gap: 6, flexWrap: "nowrap" }}><CircleX size={14} color="var(--theme-danger)" aria-hidden="true" />Failed</span>{run.error ? <span className={css.error} title={run.error}>{run.error}</span> : null}</>
                : <span className={styles.inline} style={{ gap: 6, flexWrap: "nowrap", color: "var(--theme-text-muted)" }}><LoaderCircle size={14} aria-hidden="true" />{run.finishedAt ? "No result recorded" : "Running"}</span>}</td>
            <td className={`${styles.mono} ${styles.hideSmall}`}>{run.source}</td>
            <td className={styles.right}>{s === null ? <span className={styles.muted}>—</span> : took(s)}</td>
            <td className={`${styles.nowrap} ${styles.hideSmall}`}>{run.upstreamAt ? <time dateTime={run.upstreamAt} title={dayTime(run.upstreamAt)}>{time(run.upstreamAt)}</time> : <span className={styles.muted}>Not reported</span>}</td>
          </tr>
        ); })}</tbody>
      </table></div> : <Empty icon={Cable} compact title="No sync has run yet" text="Runs appear here once the first one starts." />}
    </Panel>
  </section> },
  // R52: the company's own connectors: install, grant, health and revoke.
  ...(connectors ? [{ label: "Connectors", content: <Connectors /> }] : [])]} />;
}
