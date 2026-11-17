"use client";
// ONBOARD-CHECKIN-TG (6 Nov 2026): link your own Telegram to the Vitals OS bot, or attach it to an AI employee. One
// button makes a one-time code and opens Telegram on it (t.me/<bot>?start=<code>); the bot answers "Linked" and this card
// notices by itself. Updates come as a short digest with Done / Approve / Snooze buttons (services/workers vitals_bot.py).
// AI-AGENTS-3 (owner, 17 Nov 2026: "a simple guided flow with a QR code so a person scans and has their own bot
// connected in seconds"): on a computer the code shows as a QR to scan with the phone's camera (Telegram opens on the
// phone with the code filled in); on a phone, Telegram opens at once as before. A status that cannot load says so
// with "Try again" instead of "Checking…" for ever.
import { CheckCircle2, Copy, ExternalLink, Link2Off, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { post } from "../records";
import { qrPath } from "../lib/qr-code.mjs";
import css from "./telegram-link.module.css";

type Status = { bot: string | null; waiting?: "token" | "own_bot" | null; linked: boolean; username: string | null; at: string | null; agents: { agentId: string; name: string; at: string }[] };
type Code = { code: string; url: string; expiresAt: string };

async function status(): Promise<Status | null> {
  try { const r = await fetch("/api/v0/telegram/link", { cache: "no-store" }); return r.ok ? await r.json() as Status : null; } catch { return null; }
}

/** The link as a QR code (the `qrcode` package's modules, one SVG path on a white square: scanners need the light margin). */
function LinkQr({ url, label }: { url: string; label: string }) {
  const { d, n } = useMemo(() => qrPath(url), [url]);
  return <svg className={css.qr} role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" data-link-qr={url}>
    <rect width={n} height={n} fill="#fff" /><path d={d} fill="#000" /></svg>;
}

/** Settings → Notifications (no agent) or an AI employee's page (agentId). */
export function TelegramLink({ agentId, agentName }: { agentId?: string; agentName?: string }) {
  const [s, setS] = useState<Status | null>(null), [code, setCode] = useState<Code | null>(null), [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [now, setNow] = useState(() => Date.now()), [onPhone, setOnPhone] = useState(false);
  const load = useCallback(() => status().then((x) => { if (x) { setS(x); setFailed(false); } else setFailed(true); }), []);
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
    try {
      const c = await post<Code>("telegram/link", agentId ? { agentId } : {}); setCode(c); setNow(Date.now());
      // A phone opens Telegram right away; a computer shows the QR to scan with the phone (and a link to open it here).
      const phone = window.matchMedia?.("(pointer: coarse)").matches ?? false; setOnPhone(phone);
      if (phone) window.open(c.url, "_blank", "noopener");
    }
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
        <small>{!s ? (failed ? "Pulse could not check Telegram just now." : "Checking…") : !s.bot ? (s.waiting === "own_bot" ? "Waiting for your company’s own Telegram bot to start on the server." : "Waiting for the Vitals OS bot token. Telegram works here as soon as it is added.") : linked
          ? (agentId ? `Attached. Write to the Vitals bot to reach ${who}; replies come back there.` : `Linked${s.username ? ` as @${s.username}` : ""}. You get a short digest of what needs you, with buttons to finish, approve or snooze.`)
          : agentId ? `Message ${who} from Telegram and get its replies there. Your chat with it here keeps everything.` : "A short digest of what needs you (not every ping), with buttons to finish, approve or snooze. What an update is about stays in Vitals."}</small>
      </div>
      {linked ? <CheckCircle2 size={18} className={css.ok} aria-label="Linked" /> : null}
    </div>
    {!s && failed ? <div className={css.actions}><button type="button" className={css.quiet} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />Try again</button></div> : null}
    {s?.bot ? <div className={css.actions}>
      {linked ? <button type="button" className={css.quiet} disabled={busy} onClick={() => void unlink()}><Link2Off size={14} aria-hidden="true" />{agentId ? "Detach" : "Unlink"}</button>
        : <button type="button" className={code ? css.quiet : css.primary} disabled={busy} onClick={() => void start()}><Send size={14} aria-hidden="true" />{code ? "New code" : agentId ? "Attach Telegram" : "Link Telegram"}</button>}
    </div> : null}
    {code && !linked ? <div className={css.scan} data-telegram-steps="">
      {!onPhone && left > 0 ? <LinkQr url={code.url} label={`Scan with your phone to open Telegram on @${s?.bot ?? "the bot"}`} /> : null}
      <ol className={css.steps}>
        {onPhone ? <li>Telegram opens on <b>@{s?.bot}</b>. Press <b>Start</b>. <a href={code.url} target="_blank" rel="noopener noreferrer">Open it again<ExternalLink size={12} aria-hidden="true" /></a></li>
          : <><li><b>Point your phone’s camera at the code.</b> Tap the link it shows.</li>
            <li>Telegram opens on <b>@{s?.bot}</b>. Press <b>Start</b>.</li></>}
        <li aria-live="polite">{left > 0 ? `That’s it: this page shows “Linked” by itself. The code works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.` : "The code expired. Make a new one."}</li>
      </ol>
      <p className={css.other}>{onPhone ? null : <><a href={code.url} target="_blank" rel="noopener noreferrer">Use Telegram on this computer<ExternalLink size={12} aria-hidden="true" /></a> · </>}
        Or send the bot <code className={css.code}>/start {code.code}</code>
        <button type="button" className={css.copy} aria-label="Copy the code" onClick={() => { void navigator.clipboard?.writeText(`/start ${code.code}`).then(() => setNote("Copied.")).catch(() => {}); }}><Copy size={13} aria-hidden="true" /></button></p>
    </div> : null}
    {note ? <p role="status" className={css.note}>{note}</p> : null}
  </section>;
}
