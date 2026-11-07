"use client";
// AGENT-CHANNELS (1685): how to reach an AI employee, on its AI tab: Telegram (the shared Vitals OS bot or the company's
// own, with a per-employee deep link; /agent <name> switches in the chat), WhatsApp (the company's business number on
// Meta's Cloud API) and listening (it follows a conversation live). Its own file so the AI tab's settings stay separate.
import Link from "next/link";
import { Building2, Mic } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TelegramLink } from "../settings/telegram-link";
import { WhatsAppLink } from "../settings/whatsapp-link";
import css from "../settings/telegram-link.module.css";

type Settings = {
  canEdit: boolean;
  telegram: { bot: "shared" | "own"; ownUsername: string | null; running: boolean; runningBot: string | null };
  whatsapp: { on: boolean; running: boolean; number: string | null };
  listen: { on: boolean; retentionDays: number };
  server: { telegramSharedBot: string | null; whatsappWebhook: boolean };
};

/** Admins only: the company's channel settings (which Telegram bot, WhatsApp on, listening opt-in). */
function CompanyChannels() {
  const [s, setS] = useState<Settings | null>(null), [own, setOwn] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const load = useCallback(() => fetch("/api/v0/agent-channels", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((x: Settings | null) => {
    if (x) { setS(x); setOwn(x.telegram.ownUsername ?? ""); }
  }).catch(() => {}), []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  async function save(change: Record<string, unknown>) {
    setBusy(true); setNote("");
    try {
      const r = await fetch("/api/v0/agent-channels", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      const d = await r.json().catch(() => ({})) as Settings & { error?: string };
      if (!r.ok) throw new Error(d.error ?? "Could not save.");
      setS(d); setNote("Saved.");
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }
  if (!s?.canEdit) return null;
  const tg = s.telegram.running ? `Running as @${s.telegram.runningBot ?? s.telegram.ownUsername ?? "the bot"}.`
    : s.telegram.bot === "own" ? "Waiting for your own bot's token on the server." : "Waiting for the Vitals OS bot token.";
  const wa = s.whatsapp.running ? `Business number +${s.whatsapp.number ?? ""} is connected.` : s.server.whatsappWebhook ? "Credentials found; waiting for the sender to start." : "Waiting for the company’s WhatsApp Business number (Meta Cloud API credentials).";
  return <section className={css.card} aria-label="Company channels">
    <div className={css.head}>
      <span className={css.icon} style={{ background: "var(--theme-action, #5b45d6)" }} aria-hidden="true"><Building2 size={18} /></span>
      <div className={css.text}><b>Company channels (admins)</b><small>These apply to every AI employee in the company.</small></div>
    </div>
    <fieldset className={css.steps} style={{ border: 0, padding: 0 }} disabled={busy}>
      <label><input type="radio" name="tgbot" checked={s.telegram.bot === "shared"} onChange={() => void save({ telegramBot: "shared" })} /> Telegram: the shared Vitals OS bot</label>
      <label><input type="radio" name="tgbot" checked={s.telegram.bot === "own"} onChange={() => void save({ telegramBot: "own", telegramOwnUsername: own })} /> Telegram: our own bot
        {s.telegram.bot === "own" ? <> <input aria-label="Your bot's username" value={own} placeholder="OurCompanyBot" onChange={(e) => setOwn(e.target.value)} style={{ minHeight: 36, maxWidth: "100%" }} />
          <button type="button" className={css.quiet} onClick={() => void save({ telegramOwnUsername: own })}>Save</button></> : null}</label>
      <small className={css.note}>{tg}</small>
      <label><input type="checkbox" checked={s.whatsapp.on} onChange={(e) => void save({ whatsappOn: e.target.checked })} /> WhatsApp: people may connect AI employees to the company’s WhatsApp Business number</label>
      <small className={css.note}>{wa}</small>
      <label><input type="checkbox" checked={s.listen.on} onChange={(e) => void save({ listenOn: e.target.checked })} /> Listening: allow live transcripts that AI employees follow (transcripts kept {s.listen.retentionDays} days; change it on <Link href="/listen">Listening</Link>)</label>
    </fieldset>
    {note ? <p role="status" className={css.note}>{note}</p> : null}
  </section>;
}

export function AgentChannels({ agentId, agentName }: { agentId: string; agentName: string }) {
  return <div aria-label={`Reach ${agentName}`} data-testid="agent-channels">
    <CompanyChannels />
    <TelegramLink agentId={agentId} agentName={agentName} />
    <WhatsAppLink agentId={agentId} agentName={agentName} />
    <section className={css.card} aria-label={`Listening with ${agentName}`}>
      <div className={css.head}>
        <span className={css.icon} style={{ background: "var(--theme-danger, #c53030)" }} aria-hidden="true"><Mic size={18} /></span>
        <div className={css.text}><b>Let {agentName} listen</b>
          <small>Turn on listening during a call or meeting: {agentName} follows the live transcript and acts on it, for example drafting a quotation or creating a task. Everyone must be told first.</small></div>
      </div>
      <div className={css.actions}><Link className={css.primary} href={`/listen?agent=${agentId}`}><Mic size={14} aria-hidden="true" />Start listening</Link></div>
    </section>
  </div>;
}
