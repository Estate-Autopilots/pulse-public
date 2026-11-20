"use client";
// AGENT-CHANNELS (1685): always-on listening. Start (after confirming everyone was told), the transcript shows here, and
// the chosen AI employee reacts in its chat (drafts a quotation, flags a requirement, creates a task); what it did shows
// beside the words. Stop any time. Transcripts are kept (NO-DATA-LOSS, owner 20 Nov 2026).
// SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.1): redone from what it does, after Codex's concepts (reports/settings-apple/
// concepts/listen: 1 idle, 2 live). One big button; who follows along and what the talk is about are two small choices
// above it; telling everyone is one question when you press it; the name is made for you.
// LISTEN-FAST (owner, 14 Nov 2026: "What does it actually do? I'm waiting fifteen seconds... Not snappy like Wispr
// Flow"):
//  * Words about a second after they are said: live words through the speech service (engine.ts), the server's Whisper
//    as the fallback (pieces cut at a pause). The bar says which one is writing.
//  * Before: one line says what this session will do for the chosen purpose and helper.
//  * Starts at once: the live bar shows the moment you confirm, the level meter moves as soon as the microphone opens
//    (the browser remembers the permission), and the session, the microphone and the stream open side by side.
//  * While live: words still changing show in grey; what the helper did shows as cards (task made → open it, quote
//    drafted → open it), not only text.
//  * After: a short summary (at most five lines), decisions, what the helper did, what is left to do, Keep as a meeting.
import { ArrowUpRight, Bot, ChevronRight, CircleStop, FileText, ListTodo, Megaphone, Mic, NotebookPen, ReceiptText, Settings as Cog, Sparkles, Trash2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { post } from "../records";
import { actionsIn, clock, decisionsIn, lastSeq, mergeSegments, plainReply, promiseLine, PURPOSES, summaryLines } from "../lib/listen-model.mjs";
import css from "./listen.module.css";
import { ListenEngine, type Mode, type Why } from "./engine";
import { useConfirm } from "../kit/dialogs";
import { Drawer, Switch } from "../kit";
import { SelectField } from "../kit/select-field";
import { ActionButton, Chip, EmptyState, GameCard, GamePage, PageHeader, SkeletonRows, toast } from "../kit/game";
import { usePrivacyContact, withPrivacyContact } from "../privacy-contact";

type Agent = { id: string; name: string };
type Session = { id: string; title: string; purpose: string; startedAt: string; stoppedAt: string | null; agent: string | null; by: string; segments: number; purgeAfter: string };
type Home = { on: boolean; live?: boolean; retentionDays: number; canEdit: boolean; sessions: Session[]; agents: Agent[]; instant?: { server: boolean; on: boolean; provider: string | null } };
type Segment = { seq: number; part: number; startMs: number; endMs: number; text: string };
type Reply = { id: string; at: string; body: string };
type View = { id: string; title: string; purpose?: string; live: boolean; agent: string | null; agentId?: string | null; waiting: number; segments: Segment[]; replies: Reply[]; purgeAfter: string };
type After = { id: string; summary: string[]; todo: { title: string; who: string | null }[] };
type Live = { id: string; since: number; mode: Mode; why: Why };

async function getJson<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; }
}

const day = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const ICONS: Record<string, LucideIcon> = { task: ListTodo, quote: ReceiptText, invoice: ReceiptText, doc: FileText, contract: FileText };
const WHY: Record<string, string> = {
  budget: "This month's instant minutes are used, so your server writes the words, a few seconds late.",
  provider: "Instant words are not answering, so your server writes the words, a few seconds late.",
};

/** What the AI helper did, as cards that open the thing it made. */
function ActionCards({ replies }: { replies: Reply[] }) {
  const cards = actionsIn(replies);
  if (!cards.length) return null;
  return <ul className={css.cards} aria-label="What the AI helper made">{cards.map((c) => {
    const Icon = ICONS[c.kind] ?? Sparkles;
    return <li key={c.key}><Link href={c.href} className={css.action} data-kind={c.kind}>
      <span className={css.actionIcon}><Icon size={18} aria-hidden="true" /></span>
      <span className={css.actionText}><small>{c.label}</small><b>{c.title}</b></span>
      <ArrowUpRight size={16} aria-hidden="true" />
    </Link></li>;
  })}</ul>;
}

export function ListenRoom({ initialAgent }: { initialAgent?: string }) {
  const confirm = useConfirm();
  const contact = usePrivacyContact();   // NO-DATA-LOSS-5: the approved texts name the company's privacy contact's e-mail
  const router = useRouter();
  const [home, setHome] = useState<Home | null>(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState(initialAgent ?? ""), [purpose, setPurpose] = useState("general");
  const [view, setView] = useState<View | null>(null), [segments, setSegments] = useState<Segment[]>([]), [settings, setSettings] = useState(false);
  const [live, setLive] = useState<Live | null>(null), [now, setNow] = useState(() => Date.now());
  const [interim, setInterim] = useState(""), [after, setAfter] = useState<After | null>(null), [quiet, setQuiet] = useState(false);
  const eng = useRef<ListenEngine | null>(null);
  const meter = useRef<HTMLSpanElement | null>(null);
  const segRef = useRef<Segment[]>([]);

  const load = useCallback(() => getJson<Home>("listen").then((h) => { if (h) setHome(h); }), []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const openView = useCallback(async (id: string) => {
    const v = await getJson<View>(`listen/sessions/${id}?after=${lastSeq(segRef.current)}`);
    if (!v) return;
    segRef.current = mergeSegments(segRef.current, v.segments);
    setSegments(segRef.current); setView(v);
  }, []);
  // While listening the clock ticks every second and the helper's actions refresh (every 3 s with live words; every
  // 1.5 s while the server writes the words); after Stop, until every piece is written.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { setNow(Date.now()); setQuiet(!!eng.current && eng.current.mode !== "starting" && Date.now() - eng.current.lastLoud > 6000); }, 1000);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => {
    if (!view || (!view.live && !view.waiting && !live)) return;
    const t = setInterval(() => void openView(view.id), live?.mode === "pieces" ? 1500 : 3000);
    return () => clearInterval(t);
  }, [view, live, openView]);
  useEffect(() => { if (eng.current) eng.current.meterEl = meter.current; }, [live]);
  // The helper's replies show here as they come, so they do not also pop up over the page (notify/island.tsx).
  const helperId = view?.agentId ?? null;
  useEffect(() => {
    if (!helperId) return;
    const root = document.documentElement; root.dataset.onScreenFrom = helperId;
    return () => { if (root.dataset.onScreenFrom === helperId) delete root.dataset.onScreenFrom; };
  }, [helperId]);

  // After: the short summary and what is left to do (the meeting reader's preview: nothing is saved).
  useEffect(() => {
    if (!view || view.live || view.waiting || !segments.length || after?.id === view.id) return;
    const text = segments.map((x) => `[${clock(x.startMs)}] ${x.text}`).join("\n");
    let gone = false;
    post<{ summary?: string | null; drafts?: { title: string; who?: string | null }[] }>("meetings/preview", { text, title: view.title })
      .then((p) => { if (!gone) setAfter({ id: view.id, summary: summaryLines(p.summary, 5), todo: (p.drafts ?? []).slice(0, 5).map((d) => ({ title: d.title, who: d.who ?? null })) }); })
      .catch(() => { if (!gone) setAfter({ id: view.id, summary: [], todo: [] }); });
    return () => { gone = true; };
  }, [view, segments, after]);

  const instant = !!home?.instant?.on;
  async function start() {
    if (busy || live) return;
    const ok = await confirm({ title: "Did you tell everyone?",
      // NO-DATA-LOSS-4 (owner approved 20 Nov 2026): the sound (Instant words off) and the words are kept, with no end date.
      body: withPrivacyContact(instant ? "Everyone in this conversation must know it is being recorded and written down, and why. The sound goes to Google's speech service to be written down live; Google does not use it to train its AI. Pulse keeps the words, with no end date, to improve Pulse. To have them erased, ask your company's privacy contact."
        : "Everyone in this conversation must know it is being recorded and written down, and why. The sound and the words are kept on your company's server, to improve Pulse; nothing is deleted because of its age. To have a recording erased, ask your company's privacy contact.", contact),
      confirmLabel: "Yes, start listening" });
    if (!ok) return;
    const since = Date.now();
    setNote(""); setInterim(""); setAfter(null); setQuiet(false); segRef.current = []; setSegments([]); setView(null);
    setLive({ id: "", since, mode: "starting", why: null }); setNow(since); // the live bar at once; the meter moves when the microphone opens
    const kind = PURPOSES.find((p) => p.value === purpose)?.label ?? "Conversation";
    const title = `${kind}, ${new Date().toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}`;
    const e = new ListenEngine(since, {
      mode: (mode, why) => setLive((l) => (l ? { ...l, mode, why } : l)),
      interim: (text) => setInterim(text),
      final: (line) => { segRef.current = mergeSegments(segRef.current, [line]); setSegments(segRef.current); },
      error: (text) => setNote(text),
    });
    eng.current = e;
    const session = post<{ id: string }>("listen/sessions", { agentId: agentId || null, title, purpose, consent: true });
    session.catch(() => undefined);
    try {
      await e.open();
      e.meterEl = meter.current;
      const s = await session;
      setLive((l) => (l ? { ...l, id: s.id } : l));
      void openView(s.id);
      await e.begin(s.id, instant);
    } catch (err) {
      e.close(); eng.current = null; setLive(null);
      const s = await session.catch(() => null);
      if (s?.id) await post(`listen/sessions/${s.id}/stop`, {}).catch(() => undefined);
      setNote(err instanceof Error ? (err.name === "NotAllowedError" ? "Allow the microphone for Pulse to listen." : err.message) : "Could not start listening.");
    }
  }
  async function stop() {
    if (!live?.id) return;
    setBusy(true);
    await eng.current?.stop(); eng.current = null;
    try { await post(`listen/sessions/${live.id}/stop`, {}); } catch (e) { setNote(e instanceof Error ? e.message : "Could not stop."); }
    setLive(null); setInterim(""); setBusy(false);
    await openView(live.id); void load();
  }
  // Leaving the page lets the microphone go (the server stops a silent session by itself after an hour).
  useEffect(() => () => { eng.current?.close(); }, []);

  // MEETING-CAPTURE: the listening session's words go into Meetings (the one capture engine): kept line by line, with drafts.
  async function keep() {
    if (!view || busy) return; setBusy(true); setNote("");
    try {
      const text = segments.map((x) => `[${clock(x.startMs)}] ${x.text}`).join("\n");
      const d = await post<{ id: string }>("meetings/import", { text, title: view.title });
      router.push(`/meetings/${d.id}?saved=1`);
    } catch (e) { setNote((e as Error).message); setBusy(false); }
  }
  async function remove(id: string) {
    if (!(await confirm({ title: "Delete this transcript?", body: "You can't undo this.", confirmLabel: "Delete transcript", danger: true }))) return;
    try { await post(`listen/sessions/${id}/delete`, {}); if (view?.id === id) { setView(null); segRef.current = []; setSegments([]); } void load(); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not delete."); }
  }
  async function saveSettings(change: Record<string, unknown>) {
    setBusy(true); setNote("");
    try {
      const r = await fetch("/api/v0/agent-channels", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      const d = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(d.error ?? "Could not save.");
      await load(); toast("Saved.");
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }

  const chosen = PURPOSES.find((p) => p.value === purpose);
  const helper = home?.agents.find((a) => a.id === agentId)?.name;
  const open = (id: string) => { segRef.current = []; setSegments([]); setAfter(null); void openView(id); };
  const closeView = () => { setView(null); setAfter(null); segRef.current = []; setSegments([]); };
  const decisions = view && !view.live ? decisionsIn(segments) : [];
  const done = view && !view.live && !view.waiting && segments.length > 0;
  // The helper's replies that made something are its cards; the rest show as notes (nothing is said twice).
  const carded = new Set(actionsIn(view?.replies ?? []).map((c) => c.reply));
  const notes = (view?.replies ?? []).filter((r) => !carded.has(r.id));
  // The summary without its "Decision: …" sentence when the decisions have their own list.
  const summary = (after?.summary ?? []).filter((l) => !(decisions.length && /^Decisions?:/.test(l)));
  const listening = !!live;
  return <GamePage label="Listen">
    <PageHeader title="Listen" subtitle={live ? "Talk as usual. Press Stop when you are done." : done ? "Here is what was said and done. Keep it as a meeting, or listen again." : "Listen writes down your call or meeting while you talk, then lists what was decided and what is still to do."}
      side={home?.canEdit ? <ActionButton small action={{ label: "Listening settings", icon: Cog, onClick: () => setSettings(true) }} /> : undefined} />

    {!home ? <SkeletonRows rows={3} label="Loading Listen" />
      : !home.on ? <EmptyState art="connect" title="Listening is off" text={home.canEdit ? "Turn it on to let people record a talk and have an AI helper follow along." : "An admin of your company can turn it on."}
        action={home.canEdit ? { label: "Turn on listening", onClick: () => void saveSettings({ listenOn: true }) } : undefined} />
      : live ? <section className={css.liveBar} aria-live="polite" aria-label="Listening now" data-mode={live.mode}>
        <span className={css.rec} aria-hidden="true" />
        <span className={css.liveText}><b>{live.mode === "starting" ? "Starting…" : "Listening"}</b>
          <small>{live.mode === "instant" ? "Words show as you speak" : live.mode === "pieces" ? "Words show a few seconds after you speak" : "Opening the microphone"}</small>
          {view?.agent ?? helper ? <small>{view?.agent ?? helper} follows along</small> : null}</span>
        <span className={css.meter} ref={meter} aria-hidden="true" data-testid="level-meter"><i /><i /><i /><i /><i /></span>
        <span className={css.timer} role="timer" aria-label="Time listening">{clock(now - live.since)}</span>
        <button type="button" className={css.stop} disabled={busy || !live.id} onClick={() => void stop()}><CircleStop size={18} aria-hidden="true" />{busy ? "Stopping…" : "Stop"}</button>
        <small className={css.told}>{quiet ? <b className={css.quiet}>No sound yet. Check the microphone.</b> : "Everyone was told this is being recorded."}{live.why && WHY[live.why] ? ` ${WHY[live.why]}` : ""}</small>
      </section>
      : !view ? <section className={css.start} aria-label="Start listening">
        <div className={css.choices}>
          <label className={css.choice}><span>AI helper</span>
            <SelectField size="sm" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="AI helper who follows along">
              <option value="">Off (just the words)</option>
              {home.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </SelectField></label>
          <label className={css.choice}><span>About</span>
            <SelectField size="sm" value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="What the talk is about">
              {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </SelectField></label>
        </div>
        <button type="button" className={css.go} disabled={busy} onClick={() => void start()}>
          <span className={css.mic}><Mic size={40} strokeWidth={2.2} aria-hidden="true" /><b>Start listening</b></span>
        </button>
        <p className={css.promise} data-testid="listen-promise">{promiseLine(purpose, helper ?? null, instant)}</p>
        <small className={css.hint}><Megaphone size={14} aria-hidden="true" /> Tell everyone it is being recorded.</small>
      </section> : null}

    {note ? <p role="status" className={css.note}>{note}</p> : null}

    {done ? <GameCard title="What happened" icon={Sparkles} label="Summary of the talk">
      <div className={css.after}>
        {after ? <>
          {summary.length ? <ul className={css.summary}>{summary.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
          {decisions.length ? <div className={css.block}><h3>Decided</h3><ul>{decisions.map((d) => <li key={d}>{d}</li>)}</ul></div> : null}
          {actionsIn(view.replies).length ? <div className={css.block}><h3>{view.agent ?? "The helper"} made</h3><ActionCards replies={view.replies} /></div> : null}
          {after.todo.length ? <div className={css.block}><h3>Still to do</h3><ul>{after.todo.map((t, i) => <li key={i}>{t.title}{t.who ? <small> · {t.who}</small> : null}</li>)}</ul></div> : null}
          {!summary.length && !decisions.length && !after.todo.length ? <p className={css.muted}>{segments.length} {segments.length === 1 ? "line" : "lines"} written down.</p> : null}
        </> : <SkeletonRows rows={2} label="Reading the talk" />}
        <div className={css.afterActions}><ActionButton primary action={{ label: "Keep as a meeting", icon: NotebookPen, onClick: () => void keep(), busy }} />
          <button type="button" className={css.close} onClick={closeView}><Mic size={16} aria-hidden="true" /><span>Listen again</span></button></div>
        <small className={css.muted}>Keep it: the words and to-dos go to Meetings. Otherwise they stay here with your company records.</small>
      </div>
    </GameCard> : null}

    {view ? <div className={css.split} data-one={done && !notes.length ? "" : undefined}>
      <GameCard title={view.live ? "What is being said" : view.title} label="What was said"
        note={!view.live && !done ? <span className={css.viewTools}>
          <button type="button" className={css.close} onClick={closeView}><Mic size={16} aria-hidden="true" /><span>Listen again</span></button>
        </span> : view.live && view.waiting ? <Chip>{view.waiting} {view.waiting === 1 ? "piece" : "pieces"} being written</Chip> : undefined}>
        {segments.length || (listening && interim) ? <ol className={css.transcript} data-testid="transcript">
          {segments.map((s) => <li key={`${s.seq}:${s.part}`}><time>{clock(s.startMs)}</time><span>{s.text}</span></li>)}
          {listening && interim ? <li className={css.interim} data-testid="interim"><time>{clock(now - (live?.since ?? now))}</time><span>{interim}</span></li> : null}
        </ol>
          : <p className={css.muted}>{listening ? (live?.mode === "pieces" ? "Talk as usual. The first words show a few seconds after you speak." : "Talk as usual. Words show here as you speak.") : view.waiting ? "Writing the last words…" : "Nothing was heard."}</p>}
      </GameCard>
      {done && !notes.length ? null : <GameCard title={view.agent ? `What ${view.agent} did` : "No AI helper"} icon={Bot} label="What the AI helper did">
        {done ? null : <ActionCards replies={view.replies} />}
        {notes.length ? <ul className={css.replies}>{notes.map((r) => <li key={r.id}><time>{day(r.at)}</time><p>{plainReply(r.body)}</p></li>)}</ul>
          : view.replies.length ? null
          : <p className={css.muted}>{view.agent ? `${view.agent} reads the words every 30 seconds. What it makes (a task, a quote) shows here as a card you can open.` : "Pick a helper next time and it acts on what is said."}</p>}
      </GameCard>}
    </div> : null}

    {!live && home?.on && home.sessions.some((s) => s.id !== view?.id) ? <GameCard title="Earlier" label="Earlier sessions">
      <ul className={css.sessions}>{home.sessions.filter((s) => s.id !== view?.id).map((s) => <li key={s.id} data-open={view?.id === s.id ? "" : undefined}>
        <button type="button" className={css.session} onClick={() => open(s.id)}>
          <b>{s.title}</b>
          <small>{s.title.includes(day(s.startedAt)) ? "" : `${day(s.startedAt)} · `}{s.segments} {s.segments === 1 ? "line" : "lines"}{s.agent ? ` · ${s.agent}` : ""}</small>
        </button>
        <ChevronRight size={16} aria-hidden="true" className={css.chev} />
        {s.stoppedAt ? null : <Chip tone="bad">Live</Chip>}
        <button type="button" className={css.icon} aria-label={`Delete ${s.title}`} onClick={() => void remove(s.id)}><Trash2 size={16} aria-hidden="true" /></button>
      </li>)}</ul>
    </GameCard> : null}

    {/* NO-DATA-LOSS-4: nothing is deleted because of its age, so there is no "keep for (days)" to choose; the switches save at once. */}
    {settings && home ? <Drawer title="Listening settings" context="For everyone at your company" size="sm" onClose={() => setSettings(false)}>
      <div className={css.settings}>
        <Switch label="Listening is on" hint="People can record a talk so an AI helper follows along. Everyone sees when it is on." checked={home.on} disabled={busy} onChange={(on) => void saveSettings({ listenOn: on })} />
        <Switch label="Instant words" hint={home.instant?.server ? "Words show as people speak. The sound goes to Google's speech service for that; Google does not use it to train its AI. Off: the sound stays on your server and words come a few seconds late."
          : "Not set up on this server yet. Words come from your own server, a few seconds late."}
          checked={!!home.instant?.on} disabled={busy || !home.instant?.server} onChange={(on) => void saveSettings({ listenLive: on })} />
        <small className={css.muted}>{withPrivacyContact("The sound, the words and the copies sent to the AI helper are kept with your company records, to improve Pulse; nothing is deleted because of its age. With Instant words on, only the words are kept (the sound goes to Google). To have a recording erased, ask your company's privacy contact.", contact)}</small>
      </div>
    </Drawer> : null}
  </GamePage>;
}
