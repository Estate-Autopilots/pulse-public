"use client";
// PULSE-NETWORK (EST-1027): the Network panel's live parts. Everything goes through this Pulse's own API
// (/api/v0/network/...), which acts for the signed-in leader with the company's connector key.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpRight, Send } from "lucide-react";
import { AiBadge } from "../kit/ai-badge";
import { styles } from "../ui";
import css from "./network.module.css";

type Meta = { lane?: string; tokens?: number; seconds?: number; model?: string };
type Msg = { num: number; body: string; handle: string; display_name: string; author_kind: string; org_short: string; created_at: string; meta?: Meta };
type Typing = { display_name: string; kind: string; label: string };
type Member = { handle: string; name: string; kind: string; org: string; title: string };
type Reply = { num: number; parent: number | null; body: string | null; deleted: boolean; handle: string; display_name: string; author_kind: string; org_name: string; accepted: boolean; created_at: string; meta?: Meta };

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const r = await fetch(`/api/v0/network/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch { return { ok: false, data: { error: "Pulse is reconnecting. Try again." } }; }
}
const errorOf = (data: Record<string, unknown>) => typeof data.error === "string" ? data.error : "That did not go through. Try again.";
const meter = (m?: Meta) => [m?.lane ? `${m.lane} lane` : "", m?.tokens ? `${m.tokens.toLocaleString("en-IN")} tokens` : "", m?.lane && m?.seconds !== undefined ? `${Math.round(m.seconds)} s` : ""].filter(Boolean).join(" · ");
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** "Pulse CEO is thinking…": who is writing or answering right now. */
function TypingLine({ typing }: { typing: Typing[] }) {
  return <div className={css.typing} aria-live="polite">{typing.map((t) => <span key={t.display_name} data-agent={t.kind === "agent" ? "" : undefined}><i /><i /><i />{t.display_name} {t.label}…</span>)}</div>;
}

/** Members to pick from, AI agents first, each with their company. */
function MemberOptions({ members }: { members: Member[] }) {
  const agents = members.filter((m) => m.kind === "agent"), people = members.filter((m) => m.kind !== "agent");
  return <>{agents.length ? <optgroup label="AI agents">{agents.map((m) => <option key={m.handle} value={m.handle}>{m.name} · {m.org}</option>)}</optgroup> : null}
    {people.length ? <optgroup label="People">{people.map((m) => <option key={m.handle} value={m.handle}>{m.name} · {m.org}{m.title ? `, ${m.title}` : ""}</option>)}</optgroup> : null}</>;
}

/** Post to the shared feed: a question or a lesson; the first sentence becomes the title when none is given. */
export function Composer() {
  const router = useRouter();
  const [body, setBody] = useState(""), [topic, setTopic] = useState("general"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true); setError("");
    const r = await post("posts", { body, topic });
    setBusy(false);
    if (!r.ok) { setError(errorOf(r.data)); return; }
    setBody(""); router.refresh();
  }
  return (
    <form className={css.composer} onSubmit={submit}>
      <label className={styles.field}><span className={css.sr}>Post to the network</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={40000} rows={2} placeholder="Ask the other companies something, or share what worked for you…" /></label>
      <div className={css.row}>
        <label className={css.inline}><span className={css.sr}>Topic</span><select className={styles.input} value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="general">General</option><option value="capacity">Capacity</option><option value="releases">Releases</option><option value="hiring">Hiring</option></select></label>
        <span className={styles.muted}>Every company on the network sees it.</span>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !body.trim()}>{busy ? "Posting…" : "Post"}</button>
      </div>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </form>
  );
}

/** A feed thread read and answered inside Pulse: replies nest one level per answer, new ones appear by themselves. */
export function Thread({ num, me, post: p, initial, typing: firstTyping, openHref }: { num: number; me: string; post: { title: string; body: string; display_name: string; author_kind: string; org_name: string; created_at: string; topic: string; signed: boolean; meta?: Meta }; initial: Reply[]; typing: Typing[]; openHref: string }) {
  const [replies, setReplies] = useState(initial), [typing, setTyping] = useState(firstTyping), [body, setBody] = useState(""), [parent, setParent] = useState<Reply | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/api/v0/network/threads/${num}`, { cache: "no-store" });
        if (r.ok) { const d = await r.json() as { replies: Reply[]; typing?: Typing[] }; setReplies(d.replies); setTyping(d.typing ?? []); }
      } catch { /* next tick */ }
    }, 2500);
    return () => clearInterval(id);
  }, [num]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true); setError("");
    const r = await post(`threads/${num}/replies`, { body, parent: parent?.num });
    setBusy(false);
    if (!r.ok) { setError(errorOf(r.data)); return; }
    setBody(""); setParent(null);
  }
  const depth = (r: Reply): number => { let d = 0, cur: Reply | undefined = r; while (cur?.parent && d < 4) { cur = replies.find((x) => x.num === cur!.parent); d++; } return d; };
  const ordered: Reply[] = [];
  const walk = (parentNum: number | null) => replies.filter((r) => r.parent === parentNum).forEach((r) => { ordered.push(r); walk(r.num); });
  walk(null);
  return (
    <div className={css.threadView}>
      <article className={css.post}>
        <div className={css.postMain}>
          <div className={css.who}><b>{p.display_name}</b>{p.author_kind === "agent" ? <AiBadge /> : null}<span className={styles.muted}>{p.org_name}</span>{p.signed ? <span className={css.signed}>✓ signed</span> : null}</div>
          <h2 className={css.threadTitle}>{p.title}</h2>
          {p.body ? <p className={css.full}>{p.body}</p> : null}
          <div className={css.foot}><span className={css.tag}>{p.topic}</span>{meter(p.meta) ? <span className={styles.muted}>{meter(p.meta)}</span> : null}<a href={openHref}>Open on the network<ArrowUpRight size={12} aria-hidden="true" /></a></div>
        </div>
      </article>
      <div className={css.replies}>
        {ordered.length ? ordered.map((r) => (
          <div key={r.num} className={css.reply} style={{ marginLeft: depth(r) * 20 }} data-accepted={r.accepted ? "" : undefined}>
            <div className={css.who}><b>{r.display_name}</b>{r.author_kind === "agent" ? <AiBadge /> : null}<span className={styles.muted}>{r.org_name} · {time(r.created_at)}</span>{r.accepted ? <span className={css.solved}>answer</span> : null}</div>
            <p className={css.full}>{r.deleted ? "Removed by its author." : r.body}</p>
            <div className={css.foot}>{meter(r.meta) ? <span className={styles.muted}>{meter(r.meta)}</span> : null}{r.deleted || r.handle === me ? null : <button type="button" className={css.link} onClick={() => setParent(r)}>Reply</button>}</div>
          </div>)) : <p className={styles.muted}>No replies yet. Mention an AI agent with @ and it answers in seconds.</p>}
        <TypingLine typing={typing} />
      </div>
      <form className={css.composer} onSubmit={send}>
        {parent ? <p className={styles.muted}>Replying to {parent.display_name} · <button type="button" className={css.link} onClick={() => setParent(null)}>reply to the post instead</button></p> : null}
        <label className={styles.field}><span className={css.sr}>Your reply</span><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={40000} placeholder="Add a reply. @mention a person or an AI agent to bring them in." /></label>
        <div className={css.row}><span /><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !body.trim()}>{busy ? "Sending…" : "Reply"}</button></div>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
      </form>
    </div>
  );
}

/** A live conversation: new messages every 2 seconds, Enter sends; an agent's reply shows what it cost. */
export function Conversation({ slug, me, title, agent, initial, typing: firstTyping }: { slug: string; me: string; title: string; agent: boolean; initial: Msg[]; typing: Typing[] }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial), [typing, setTyping] = useState(firstTyping), [body, setBody] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null), last = useRef(initial.length ? initial[initial.length - 1].num : 0);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [msgs.length, typing.length]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/v0/network/conversations/${slug}?after=${last.current}`, { cache: "no-store" });
        if (r.ok && !stop) {
          const d = await r.json() as { messages: Msg[]; typing?: Typing[] };
          setTyping(d.typing ?? []);
          if (d.messages.length) { last.current = d.messages[d.messages.length - 1].num; setMsgs((m) => [...m, ...d.messages.filter((x) => !m.some((y) => y.num === x.num))]); }
        }
      } catch { /* next tick */ }
    };
    const id = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(id); };
  }, [slug]);
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true); setError("");
    const r = await post(`conversations/${slug}`, { body });
    setBusy(false);
    if (!r.ok) { setError(errorOf(r.data)); return; }
    setBody("");
  }
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } };
  return (
    <div className={css.convoView}>
      <header className={css.convoHead}><b>{title}</b>{agent ? <><AiBadge /><small className={styles.muted}>answers in seconds; real work becomes a hand-off</small></> : null}</header>
      <div className={css.msgs} ref={box} aria-live="polite">
        {msgs.length ? msgs.map((m) => (
          <div key={m.num} className={css.msg} data-mine={m.handle === me ? "" : undefined} data-agent={m.author_kind === "agent" ? "" : undefined}>
            {m.handle === me ? null : <div className={css.msgHead}><b>{m.display_name}</b>{m.author_kind === "agent" ? <AiBadge /> : null}<span>{m.org_short}</span></div>}
            <p>{m.body}</p>
            <div className={css.msgFoot}>{meter(m.meta) ? <span>{meter(m.meta)}</span> : null}<time dateTime={m.created_at}>{time(m.created_at)}</time></div>
          </div>)) : <p className={styles.muted}>No messages yet. Say hello.</p>}
        <TypingLine typing={typing} />
      </div>
      <form className={css.send} onSubmit={send}>
        <label className={css.grow}><span className={css.sr}>Message</span><textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={keys} rows={1} maxLength={20000} placeholder="Message · Enter sends" /></label>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !body.trim()} aria-label="Send"><Send size={15} aria-hidden="true" /></button>
      </form>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div>
  );
}

/** Start a direct message with anyone on the network, person or AI agent. */
export function NewMessage({ members, preset }: { members: Member[]; preset: string }) {
  const router = useRouter();
  const [to, setTo] = useState(preset || members[0]?.handle || ""), [body, setBody] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!to || !body.trim() || busy) return;
    setBusy(true); setError("");
    const r = await post(`dm/${encodeURIComponent(to)}`, { body });
    setBusy(false);
    if (!r.ok) { setError(errorOf(r.data)); return; }
    router.push(`/network?tab=messages&c=${String(r.data.channel ?? "")}`);
  }
  return (
    <form className={css.newMsg} onSubmit={submit}>
      <label className={styles.field}>New message to
        <select className={styles.input} value={to} onChange={(e) => setTo(e.target.value)}><MemberOptions members={members} /></select></label>
      <label className={styles.field}><span className={css.sr}>Message</span><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={20000} placeholder="Ask anything; an AI agent answers in seconds" autoFocus={!!preset} /></label>
      <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !body.trim() || !to}>{busy ? "Sending…" : "Send"}</button>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </form>
  );
}

/** Ask a person or an AI agent, in this company or another, to do something. */
export function AskHandoff({ members }: { members: Member[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [to, setTo] = useState(members[0]?.handle ?? ""), [title, setTitle] = useState(""), [details, setDetails] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!to || title.trim().length < 3 || busy) return;
    setBusy(true); setError("");
    const r = await post("handoffs", { to, title, details });
    setBusy(false);
    if (!r.ok) { setError(errorOf(r.data)); return; }
    setTitle(""); setDetails(""); setOpen(false); router.refresh();
  }
  if (!open) return <div><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}>Ask someone to do something</button></div>;
  return (
    <form className={css.composer} onSubmit={submit}>
      <label className={styles.field}>Who<select className={styles.input} value={to} onChange={(e) => setTo(e.target.value)}><MemberOptions members={members} /></select></label>
      <label className={styles.field}>What<input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Find out why the backup did not run" /></label>
      <label className={styles.field}>Details<textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} maxLength={20000} placeholder="Anything they need to know" /></label>
      <div className={css.row}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><span /><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || title.trim().length < 3}>{busy ? "Sending…" : "Send hand-off"}</button></div>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </form>
  );
}

/** Accept / decline (asked of me), mark done with its result (mine, in progress) or cancel (I asked). */
export function HandoffButtons({ num, mine, asker, status }: { num: number; mine: boolean; asker: boolean; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [finishing, setFinishing] = useState(false), [result, setResult] = useState("");
  async function move(next: string) {
    if (next === "done" && !result.trim()) { setError("Say what came out of it."); return; }
    setBusy(next); setError("");
    const r = await post(`handoffs/${num}`, { status: next, result: next === "done" ? result : "" });
    setBusy("");
    if (!r.ok) { setError(errorOf(r.data)); return; }
    setFinishing(false); router.refresh();
  }
  if (finishing) return (
    <span className={css.finish}>
      <input className={styles.input} value={result} onChange={(e) => setResult(e.target.value)} maxLength={20000} placeholder="What came out of it, in a sentence or two" aria-label="Result" autoFocus />
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void move("done")}>{busy ? "…" : "Done"}</button>
      <button type="button" className={styles.btn} onClick={() => setFinishing(false)}>Cancel</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </span>);
  const buttons: [string, string][] = [];
  if (mine && status === "asked") buttons.push(["accepted", "Accept"], ["declined", "Decline"]);
  if (asker && (status === "asked" || status === "accepted")) buttons.push(["cancelled", "Cancel"]);
  return <>{mine && status === "accepted" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setFinishing(true)}>Mark done</button> : null}
    {buttons.map(([s, label]) => <button key={s} type="button" className={`${styles.btn}${s === "accepted" ? ` ${styles.btnPrimary}` : ""}`} disabled={!!busy} onClick={() => void move(s)}>{busy === s ? "…" : label}</button>)}
    {error ? <span className={css.error} role="alert">{error}</span> : null}</>;
}

