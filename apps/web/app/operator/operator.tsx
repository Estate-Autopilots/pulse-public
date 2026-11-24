"use client";
// AGENT-OPERATOR (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 P4.2 / T4.2.1: "on chat you open a chat on the side, browser
// it's doing ... opening the Pulse itself, internal apps etc. and doing the work ... going back and forth, reporting
// problems that arise"). Concept 1 of reports/agent-operator/concepts: the page the AI employee works in fills the left,
// with a strip of its steps (ticked, crossed with the problem it reported, or waiting for the person's yes) and Stop
// above it; the chat with it is the column on the right. Every screen action of that AI employee happens inside this
// framed page (agent-ui/operator-frame.ts): it opens pages here, reads, clicks, fills, uploads and downloads here, while
// the person keeps talking to it. A click that sends, pays, deletes or approves is asked over this page first (only they
// say yes). On a phone: two tabs, Page (live) and Chat; the page comes to the front whenever the AI takes a step, so the
// person sees it happen. Pulse's own checks apply to every click: it acts in the person's own sign-in.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ArrowLeft, Bug, Check, Hand, History, Hourglass, LoaderCircle, Maximize2, MessageCircle, Mic, MicOff, MonitorPlay, MousePointerClick, Play, RotateCw, SendHorizontal, ShieldCheck, Sparkles, Square, TriangleAlert } from "lucide-react";
import { bindOperatorFrame, clearSteps, setOperatorStopped, setOperatorThinking, useOperatorStopped, useOperatorThinking, useSteps, type Step } from "../agent-ui/operator-frame";
import type { Scope } from "../agent-ui/screen-map";
import { GuideBar } from "../agent-ui/guide-bar";
import { currentGuide, endGuide, useDoing, useGuide, type Doing } from "../agent-ui/guide";
import { DockMessages } from "../chats/dock-messages";
import { embedPath, panelTarget, stripEmbed } from "../lib/panel-target.mjs";
import { EmptyState } from "../kit/game";
import { Segmented } from "../kit";
import { Fit } from "../ui";
import { LANGS, useVoiceLayer, voiceSupported, type Lang } from "./voice";
import type { Channel, ChatMessage } from "../chats/types";
import dock from "../chats/dock.module.css";
import css from "./operator.module.css";

const CHAT_W = 400;
const PHONE = "(max-width: 899.98px)";
const first = (n: string) => n.split(" ")[0] || n;
const read = async <T,>(path: string): Promise<T | null> => { try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; } };
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const onPhoneChange = (done: () => void) => { const m = window.matchMedia(PHONE); m.addEventListener("change", done); return () => m.removeEventListener("change", done); };

/** A step's words without the curly quotes (they wrap badly on a phone). */
const plain = (t: string) => t.replace(/[“”]/g, "");
/** What the AI employee is doing now, in a few words (the strip's title and line, the chat's waiting line). */
function stateOf(steps: readonly Step[], stopped: boolean, name: string, thinking = false, doing: Doing | null = null) {
  const latest = steps.at(-1), done = steps.filter((x) => x.state === "done").length;
  // DOCS-EDITOR-10: "Do it for me" was pressed on a walkthrough, and the AI employee has not taken its first step yet.
  if (doing && !stopped && doing.where === "operator" && (!latest || latest.key < doing.at)) return { key: "working", title: `${name} is ${doing.what} for you`, short: `${name} is ${doing.what}`,
    line: "Watch this page. It asks before anything that sends, pays or deletes.", shortLine: "Watch this page", chat: `Waiting for ${name}’s answer…` };
  if (stopped) return { key: "stopped", title: `${name} is paused`, short: `${name} is paused`, line: "Press Keep going when ready", shortLine: "Tap Keep going", chat: `${name} is paused. Press Keep going to let it finish.` };
  if (latest?.state === "asked") return { key: "asked", title: `${name} needs your OK`, short: `${name} needs your OK`, line: "Answer the card on the page", shortLine: "Answer the card on the page", chat: `${name} needs your OK: answer the card on the page.` };
  if (latest?.state === "failed") return { key: "stuck", title: `${name} hit a problem`, short: `${name} hit a problem`, line: `${name} is trying another way. No need to act.`, shortLine: `${name} is trying another way`,
    chat: `${name} hit a problem and is trying another way.` };
  if (latest) return { key: "working", title: `${name} is working here`, short: `${name} is working`, line: `${done} step${done === 1 ? "" : "s"} done so far`, shortLine: `${done} done`, chat: `Waiting for ${name}’s answer…` };
  if (thinking) return { key: "thinking", title: `${name} is thinking…`, short: `${name} is thinking…`, line: "It reads your message, then works on this page.", shortLine: "Reading your message", chat: `Waiting for ${name}’s answer…` };
  return { key: "idle", title: `${name} is ready`, short: `${name} is ready`, line: "Ask in the chat. It opens pages and does the work here.", shortLine: "Works on this page", chat: `Waiting for ${name}’s answer…` };
}

export function OperatorApp({ chats, viewer, first: wanted, start }: { chats: Channel[]; viewer: string; first: string | null; start: string }) {
  const [chanId, setChanId] = useState(() => chats.find((c) => c.id === wanted)?.id ?? chats[0]?.id ?? null);
  const chan = chats.find((c) => c.id === chanId) ?? null;
  const phone = useSyncExternalStore(onPhoneChange, () => window.matchMedia(PHONE).matches, () => false);
  const [tab, setTab] = useState<"page" | "chat">("chat");
  // On a phone the page comes to the front whenever the AI takes a step (it acts where the person can see it).
  const steps = useSteps(), lastKey = steps.at(-1)?.key;
  useEffect(() => { if (lastKey !== undefined) queueMicrotask(() => setTab("page")); }, [lastKey]);
  if (!chan) return <div className={css.none}><EmptyState art="nothing" title="No AI employee to watch yet"
    text="Start a chat with one of your AI employees, then come back to watch it work on the page beside the chat." action={{ label: "Open Chats", href: "/chats" }} /></div>;
  return <Fit><div className={css.wrap} style={{ "--operator-chat-w": `${CHAT_W}px` } as CSSProperties} data-operator-view="" data-tab={phone ? tab : undefined}>
    {phone ? <Segmented<"page" | "chat"> className={css.tabs} fill value={tab} onChange={setTab} label="Show"
      options={[{ value: "page", label: "Page", icon: MonitorPlay }, { value: "chat", label: `Chat with ${first(chan.name)}`, icon: MessageCircle }]} /> : null}
    <Stage start={start} agent={chan.name} reveal={() => setTab("page")} toChat={() => { setTab("chat"); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-operator-view] textarea")?.focus(), 60); }} />
    <ChatColumn key={chan.id} chan={chan} viewer={viewer} chats={chats} pick={setChanId} />
  </div></Fit>;
}

/** The page the AI employee works in, its steps and Stop. */
function Stage({ start, agent, reveal, toChat }: { start: string; agent: string; reveal: () => void; toChat: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => panelTarget(start)?.src ?? embedPath("/me"));
  const [here, setHere] = useState({ path: start, title: "" });
  const [loading, setLoading] = useState(true);
  const loads = useRef(0);
  const steps = useSteps(), stopped = useOperatorStopped();

  const scope = useCallback((): Scope | null => {
    try {
      const w = frame.current?.contentWindow, doc = frame.current?.contentDocument;
      if (!w || !doc?.body || w.location.href === "about:blank" || doc.readyState === "loading") return null;
      return { doc, win: w as Window & typeof globalThis };
    } catch { return null; }
  }, []);
  // The framed page has drawn its content (a skeleton is not content).
  const settle = useCallback(async () => {
    for (let i = 0; i < 40; i++) {
      const sc = scope();
      if (sc && !sc.doc.querySelector("[aria-busy=true]") && (sc.doc.querySelector("main")?.textContent?.trim().length ?? 0) > 20) return;
      await wait(150);
    }
  }, [scope]);
  const go = useCallback(async (path: string) => {
    const t = panelTarget(path, window.location.origin);
    const w = frame.current?.contentWindow;
    if (!t || t.kind !== "page" || !w) return false;
    const before = loads.current;
    setLoading(true);
    try { w.location.assign(t.src); } catch { if (frame.current) frame.current.src = t.src; }
    for (let i = 0; i < 80 && loads.current === before; i++) await wait(150);
    if (loads.current === before) return false;
    await settle();
    return true;
  }, [settle]);
  const show = useRef(reveal);
  useEffect(() => { show.current = reveal; });
  // The frame may finish loading before this page listens for it: then it counts as loaded now.
  useEffect(() => { try { if (frame.current?.contentDocument?.readyState === "complete" && frame.current.contentWindow?.location.href !== "about:blank") { loads.current += 1; queueMicrotask(() => setLoading(false)); } } catch { /* not readable */ } }, []);
  useEffect(() => { clearSteps(); const unbind = bindOperatorFrame({ scope, go, settle, reveal: () => show.current() });
    // DOCS-EDITOR-8: a walkthrough playing on this page ends with it.
    return () => { unbind(); if (currentGuide()?.where === "operator") endGuide(); }; }, [scope, go, settle]);
  // The layout's numbers for the prompt tray (it sits at the top centre of this page).
  useEffect(() => {
    const root = document.documentElement, box = frame.current?.parentElement;
    const place = () => { const r = box?.getBoundingClientRect(); if (!r) return; root.style.setProperty("--operator-left", `${Math.round(r.left)}px`); root.style.setProperty("--operator-top", `${Math.round(r.top)}px`); root.style.setProperty("--operator-chat-w", `${Math.round(window.innerWidth - r.right)}px`); };
    place(); window.addEventListener("resize", place);
    // The strip grows a row once there are steps: the frame moves down, and the prompts with it.
    const watch = new ResizeObserver(place); const stage = box?.parentElement; if (stage) watch.observe(stage); stage?.querySelectorAll("header").forEach((h) => watch.observe(h));
    return () => { watch.disconnect(); window.removeEventListener("resize", place); ["--operator-left", "--operator-top", "--operator-chat-w"].forEach((k) => root.style.removeProperty(k)); };
  }, []);
  // Where the framed page is now (a link clicked inside it moves it too).
  const follow = useCallback(() => {
    const sc = scope(); if (!sc) return;
    const title = (sc.doc.querySelector("[data-page-header] h2, main h1, main h2")?.textContent ?? "").trim();
    setHere({ path: stripEmbed(`${sc.win.location.pathname}${sc.win.location.search}`), title: /[\p{L}\p{N}]/u.test(title) ? title.slice(0, 60) : "" });
  }, [scope]);
  useEffect(() => { const t = window.setInterval(follow, 1500); return () => window.clearInterval(t); }, [follow]);

  const thinking = useOperatorThinking(), guide = useGuide(), doing = useDoing();
  const name = first(agent), now = stateOf(steps, stopped, name, thinking, doing);
  const done = steps.filter((x) => x.state === "done").length, earlier = steps.slice(-7, -1);
  // While it starts on "Do it for me", the earlier steps (the walkthrough it showed) are not news: the strip is one line.
  const latest = doing && doing.where === "operator" && !stopped && (steps.at(-1)?.key ?? 0) < doing.at ? undefined : steps.at(-1);
  // DOCS-EDITOR-8: while it shows how to do something, the guide bar takes the strip's place (a sheet over the page on a phone).
  const guiding = guide?.where === "operator";
  return <section className={css.stage} aria-label={`The page ${name} works in`} data-guiding={guiding || undefined}>
    {guiding ? <GuideBar where="operator" /> : null}
    <header className={css.strip} data-operator-strip="" data-state={now.key}>
      <span className={css.mark} data-state={now.key} aria-hidden="true">{now.key === "working" || now.key === "thinking" ? <LoaderCircle size={18} /> : now.key === "stuck" ? <TriangleAlert size={17} />
        : now.key === "asked" ? <Hourglass size={17} /> : now.key === "stopped" ? <Hand size={17} /> : <Sparkles size={18} />}</span>
      <div className={css.stripText}><strong><span className={css.long}>{now.title}</span><span className={css.short}>{now.short}</span></strong>
        <small><span className={css.long}>{now.line}</span><span className={css.short}>{now.shortLine}</span></small></div>
      {stopped ? <button type="button" className={css.go} onClick={() => setOperatorStopped(false)}><Play size={14} aria-hidden="true" />Keep going</button>
        : steps.length ? <button type="button" className={css.stop} onClick={() => setOperatorStopped(true)} title={`${name} does no more steps on this page until you press Keep going`}><Square size={13} aria-hidden="true" />Stop</button>
        : now.key === "thinking" ? null : <button type="button" className={css.askBtn} onClick={toChat}><MessageCircle size={14} aria-hidden="true" /><span className={css.long}>Ask {name}</span><span className={css.short}>Ask in chat</span></button>}
      {latest ? <ol className={css.steps} aria-label={`Its last steps: ${done} done`}>
        <li className={css.stepsLabel} aria-hidden="true">{done} done</li>
        {earlier.map((x) => <li key={x.key} className={css.dot} data-state={x.state} title={x.text}>{x.state === "done" ? <Check size={11} strokeWidth={3} aria-label={x.text} /> : x.state === "failed" ? <TriangleAlert size={11} aria-label={x.text} /> : <Hourglass size={11} aria-label={x.text} />}</li>)}
        <StepChip s={latest} quiet={stopped} />
      </ol> : null}
    </header>
    <div className={css.bar}>
      <button type="button" className={css.icon} onClick={() => { try { frame.current?.contentWindow?.history.back(); } catch { /* none */ } }} aria-label="Back" title="Back"><ArrowLeft size={15} aria-hidden="true" /></button>
      <button type="button" className={css.icon} onClick={() => { setLoading(true); try { frame.current?.contentWindow?.location.reload(); } catch { /* none */ } }} aria-label="Reload" title="Reload"><RotateCw size={14} aria-hidden="true" /></button>
      <span className={css.where} title={here.path}>{here.title || here.path}</span>
      <Link className={css.icon} href={here.path} aria-label="Open the full page" title="Open the full page"><Maximize2 size={14} aria-hidden="true" /></Link>
    </div>
    <div className={css.frameBox} data-asking={now.key === "asked" || undefined}>
      {loading ? <span className={css.track} aria-hidden="true"><i className={css.progress} /></span> : null}
      {now.key === "asked" ? <div className={css.dim} aria-hidden="true" /> : null}
      <iframe ref={frame} className={css.frame} src={src} title={`The page ${name} works in`} allow="clipboard-write; fullscreen"
        onLoad={() => { loads.current += 1; setLoading(false); follow(); }} />
    </div>
  </section>;
}

/** A step in a few words for a phone: "Add line failed", "Wants: Send to client". */
function shortStep(s: Step) {
  const what = s.text.match(/“([^”]{1,40})”/)?.[1];
  if (s.state === "failed") return what ? `Couldn’t click ${what}` : plain(s.text);
  if (s.state === "asked") return what ? `${what}?` : plain(s.text);
  return plain(s.text);
}
function StepChip({ s, quiet }: { s: Step; quiet?: boolean }) {
  const Icon = quiet ? History : s.state === "done" ? Check : s.state === "failed" ? TriangleAlert : Hourglass;
  return <li className={css.step} data-state={s.state} title={s.text}>
    <Icon size={12} strokeWidth={3} aria-hidden="true" /><span><span className={css.long}>{quiet ? `Earlier: ${plain(s.text).replace(/^\w/, (c) => c.toLowerCase())}` : s.state === "asked" ? shortStep(s) : plain(s.text)}</span>{s.bug ? <Link className={css.short} href="/bug-reports">{quiet ? `${shortStep(s)} (earlier)` : shortStep(s)}</Link>
      : <span className={css.short}>{quiet ? `${shortStep(s)} (earlier)` : shortStep(s)}</span>}</span>
    {s.bug ? <Link className={css.bug} href="/bug-reports" title={s.bug.again ? `Added to problem #${s.bug.number} in Bug reports` : `Problem #${s.bug.number} in Bug reports`} aria-label={`See problem #${s.bug.number} in Bug reports`}><i aria-hidden="true">·</i>See report →</Link> : null}
  </li>;
}

const TRY = ["My tasks", "Quote", "Invoices"];

/** The chat with the AI employee: its messages and a box to write in (the same messages as Chats and the chat dock). */
function ChatColumn({ chan, viewer, chats, pick }: { chan: Channel; viewer: string; chats: Channel[]; pick: (id: string) => void }) {
  const [msgs, setMsgs] = useState<ChatMessage[] | null>(null), [text, setText] = useState(""), [error, setError] = useState(""), [waiting, setWaiting] = useState(false);
  const list = useRef<HTMLDivElement>(null), box = useRef<HTMLTextAreaElement>(null);
  const name = first(chan.name);
  const load = useCallback(async () => {
    const d = await read<{ messages: ChatMessage[] }>(`chats/${chan.id}/messages?flat=1`);
    if (!d) { setError("The chat can’t be reached right now."); return; }
    setError(""); setMsgs(d.messages.slice(-40));
    // Its answer is on the way: the person wrote last, in the last five minutes.
    const last = d.messages.filter((m) => m.kind !== "event").at(-1);
    setWaiting(!!last && last.authorId === viewer && Date.now() - new Date(last.createdAt).getTime() < 5 * 60000);
  }, [chan.id, viewer]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 3000);
    return () => window.clearInterval(t);
  }, [load]);
  const count = msgs?.length ?? 0;
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [count]);
  const update = useCallback((id: string, change: (m: ChatMessage) => ChatMessage) => setMsgs((l) => l?.map((m) => m.id === id ? change(m) : m) ?? l), []);
  const steps = useSteps(), stopped = useOperatorStopped(), now = stateOf(steps, stopped, name, waiting);
  useEffect(() => { setOperatorThinking(waiting); return () => setOperatorThinking(false); }, [waiting]);
  const replied = !!msgs?.some((m) => m.authorId !== viewer && m.kind !== "event");

  // T4.2.4: the talking layer (the browser's speech) beside the thinking layer (the AI employee): what they say is their
  // message; its replies and its steps on the page are read out while it works; speaking again stops it talking.
  const voice = useVoiceLayer((said) => void send(said));
  const [canTalk, setCanTalk] = useState(false);
  useEffect(() => { queueMicrotask(() => setCanTalk(voiceSupported())); }, []);
  const spoken = useRef<{ since: number; ids: Set<string>; steps: number }>({ since: 0, ids: new Set(), steps: 0 });
  useEffect(() => { if (voice.on) spoken.current = { since: Date.now(), ids: new Set(), steps: Number.MAX_SAFE_INTEGER }; }, [voice.on]);
  useEffect(() => {
    if (!voice.on || !msgs) return;
    for (const m of msgs) {
      if (m.authorId === viewer || m.kind === "event" || m.removed || !m.body || spoken.current.ids.has(m.id) || new Date(m.createdAt).getTime() < spoken.current.since - 2000) continue;
      spoken.current.ids.add(m.id); voice.say(m.body);
    }
  }, [msgs, voice, viewer]);
  useEffect(() => {
    if (!voice.on) return;
    const last = steps.at(-1); if (!last) return;
    if (spoken.current.steps === Number.MAX_SAFE_INTEGER) { spoken.current.steps = last.key; return; }
    if (last.key === spoken.current.steps) return;
    spoken.current.steps = last.key;
    voice.say(last.state === "asked" ? `I need your OK on the page: I want to ${last.text.replace(/^Wants to /, "")}` : last.text);
  }, [steps, voice]);

  async function send(said?: string) {
    const body = (said ?? text).trim(); if (!body) return;
    if (!said) setText("");
    setError(""); setOperatorStopped(false);
    try {
      const r = await fetch(`/api/v0/chats/${chan.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, attachments: [], clientId: crypto.randomUUID() }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Not sent");
      void load();
    } catch (e) { setError(`${(e as Error).message}. Your words are back in the box.`); setText(body); }
  }
  const [warned, setWarned] = useState(false);
  const talk = () => { if (voice.on) { voice.stop(); return; } if (!warned) { setWarned(true); return; } voice.start(); };
  return <aside className={css.chat} aria-label={`Chat with ${chan.name}`}>
    <header className={css.chatHead}>
      <span className={css.avatar} aria-hidden="true"><Sparkles size={16} /></span>
      <div><strong title={chan.name}>{chan.name}</strong><small>AI employee</small></div>
      {chats.length > 1 ? <select className={css.pick} value={chan.id} onChange={(e) => pick(e.target.value)} aria-label="Watch another AI employee">
        {chats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : null}
      {canTalk ? <button type="button" className={css.talk} data-on={voice.on || undefined} aria-pressed={voice.on} onClick={talk} aria-label={voice.on ? "Stop talking" : `Talk to ${name}`} title={voice.on ? "Stop talking" : `Talk to ${name} while it works`}>
        {voice.on ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}<span>{voice.on ? "Stop" : "Talk"}</span></button> : null}
    </header>
    {warned && !voice.on ? <div className={css.voiceNote} role="note">
      <p>Talk out loud: {name} hears you and reads its answers and steps out loud while it works. Your browser’s speech service hears you while Talk is on.</p>
      <div><button type="button" className={css.go} onClick={() => voice.start()}><Mic size={14} aria-hidden="true" />Start talking</button>
        <button type="button" className={css.ghost} onClick={() => setWarned(false)}>Not now</button></div>
    </div> : null}
    {voice.on ? <div className={css.voiceBar} role="status" aria-live="polite">
      <span className={css.wave} data-speaking={voice.speaking || undefined} aria-hidden="true"><i /><i /><i /></span>
      <p>{voice.heard ? <>“{voice.heard}”</> : voice.speaking ? `${name} is talking: just speak to stop it` : "Listening…"}</p>
      <select className={css.pick} value={voice.lang} onChange={(e) => voice.setLang(e.target.value as Lang)} aria-label="Language you speak">
        {LANGS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</select>
    </div> : null}
    {voice.error ? <p className={css.error} role="alert">{voice.error}</p> : null}
    <div ref={list} className={`${dock.msgs} ${css.msgs}`} aria-live="polite">
      <div className={css.hello}>
        <p><b>Hi, I’m {name}.</b> Tell me what to do in plain words.</p>
        <ul>
          <li><MousePointerClick size={14} aria-hidden="true" /><span>I work on the page beside this chat.</span></li>
          <li><ShieldCheck size={14} aria-hidden="true" /><span>I ask before I send, pay or delete.</span></li>
          <li><Bug size={14} aria-hidden="true" /><span>If I get stuck, I try another way.</span></li>
        </ul>
      </div>
      {msgs !== null && !replied && !waiting && now.key === "idle" ? <div className={css.calm}><span aria-hidden="true"><Sparkles size={18} /></span><p>{name} is ready when you are.</p></div> : null}
      {msgs === null ? <p className={css.hint}>Loading the chat…</p>
        : msgs.length ? <DockMessages channelId={chan.id} messages={msgs} viewer={viewer} names={false} update={update} reload={() => void load()} /> : null}
      {waiting || now.key === "asked" || now.key === "stopped" ? <p className={css.thinking} role="status" data-state={now.key}><span aria-hidden="true" />{now.chat}</p> : null}
      {msgs !== null && !replied ? <div className={css.tryBox}>
        <p>Try asking:</p>
        <div>{TRY.map((t) => <button key={t} type="button" className={css.tryChip} onClick={() => { setText(t); box.current?.focus(); }}>{t}</button>)}</div>
      </div> : null}
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <form className={css.composer} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder={`Message ${name}…`} aria-label={`Message ${chan.name}`}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
      <button type="submit" className={css.send} disabled={!text.trim()} aria-label="Send"><SendHorizontal size={17} aria-hidden="true" /></button>
    </form>
  </aside>;
}
