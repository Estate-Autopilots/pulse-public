"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Send } from "lucide-react";
import { styles } from "../ui";
import css from "./overview.module.css";

/** KAZUK (28 Oct 2026), Kazuk's "Ask your agent" / "Ask Pulse CEO": the question goes to the company's AI employee in
 *  the asker's own chat with it (as an @mention, exactly as in Chats), and its answer shows here as it arrives. The chat
 *  keeps both, so nothing is lost if the page closes. */
type Agent = { id: string; name: string; username: string | null };
type Msg = { id: string; authorId: string; body: string; createdAt: string };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? "That did not go through. Try again.");
  return data as T;
}

export function AskAgent({ agent, placeholder, context }: { agent: Agent | null; placeholder: string; context: string }) {
  const [q, setQ] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [answer, setAnswer] = useState<string | null>(null), [chat, setChat] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  if (!agent) return <p className={css.empty}>No AI employee is set up yet. Leadership adds one in Settings → AI employees.</p>;
  async function ask(e: FormEvent) {
    e.preventDefault(); const text = q.trim(); if (!text || busy) return;
    setBusy(true); setError(""); setAnswer(null);
    try {
      const { id } = await call<{ id: string }>("chats/direct", { personId: agent!.id }); setChat(id);
      const sent = await call<{ id: string; message?: Msg }>(`chats/${id}/messages`, { body: `${agent!.username ? `@${agent!.username} ` : ""}${text}\n\n(${context})`, clientId: crypto.randomUUID() });
      const after = sent.message?.createdAt ?? new Date().toISOString();
      let tries = 0;
      timer.current = setInterval(async () => {
        tries++;
        try {
          const r = await call<{ messages: Msg[] }>(`chats/${id}/messages`);
          const reply = r.messages.filter((m) => m.authorId === agent!.id && m.createdAt > after).at(-1);
          if (reply) { setAnswer(reply.body); setBusy(false); clearInterval(timer.current!); setQ(""); }
        } catch { /* keep waiting */ }
        if (tries > 30) { clearInterval(timer.current!); setBusy(false); setAnswer(null); setError(`${agent!.name.split(" ")[0]} is still working on it. The answer will be in your chat.`); }
      }, 4000);
    } catch (err) { setError(err instanceof Error ? err.message : "That did not go through."); setBusy(false); }
  }
  return <div className={css.ask}>
    <form onSubmit={ask} className={css.askForm}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={`Ask ${agent.name}`} maxLength={600} disabled={busy} />
      <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !q.trim()} aria-label="Ask"><Send size={13} aria-hidden="true" /></button>
    </form>
    {busy ? <p className={css.empty}><Bot size={13} aria-hidden="true" /> {agent.name.split(" ")[0]} is answering…</p> : null}
    {answer ? <div className={css.answer}><b><Bot size={13} aria-hidden="true" /> {agent.name.split(" ")[0]}</b><p>{answer}</p></div> : null}
    {error ? <p className={css.empty} role="status">{error}</p> : null}
    {chat ? <p className={css.empty}><Link href={`/chats?channel=${chat}`}>Open the chat with {agent.name.split(" ")[0]}</Link></p> : null}
  </div>;
}
