"use client";
// AGENT-UI-CONTROL: an AI employee's screen control, on its profile (AI → Capabilities): how far it may drive the screen of
// the person it helps (Off, View, Act, Admin: one click for admins and leadership), what it may always do without asking
// (kept from the top bar's "Always"; one click takes it back) and its last 30 screen actions (who for, what, how it went:
// the audit trail). Its manager reads it too.
import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, MonitorSmartphone, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ago } from "../lib/format";
import { asks as asksWords, KINDS, LEVELS, type ActionName } from "./catalogue.mjs";
import css from "./agent-ui.module.css";

type Row = { id: string; action: string; args: Record<string, unknown>; state: string; target: { name: string }; createdAt: string; error: string | null; decidedBy: string | null; decision: string | null };
type Settings = { level: "off" | "view" | "act" | "admin"; canChange: boolean; allows: { action: string; level: string; by: string; at: string }[]; recent: Row[] };
const STATE: Record<string, string> = { asked: "Waiting for a yes", sent: "Sent", claimed: "On screen", done: "Done", failed: "Did not work", refused: "Said no", expired: "Nobody took it" };
const say = (action: string, args: Record<string, unknown>) => action === "card.show" ? `show a card: ${String(args.title ?? "")}` : asksWords(action, args);

export function ScreenControl({ agentId, name }: { agentId: string; name: string }) {
  const [s, setS] = useState<Settings | null>(null), [state, setState] = useState<"loading" | "ok" | "denied" | "error">("loading"), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/v0/screen/agents/${encodeURIComponent(agentId)}`, { cache: "no-store" }).then(async (r) => {
      if (!live) return;
      if (r.status === 401 || r.status === 403) { setState("denied"); return; }
      if (!r.ok) { setState("error"); return; }
      setS(await r.json() as Settings); setState("ok");
    }).catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [agentId]);
  async function change(path: string, method: "PUT" | "POST", body: unknown, done: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/v0/screen/agents/${encodeURIComponent(agentId)}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({})) as Settings & { error?: string };
      if (!r.ok) throw new Error(d.error ?? "That did not save. Try again.");
      setS(d); notify({ id: "screen-level", tone: "success", title: done, timeout: 2500 });
    } catch (e) { notify({ id: "screen-level", tone: "error", title: e instanceof Error ? e.message : "That did not save.", timeout: 4000 }); } finally { setBusy(false); }
  }
  const first = name.split(" ")[0] || name;
  return <section className={css.levels} aria-labelledby="screen-control-head" data-screen-control="">
    <header><h4 id="screen-control-head" style={{ display: "flex", alignItems: "center", gap: 7, margin: 0, fontSize: 15 }}><MonitorSmartphone size={16} aria-hidden="true" />Screen control</h4>
      <p style={{ margin: "4px 0 0", color: "var(--theme-text-muted)", fontSize: 13.5 }}>How far {first} may work the screen for the person it is helping, only while they talk to it.</p></header>
    {state === "loading" ? <p role="status" style={{ color: "var(--theme-text-muted)", fontSize: 13.5 }}><LoaderCircle size={14} aria-hidden="true" /> Loading…</p>
      : state === "denied" ? <p style={{ color: "var(--theme-text-muted)", fontSize: 13.5 }}><CircleAlert size={14} aria-hidden="true" /> Admins, leadership and its manager see this.</p>
      : state === "error" || !s ? <p role="alert" style={{ color: "var(--theme-danger)", fontSize: 13.5 }}>Pulse could not load this. Try again.</p>
      : <>
        <div className={css.levels} role="radiogroup" aria-label={`${first}’s screen control`}>
          {LEVELS.map((l) => <label key={l.key} className={css.level} data-on={s.level === l.key || undefined}>
            <input type="radio" name={`screen-${agentId}`} value={l.key} checked={s.level === l.key} disabled={!s.canChange || busy}
              onChange={() => void change("", "PUT", { level: l.key }, `${first}: screen control ${l.label}`)} />
            <b>{l.label}{l.key === "view" ? " (usual)" : ""}</b><span>{l.says}</span>
          </label>)}
        </div>
        {!s.canChange ? <p style={{ margin: 0, color: "var(--theme-text-muted)", fontSize: 13 }}>Admins and leadership change this.</p> : null}
        {s.allows.length ? <div><b style={{ fontSize: 13.5 }}>Always allowed</b>{s.allows.map((w) => <div key={w.action} className={css.allow}>
          <span>{(KINDS[w.action as ActionName] ?? w.action).replace(/^\w/, (c) => c.toUpperCase())} <span className={css.meta} style={{ display: "inline" }}>· {w.by}, {ago(w.at)}</span></span>
          {s.canChange ? <button type="button" className={css.ghost} disabled={busy} onClick={() => void change("/allows/remove", "POST", { action: w.action }, "It will ask again")} aria-label={`Ask again before: ${w.action}`}><X size={14} aria-hidden="true" />Ask again</button> : null}
        </div>)}</div> : null}
        <div><b style={{ fontSize: 13.5 }}>Last screen actions</b>
          {s.recent.length ? <ul className={css.log}>{s.recent.map((r) => <li key={r.id}>
            <span>{say(r.action, r.args)} · for {r.target.name}</span><span className={css.state} data-s={r.state}>{STATE[r.state] ?? r.state}{r.decidedBy && r.decision !== "no" ? ` · allowed by ${r.decidedBy}` : r.decidedBy ? ` · ${r.decidedBy}` : ""}</span>
            <time dateTime={r.createdAt}>{ago(r.createdAt)}</time>{r.error ? <span className={css.meta} style={{ display: "inline" }}>{r.error}</span> : null}
          </li>)}</ul> : <p style={{ margin: "6px 0 0", color: "var(--theme-text-muted)", fontSize: 13 }}>Nothing yet.</p>}
        </div>
      </>}
  </section>;
}
