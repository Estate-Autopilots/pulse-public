"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): Settings → Privacy, for the company's admins: usage recording on/off (default on,
// as the owner wants), session replay on/off, how long usage and replays are kept (default 30 days), the share of
// sessions recorded, the soft "something off?" prompt, friction alerts opening bug tasks, and the project bug tasks go
// to. Everyone else sees what is on (GET/POST /api/v0/telemetry/settings).
import { useEffect, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { Switch } from "./kit";
import { styles } from "./ui";

type Settings = { enabled: boolean; replay: boolean; sample: number; replaySample: number; prompts: boolean; retentionDays?: number; autoTask?: boolean; bugProjectId?: string | null;
  projects?: { id: string; name: string }[]; canChange?: boolean };
const KEEP = [7, 14, 30, 60, 90, 180, 365];
const SHARES = [1, 0.5, 0.25, 0.1];

export function UsageSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/v0/telemetry/settings", { cache: "no-store", signal: ctl.signal }).then((r) => (r.ok ? r.json() : null)).then(setS).catch(() => {});
    return () => ctl.abort();
  }, []);
  if (!s) return null;
  const save = async (change: Partial<Settings>) => {
    setBusy(true);
    try {
      const r = await fetch("/api/v0/telemetry/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      const next = await r.json().catch(() => ({})) as Settings & { error?: string };
      if (!r.ok) throw new Error(next.error ?? "Not saved. Try again.");
      setS(next);
      try { window.sessionStorage.removeItem("pulse.telemetry.settings"); } catch { /* storage off */ }
      notify({ id: "usage-settings", tone: "success", title: "Saved", message: "It applies as people open Pulse again.", timeout: 2500 });
    } catch (e) { notify({ id: "usage-settings", tone: "error", title: (e as Error).message }); } finally { setBusy(false); }
  };
  if (!s.canChange) return <p className={styles.muted} style={{ margin: "8px 0 0" }} data-testid="usage-state">
    In your company: usage recording is {s.enabled ? "on" : "off"}{s.enabled ? `, session replay ${s.replay ? "on" : "off"}` : ""}. An admin can change this.</p>;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return <div style={{ display: "grid", gap: 12, marginTop: 12 }} data-testid="usage-settings" aria-busy={busy || undefined}>
    <Switch label="Record how Pulse is used" hint="Pages, clicks, speed, errors and where people get stuck. Never what anyone types." checked={s.enabled} onChange={(on) => void save({ enabled: on })} />
    <Switch label="Session replay" hint="Replays of how screens moved, to see what went wrong. Typed values, passwords, money and personal pages are hidden on the device." checked={s.enabled && s.replay} onChange={(on) => void save({ replay: on })} />
    <Switch label="Offer to report a problem" hint="When someone clicks repeatedly, a click does nothing, an error shows or they are stuck on a form, Pulse softly asks if something is off. At most once every 10 minutes." checked={s.prompts} onChange={(on) => void save({ prompts: on })} />
    <Switch label="Friction alerts open a bug task" hint="When people keep getting stuck on the same screen or button, a task is opened by itself." checked={!!s.autoTask} onChange={(on) => void save({ autoTask: on })} />
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      <label className={styles.muted} style={{ display: "grid", gap: 4, fontSize: 13 }}>Keep usage and replays for
        <select value={s.retentionDays ?? 30} disabled={busy} onChange={(e) => void save({ retentionDays: Number(e.target.value) })} data-testid="usage-retention">
          {KEEP.map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
      <label className={styles.muted} style={{ display: "grid", gap: 4, fontSize: 13 }}>Sessions recorded
        <select value={s.sample} disabled={busy} onChange={(e) => void save({ sample: Number(e.target.value) })}>{SHARES.map((x) => <option key={x} value={x}>{pct(x)}</option>)}</select></label>
      <label className={styles.muted} style={{ display: "grid", gap: 4, fontSize: 13 }}>Sessions replayed
        <select value={s.replaySample} disabled={busy} onChange={(e) => void save({ replaySample: Number(e.target.value) })}>{SHARES.map((x) => <option key={x} value={x}>{pct(x)}</option>)}</select></label>
      <label className={styles.muted} style={{ display: "grid", gap: 4, fontSize: 13 }}>Bug tasks go to
        <select value={s.bugProjectId ?? ""} disabled={busy} onChange={(e) => void save({ bugProjectId: e.target.value || null })}>
          <option value="">A project named “Bugs”, if any</option>{(s.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
  </div>;
}
