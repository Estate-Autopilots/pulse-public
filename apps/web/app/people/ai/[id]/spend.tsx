"use client";
// AI-EMP (owner, 24 Oct 2026: "sometimes an agent burns 500k to multi-million tokens"): what an AI employee spent, on
// its profile's History: today, the last 7 and 14 days, each day as a bar split by the engine it ran on, how often it
// fell back or was held, and its biggest runs (tokens in and out). From GET /api/v0/agents/:id/spend (0988), which only
// its managers may read; for anyone else nothing shows.
import { useEffect, useState } from "react";
import css from "./profile.module.css";

type Run = { id: string; at: string; state: string; errorCode: string | null; engine: string | null; tier: string | null; fallbackFrom: string | null;
  tokens: number | null; tokensIn: number | null; tokensOut: number | null; seconds: number | null; kind: string };
type Day = { day: string; engine: string; runs: number; tokens: number; tokensIn: number; tokensOut: number; fallbacks: number; held: number };
type Spend = { runs: Run[]; days: Day[] };

const ZONE = "Asia/Kolkata";
const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const trim = (n: number) => (Math.round(n * 10) / 10).toString();
const size = (n: number) => n >= 100000 ? `${trim(n / 100000)} lakh` : n >= 1000 ? `${trim(n / 1000)}k` : String(Math.round(n));
const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: ZONE });
const dayName = (key: string) => new Date(`${key}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: ZONE });
/** "server:claude/sonnet" → "Claude (this server)": the engine a run used, as people say it. */
export function engineLabel(e: string | null): string {
  const id = (e ?? "").split("/")[0], [k, v] = id.split(":");
  if (k === "server") return v === "codex" ? "ChatGPT (this server)" : "Claude (this server)";
  if (k === "env") return v === "openai" ? "OpenAI API" : v === "openrouter" ? "OpenRouter" : "Claude API";
  if (k === "connection") return "A connected AI";
  if (k === "local") return "A local model";
  if (k === "stub" || id === "stub") return "Test runtime";
  return id ? id.replace(/[-_]/g, " ") : "Unknown";
}
/** The days of the last two weeks, newest first, each with its total and its split by engine. Pure (tested). */
export function spendByDay(days: Day[]) {
  const by = new Map<string, { day: string; tokens: number; runs: number; fallbacks: number; held: number; engines: Map<string, number> }>();
  for (const d of days) {
    const x = by.get(d.day) ?? { day: d.day, tokens: 0, runs: 0, fallbacks: 0, held: 0, engines: new Map<string, number>() };
    x.tokens += Number(d.tokens) || 0; x.runs += Number(d.runs) || 0; x.fallbacks += Number(d.fallbacks) || 0; x.held += Number(d.held) || 0;
    const label = engineLabel(d.engine); x.engines.set(label, (x.engines.get(label) ?? 0) + (Number(d.tokens) || 0));
    by.set(d.day, x);
  }
  return [...by.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export function AiSpend({ id }: { id: string }) {
  const [s, setS] = useState<Spend | null>(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    void fetch(`/api/v0/agents/${encodeURIComponent(id)}/spend?days=14`, { cache: "no-store" })
      .then(async (r) => { if (r.ok && live) setS(await r.json() as Spend); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  if (!s) return null;
  const days = spendByDay(s.days ?? []), today = dayKey(now), week = dayKey(now - 6 * 86400000);
  const sum = (f: (d: (typeof days)[number]) => boolean) => days.filter(f).reduce((n, d) => n + d.tokens, 0);
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const big = [...(s.runs ?? [])].filter((r) => (r.tokens ?? 0) > 0).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 3);
  const fell = days.reduce((n, d) => n + d.fallbacks, 0), held = days.reduce((n, d) => n + d.held, 0);
  if (!days.length) return null;
  return <section className={css.spend} aria-label="What it spent">
    <dl className={css.stats}>
      <div><dt>Today</dt><dd><b>{fmt(sum((d) => d.day === today))}</b> tokens</dd></div>
      <div><dt>Last 7 days</dt><dd><b>{fmt(sum((d) => d.day >= week))}</b> tokens</dd></div>
      <div><dt>Last 14 days</dt><dd><b>{fmt(sum(() => true))}</b> tokens</dd>
        <small>{days.reduce((n, d) => n + d.runs, 0)} runs{fell ? ` · ${fell} on a fallback engine` : ""}{held ? ` · ${held} held (budget, quota or stopped)` : ""}</small></div>
    </dl>
    <ul className={css.list}>{days.slice(0, 7).map((d) => <li key={d.day} className={css.spendDay}>
      <span className={css.itemMain}><b>{d.day === today ? "Today" : dayName(d.day)}</b>
        <small>{[...d.engines.entries()].sort((a, b) => b[1] - a[1]).map(([e, t]) => `${e} ${size(t)}`).join(" · ")}</small></span>
      <span className={css.bar} aria-hidden="true"><span style={{ width: `${Math.max(2, Math.round((d.tokens / max) * 100))}%` }} /></span>
      <span className={css.spendNum}>{size(d.tokens)} · {d.runs} {d.runs === 1 ? "run" : "runs"}</span>
    </li>)}</ul>
    {big.length ? <div className={css.itemMain}><small>Biggest runs: {big.map((r) => `${at(r.at)}, ${fmt(r.tokens ?? 0)} tokens${r.tokensIn !== null && r.tokensOut !== null ? ` (${size(r.tokensIn)} in, ${size(r.tokensOut)} out)` : ""} on ${engineLabel(r.engine)}${r.errorCode === "runaway" ? ", stopped as a runaway" : ""}`).join("; ")}</small></div> : null}
  </section>;
}
