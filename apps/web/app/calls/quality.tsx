"use client";
// CALLS-V2: for leadership and admins, under the calls list: how calls connected over the last 14 days (what each
// browser measured: GET /api/v0/calls/quality) and the company's call policy (admins change it: who may record,
// transcripts, AI notes). Numbers are counts and times; the media path and the causes of failures read as plain words.
import { useEffect, useState } from "react";
import { Kpi, Panel } from "../ui";
import { Segmented } from "../kit";
import css from "./calls.module.css";

type Summary = { days: number; calls: number; answered: number; missed: number; failed: number; setupP50: number | null; setupP90: number | null; connects: number;
  paths: Record<string, number>; failures: Record<string, number>; reconnects: number; rttMs: number | null; jitterMs: number | null; lossPct: number | null;
  recent: { at: string; reason: string | null; network: string | null; platform: string | null; device: string | null; relayOffered: boolean | null; relayGathered: boolean | null; channelKind: string | null }[] };
type Policy = { recording: "off" | "staff"; transcripts: boolean; aiSummary: "off" | "staff" | "all"; updatedAt: string | null; updatedBy: string | null };

const PATHS: [string, string][] = [["host", "Direct, same network"], ["srflx", "Direct over the internet"], ["prflx", "Direct over the internet"], ["relay-udp", "Through Pulse’s relay (UDP)"], ["relay-tcp", "Through Pulse’s relay (TCP, port 443)"], ["relay-tls", "Through Pulse’s relay (TLS)"], ["unknown", "Not known"]];
const REASONS: Record<string, string> = { "media-denied": "Microphone or camera not allowed", "media-missing": "No microphone or camera", "media-busy": "Microphone in use by another app", "media-unsupported": "Browser can’t make calls",
  "no-connect": "Could not connect (network)", "api-down": "Pulse could not be reached" };
const secs = (ms: number | null) => ms === null ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** One row per item: its words, a bar of its share (one colour: this is how much, not which), and the count. */
function Bars({ rows, label }: { rows: [string, number][]; label: string }) {
  const total = rows.reduce((n, [, v]) => n + v, 0);
  if (!total) return <p className={css.qMuted}>Nothing yet.</p>;
  return <ul className={css.bars} aria-label={label}>{rows.map(([k, v]) => <li key={k} title={`${k}: ${v} of ${total} (${Math.round((v / total) * 100)}%)`}>
    <span className={css.barLabel}>{k}</span>
    <span className={css.barTrack} aria-hidden="true"><i style={{ width: `${Math.max(2, (v / total) * 100)}%` }} /></span>
    <span className={css.barValue}>{v}<small> · {Math.round((v / total) * 100)}%</small></span>
  </li>)}</ul>;
}

export function CallQuality({ admin }: { admin: boolean }) {
  const [q, setQ] = useState<Summary | null>(null), [policy, setPolicy] = useState<Policy | null>(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    void fetch("/api/v0/calls/quality?days=14", { cache: "no-store", signal: ac.signal }).then((r) => r.ok ? r.json() : null).then((d) => { if (d) setQ(d as Summary); }).catch(() => {});
    void fetch("/api/v0/calls/policy", { cache: "no-store", signal: ac.signal }).then((r) => r.ok ? r.json() : null).then((d) => { if (d) setPolicy(d as Policy); }).catch(() => {});
    return () => ac.abort();
  }, []);
  async function save(next: Partial<Policy>) {
    if (!policy) return; const was = policy, p = { ...policy, ...next };
    setPolicy(p); setBusy(true); setNote("");
    try {
      const r = await fetch("/api/v0/calls/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recording: p.recording, transcripts: p.transcripts, aiSummary: p.aiSummary }) });
      const d = await r.json().catch(() => ({})) as Policy & { error?: string };
      if (!r.ok) throw new Error(d.error ?? "Not saved. Try again.");
      setPolicy(d); setNote("Saved");
    } catch (e) { setPolicy(was); setNote((e as Error).message); } finally { setBusy(false); }
  }
  if (!q && !policy) return null;
  const paths = new Map<string, number>(); for (const [k, label] of PATHS) { const v = q?.paths[k] ?? 0; if (v) paths.set(label, (paths.get(label) ?? 0) + v); }
  const relay = Object.entries(q?.paths ?? {}).filter(([k]) => k.startsWith("relay")).reduce((n, [, v]) => n + v, 0);
  return <div className={css.quality}>
    {q ? <Panel title="How calls connected" sub={`Last ${q.days} days, as each browser measured it`}>
      <div className={css.kpis}>
        <Kpi label="Calls" value={q.calls} note={`${q.answered} answered · ${q.missed} missed`} />
        <Kpi label="Connected in" value={secs(q.setupP50)} note={q.setupP90 !== null ? `9 in 10 within ${secs(q.setupP90)} (answer to voice)` : "after the answer, until voices flow"} />
        <Kpi label="Didn’t connect" value={q.failed} tone={q.failed ? "warning" : undefined} note={`${Object.values(q.failures).reduce((n, v) => n + v, 0)} problems noted`} />
        <Kpi label="Through the relay" value={q.connects ? `${Math.round((relay / q.connects) * 100)}%` : "–"} note="calls that needed Pulse’s relay to connect" />
      </div>
      <div className={css.qGrid}>
        <section><h4>Which way the voice went</h4><Bars label="Which way the voice went" rows={[...paths.entries()]} /></section>
        <section><h4>Why calls had trouble</h4><Bars label="Why calls had trouble" rows={Object.entries(q.failures).map(([k, v]) => [REASONS[k] ?? k, v] as [string, number]).sort((a, b) => b[1] - a[1])} /></section>
      </div>
      <p className={css.qMuted}>Round trip {secs(q.rttMs)} · jitter {secs(q.jitterMs)} · loss {q.lossPct === null ? "–" : `${q.lossPct}%`} · {q.reconnects} reconnect{q.reconnects === 1 ? "" : "s"} after a network change.</p>
      {q.recent.length ? <details className={css.qRecent}><summary>Recent problems ({q.recent.length})</summary><ul>{q.recent.map((r, i) => <li key={i}>
        <time dateTime={r.at}>{when(r.at)}</time> · {REASONS[r.reason ?? ""] ?? r.reason ?? "Unknown"}{r.channelKind ? ` · ${r.channelKind === "direct" ? "one-to-one" : "group"}` : ""}
        {r.device ? ` · ${r.device}` : ""}{r.network ? ` on ${r.network}` : ""}{r.reason === "no-connect" ? (r.relayOffered === false ? " · no relay was offered" : r.relayGathered === false ? " · the relay could not be reached" : "") : ""}</li>)}</ul></details> : null}
    </Panel> : null}
    {policy ? <Panel title="Call recording and notes" sub={admin ? "For everyone at the company" : "Set by an admin"}>
      <div className={css.policy}>
        <label><span><b>Who may record</b><small>Everyone in the call sees “Recording” and is asked to stay or leave.</small></span>
          <Segmented label="Who may record" value={policy.recording} onChange={(v) => admin && !busy ? void save({ recording: v }) : undefined}
            options={[{ value: "staff", label: "Team members in the call", disabled: !admin }, { value: "off", label: "Nobody", disabled: !admin }]} /></label>
        <label><span><b>Transcripts</b><small>Made on Pulse’s own server; the audio never leaves it.</small></span>
          <Segmented label="Transcripts" value={policy.transcripts ? "on" : "off"} onChange={(v) => admin && !busy ? void save({ transcripts: v === "on" }) : undefined}
            options={[{ value: "on", label: "On", disabled: !admin }, { value: "off", label: "Off", disabled: !admin }]} /></label>
        <label><span><b>AI notes</b><small>A summary and action items by an AI employee, from the transcript. Its engine reads the transcript.</small></span>
          <Segmented label="AI notes" value={policy.aiSummary} onChange={(v) => admin && !busy ? void save({ aiSummary: v }) : undefined}
            options={[{ value: "staff", label: "Team calls only", disabled: !admin }, { value: "all", label: "Every recorded call", disabled: !admin }, { value: "off", label: "Off", disabled: !admin }]} /></label>
      </div>
      <p className={css.qMuted} role="status">{note || (policy.updatedAt ? `Changed by ${policy.updatedBy ?? "an admin"}, ${when(policy.updatedAt)}` : "The defaults: team members may record; transcripts on; AI notes for team calls only.")}</p>
    </Panel> : null}
  </div>;
}
