"use client";
// ONBOARD-CHECKIN-TG (owner, 6 Nov 2026: new companies signing up by themselves): the first-run list on My day for the
// person who runs a company's Vitals (admins). Each step opens the one place it is done and ticks itself off from what
// Vitals can see (an AI subscription connected, a server online, an AI employee made, notifications on, Telegram
// linked); a step Vitals can't see ticks once opened. Put away at any time; it goes by itself when everything is done.
// "Connect Claude Max or Codex" opens Settings → AI (CONNECT-AI's sign-in, finished by RUNNERS-FULL's Connect
// Claude/Codex on a server); "Connect a server" opens Settings → Servers & AI (SERVERS-AI's pairing code).
import Link from "next/link";
import { Bell, Bot, Check, Plug, Send, Server, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { current } from "../notify-status";
import { useWords } from "../org-code";
import { lower } from "../lib/words.mjs";
import css from "./first-run.module.css";

type Seen = { hidden?: boolean; opened?: string[] };
type Facts = { ai: boolean; server: boolean; agent: boolean; notify: boolean; telegram: boolean; telegramReady: boolean };
const key = (person: string) => `vitals.firstrun.${person}`;
const read = (person: string): Seen => { try { return JSON.parse(localStorage.getItem(key(person)) ?? "{}") as Seen; } catch { return {}; } };
async function json<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; }
}

/** What Vitals can see for each step (any it can't read counts as not done yet). */
async function facts(): Promise<Facts> {
  const [ai, servers, agents, tg, n] = await Promise.all([
    json<{ connections?: { state: string }[] }>("ai"), json<{ runners?: { state?: string; online?: boolean }[] }>("admin/runners"),
    json<{ agents?: unknown[] }>("agents"), json<{ bot: string | null; linked: boolean }>("telegram/link"), current().catch(() => null),
  ]);
  return { ai: !!ai?.connections?.some((c) => c.state === "connected"), server: !!servers?.runners?.length, agent: !!agents?.agents?.length,
    notify: n?.state === "on", telegram: !!tg?.linked, telegramReady: !!tg?.bot };
}

export function FirstRun({ person, company }: { person: string; company: string }) {
  const words = useWords();
  const [seen, setSeen] = useState<Seen | null>(null), [f, setF] = useState<Facts | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSeen(read(person)), 0);
    void facts().then(setF);
    const again = () => { if (document.visibilityState === "visible") void facts().then(setF); };
    document.addEventListener("visibilitychange", again);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", again); };
  }, [person]);
  if (!seen || !f || seen.hidden) return null;
  const store = (next: Seen) => { try { localStorage.setItem(key(person), JSON.stringify(next)); } catch { /* private mode */ } setSeen(next); };
  const opened = (k: string) => seen.opened?.includes(k);
  const steps = [
    { k: "team", Icon: UserPlus, title: `Invite your ${lower(words.team)}`, text: "Add people by name; each gets a private link to join.", href: "/people?add=member", done: opened("team") },
    { k: "ai", Icon: Plug, title: "Connect Claude Max or Codex", text: "Use the subscription you already pay for. Two steps, no API key needed.", href: "/settings?tab=ai", done: f.ai },
    { k: "server", Icon: Server, title: "Connect a server (optional)", text: "Your own Linux server runs your AI employees. One line to paste.", href: "/settings?tab=servers", done: f.server || opened("server") },
    { k: "agent", Icon: Bot, title: "Create your first AI employee", text: "Give it a name and a manager; it takes tasks and answers in chat.", href: "/people?add=ai", done: f.agent },
    { k: "notify", Icon: Bell, title: "Turn on notifications", text: "Calls, approvals and tasks due reach you with Vitals closed.", href: "/settings?tab=notifications", done: f.notify },
    ...(f.telegramReady ? [{ k: "telegram", Icon: Send, title: "Link Telegram (optional)", text: "A short digest with buttons, instead of a stream.", href: "/settings?tab=notifications#telegram", done: f.telegram || opened("telegram") }] : []),
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done);
  return (
    <section className={css.card} aria-label="Set up your company">
      <div className={css.head}>
        <div className={css.title}>
          <b>Set up {company || "your company"}</b>
          <small>{done} of {steps.length} done{next ? ` · next: ${next.title.replace(/ \(optional\)$/, "").toLowerCase()}` : ""}</small>
        </div>
        <button type="button" className={css.close} aria-label="Put the set-up list away" title="Put away" onClick={() => store({ ...seen, hidden: true })}><X size={16} aria-hidden="true" /></button>
      </div>
      <div className={css.bar} role="progressbar" aria-label="Set-up progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className={css.steps}>
        {steps.map(({ k, Icon, title, text, href, done: ok }) => <li key={k} data-done={ok ? "" : undefined} data-next={next?.k === k ? "" : undefined}>
          <Link href={href} className={css.step} onClick={() => store({ ...seen, opened: [...new Set([...(seen.opened ?? []), k])] })}>
            <span className={css.icon} aria-hidden="true">{ok ? <Check size={16} /> : <Icon size={16} />}</span>
            <span className={css.text}><b>{title}</b><small>{text}</small></span>
            <span className={css.go} aria-hidden="true">{ok ? "Done" : "Start"}</span>
          </Link>
        </li>)}
      </ol>
    </section>
  );
}
