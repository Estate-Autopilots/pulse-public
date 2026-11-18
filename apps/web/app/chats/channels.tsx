"use client";
// Telegram and WhatsApp Business in the same list design. Neither carries chats yet: each pane says plainly what state
// it is in and what the owner has to do. Decision notifications keep their own separate Telegram connection.
import { ArrowLeft, CircleDashed, Send, ShieldCheck, Smartphone } from "lucide-react";
import type { Connections } from "./types";
import css from "./chats.module.css";

const STEPS = {
  telegram: [
    "Create the company bot with @BotFather and choose who may write to it; each person starts the bot from their own Telegram.",
    "Put the bot token and a webhook secret in the Pulse secret store, and point the bot’s webhook at Pulse.",
    "Link each verified Telegram account to the right person in Pulse; confirm how long messages are kept and who can read each chat.",
    "Turn on the Telegram chat adapter (PULSE_TELEGRAM_CHAT_ENABLED) in a sandbox, send test messages, then roll out.",
  ],
  whatsapp: [
    "Choose the company’s WhatsApp Business number and register it in Meta Business Manager (or with an approved Business Solution Provider).",
    "Complete Meta business verification and display-name approval; get message templates approved for anything Pulse starts.",
    "Create the WhatsApp Cloud API app; put its access token and app secret in the Pulse secret store and register the signed webhook.",
    "Record customer consent, map numbers to people and clients, then turn on the adapter (PULSE_WHATSAPP_CHAT_ENABLED) in a sandbox first.",
  ],
};

export function ChannelSetup({ kind, connections, onBack }: { kind: "telegram" | "whatsapp"; connections?: Connections; onBack: () => void }) {
  const c = connections?.[kind];
  const state = c?.connected ? "Connected" : kind === "whatsapp" ? "Pending approval" : c?.enabled ? "Switched on, account setup pending" : "Not set up yet";
  return <div className={css.chat}>
    <header className={css.head}>
      <button type="button" className={`${css.iconBtn} ${css.back}`} onClick={onBack} aria-label="Back to chats"><ArrowLeft size={20} aria-hidden="true" /></button>
      <span className={css.who}><span className={css.channelIcon} data-channel={kind} aria-hidden="true">{kind === "telegram" ? <Send size={20} /> : <Smartphone size={20} />}</span>
        <span><b>{kind === "telegram" ? "Telegram" : "WhatsApp Business"}</b><small>{state}</small></span></span>
    </header>
    <div className={css.setup}>
      <span className={css.setupState} data-state={c?.connected ? "on" : "pending"}><CircleDashed size={16} aria-hidden="true" />{state}</span>
      <h3>{kind === "telegram" ? "Telegram chats will appear here, in this list" : "WhatsApp Business chats will appear here, in this list"}</h3>
      <p>{kind === "telegram" ? "Once the company bot is connected, each Telegram conversation shows as a row labelled Telegram, with the same bubbles, ticks and search as team chats."
        : "Once Meta approves the business number, client conversations show as rows labelled WhatsApp Business, read and answered from Pulse."} Nothing is sent from Pulse until then.</p>
      <h4>What the owner does</h4>
      <ol>{STEPS[kind].map((s) => <li key={s}>{s}</li>)}</ol>
      <p className={css.setupNote}><ShieldCheck size={15} aria-hidden="true" />Decision notifications already reach people on Telegram through a separate connection. Chat messages are never sent to the owner’s notification chat.</p>
    </div>
  </div>;
}
