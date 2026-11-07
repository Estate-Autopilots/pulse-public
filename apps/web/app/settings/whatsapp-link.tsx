"use client";
// AGENT-CHANNELS (1685): Connect WhatsApp on an AI employee's page. The company's WhatsApp Business number (Meta's official
// Cloud API) gets a one-time code from this person; a wa.me link fills it in ("link CODE"), and from then on what they
// write there goes into their chat with the AI employee in Vitals and its replies come back on WhatsApp.
import { CheckCircle2, Copy, ExternalLink, Link2Off, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { post } from "../records";
import css from "./telegram-link.module.css";

type Status = { on: boolean; running: boolean; ready: boolean; number: string | null; agents: { agentId: string; name: string; at: string; number: string }[] };
type Code = { code: string; url: string; number: string; expiresAt: string };

async function status(): Promise<Status | null> {
  try { const r = await fetch("/api/v0/whatsapp/link", { cache: "no-store" }); return r.ok ? await r.json() as Status : null; } catch { return null; }
}

export function WhatsAppLink({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [s, setS] = useState<Status | null>(null), [code, setCode] = useState<Code | null>(null);
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [now, setNow] = useState(() => Date.now());
  const load = useCallback(() => status().then((x) => { if (x) setS(x); }), []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  const mine = s?.agents.find((a) => a.agentId === agentId);
  useEffect(() => {
    if (!code || mine) return;
    const t = setInterval(() => { setNow(Date.now()); void load(); }, 3000);
    return () => clearInterval(t);
  }, [code, mine, load]);
  async function start() {
    setBusy(true); setNote("");
    try { const c = await post<Code>("whatsapp/link", { agentId }); setCode(c); setNow(Date.now()); window.open(c.url, "_blank", "noopener"); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not make a code."); }
    finally { setBusy(false); }
  }
  async function unlink() {
    setBusy(true); setNote("");
    try { await post("whatsapp/unlink", { agentId }); setCode(null); await load(); setNote("WhatsApp is no longer connected."); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not disconnect."); }
    finally { setBusy(false); }
  }
  const left = code ? Math.max(0, Math.round((Date.parse(code.expiresAt) - now) / 1000)) : 0;
  const state = !s ? "Checking…"
    : !s.on ? "Connect your WhatsApp Business number first: an admin switches WhatsApp on once Meta has approved the company’s number."
      : !s.ready ? "Waiting for the company’s WhatsApp Business number (Meta Cloud API credentials) on the server."
        : mine ? `Connected (${mine.number}). Write to ${s.number} on WhatsApp to reach ${agentName}; replies come back there.`
          : `Message ${agentName} from WhatsApp, on the company’s business number ${s.number}. Your chat with it in Vitals keeps everything.`;
  return <section className={css.card} aria-label={`WhatsApp for ${agentName}`}>
    <div className={css.head}>
      <span className={css.icon} style={{ background: "#25d366" }} aria-hidden="true"><MessageCircle size={18} /></span>
      <div className={css.text}><b>Talk to {agentName} on WhatsApp</b><small>{state}</small></div>
      {mine ? <CheckCircle2 size={18} className={css.ok} aria-label="Connected" /> : null}
    </div>
    {s?.ready ? <div className={css.actions}>
      {mine ? <button type="button" className={css.quiet} disabled={busy} onClick={() => void unlink()}><Link2Off size={14} aria-hidden="true" />Disconnect</button>
        : <button type="button" className={css.primary} disabled={busy} onClick={() => void start()}><MessageCircle size={14} aria-hidden="true" />{code ? "New code" : "Connect WhatsApp"}</button>}
    </div> : null}
    {code && !mine ? <ol className={css.steps}>
      <li>WhatsApp opens on <b>{code.number}</b> with the code filled in. Press send. <a href={code.url} target="_blank" rel="noopener noreferrer">Open it again<ExternalLink size={12} aria-hidden="true" /></a></li>
      <li>Or send this to {code.number}: <code className={css.code}>link {code.code}</code>
        <button type="button" className={css.copy} aria-label="Copy the code" onClick={() => { void navigator.clipboard?.writeText(`link ${code.code}`).then(() => setNote("Copied.")).catch(() => {}); }}><Copy size={13} aria-hidden="true" /></button></li>
      <li aria-live="polite">{left > 0 ? `This code works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more. This page notices when it’s connected.` : "The code expired. Make a new one."}</li>
    </ol> : null}
    {note ? <p role="status" className={css.note}>{note}</p> : null}
  </section>;
}
