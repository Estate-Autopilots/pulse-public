"use client";
// ONBOARD-CHECKIN-TG (6 Nov 2026): link your own Telegram to the Vitals OS bot, or attach it to an AI employee. One
// button makes a one-time code and opens Telegram on it (t.me/<bot>?start=<code>); the bot answers "Linked" and this card
// notices by itself. Updates come as a short digest with Done / Approve / Snooze buttons (services/workers vitals_bot.py).
import { CheckCircle2, Copy, ExternalLink, Link2Off, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { post } from "../records";
import css from "./telegram-link.module.css";

type Status = { bot: string | null; waiting?: "token" | "own_bot" | null; linked: boolean; username: string | null; at: string | null; agents: { agentId: string; name: string; at: string }[] };
type Code = { code: string; url: string; expiresAt: string };

async function status(): Promise<Status | null> {
  try { const r = await fetch("/api/v0/telegram/link", { cache: "no-store" }); return r.ok ? await r.json() as Status : null; } catch { return null; }
}

/** Settings → Notifications (no agent) or an AI employee's page (agentId). */
export function TelegramLink({ agentId, agentName }: { agentId?: string; agentName?: string }) {
  const [s, setS] = useState<Status | null>(null), [code, setCode] = useState<Code | null>(null);
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [now, setNow] = useState(() => Date.now());
  const load = useCallback(() => status().then((x) => { if (x) setS(x); }), []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  const linked = !!s && (agentId ? s.agents.some((a) => a.agentId === agentId) : s.linked);
  // While a code is open, look every 3 s for the bot's "linked", and count the code down.
  useEffect(() => {
    if (!code || linked) return;
    const t = setInterval(() => { setNow(Date.now()); void load(); }, 3000);
    return () => clearInterval(t);
  }, [code, linked, load]);
  async function start() {
    setBusy(true); setNote("");
    try { const c = await post<Code>("telegram/link", agentId ? { agentId } : {}); setCode(c); setNow(Date.now()); window.open(c.url, "_blank", "noopener"); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not make a code."); }
    finally { setBusy(false); }
  }
  async function unlink() {
    setBusy(true); setNote("");
    try { await post("telegram/unlink", agentId ? { agentId } : {}); setCode(null); await load(); setNote(agentId ? "Telegram is no longer attached." : "Telegram is unlinked. Nothing more goes there."); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not unlink."); }
    finally { setBusy(false); }
  }
  const left = code ? Math.max(0, Math.round((Date.parse(code.expiresAt) - now) / 1000)) : 0;
  const who = agentName ?? "your AI employee";
  return <section className={css.card} aria-label={agentId ? `Telegram for ${who}` : "Telegram"} id={agentId ? undefined : "telegram"}>
    <div className={css.head}>
      <span className={css.icon} aria-hidden="true"><Send size={18} /></span>
      <div className={css.text}>
        <b>{agentId ? `Talk to ${who} on Telegram` : "Telegram"}</b>
        <small>{!s ? "Checking…" : !s.bot ? (s.waiting === "own_bot" ? "Waiting for your company’s own Telegram bot to start on the server." : "Waiting for the Vitals OS bot token. Telegram works here as soon as it is added.") : linked
          ? (agentId ? `Attached. Write to the Vitals bot to reach ${who}; replies come back there.` : `Linked${s.username ? ` as @${s.username}` : ""}. You get a short digest of what needs you, with buttons to finish, approve or snooze.`)
          : agentId ? `Message ${who} from Telegram and get its replies there. Your chat with it in Vitals keeps everything.` : "A short digest of what needs you (not every ping), with buttons to finish, approve or snooze. What an update is about stays in Vitals."}</small>
      </div>
      {linked ? <CheckCircle2 size={18} className={css.ok} aria-label="Linked" /> : null}
    </div>
    {s?.bot ? <div className={css.actions}>
      {linked ? <button type="button" className={css.quiet} disabled={busy} onClick={() => void unlink()}><Link2Off size={14} aria-hidden="true" />{agentId ? "Detach" : "Unlink"}</button>
        : <button type="button" className={css.primary} disabled={busy} onClick={() => void start()}><Send size={14} aria-hidden="true" />{code ? "New code" : agentId ? "Attach Telegram" : "Link Telegram"}</button>}
    </div> : null}
    {code && !linked ? <ol className={css.steps}>
      <li>Telegram opens on <b>@{s?.bot}</b>. Press <b>Start</b>. <a href={code.url} target="_blank" rel="noopener noreferrer">Open it again<ExternalLink size={12} aria-hidden="true" /></a></li>
      <li>Or send this to the bot: <code className={css.code}>/start {code.code}</code>
        <button type="button" className={css.copy} aria-label="Copy the code" onClick={() => { void navigator.clipboard?.writeText(`/start ${code.code}`).then(() => setNote("Copied.")).catch(() => {}); }}><Copy size={13} aria-hidden="true" /></button></li>
      <li aria-live="polite">{left > 0 ? `This code works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more. This page notices when it’s linked.` : "The code expired. Make a new one."}</li>
    </ol> : null}
    {note ? <p role="status" className={css.note}>{note}</p> : null}
  </section>;
}
