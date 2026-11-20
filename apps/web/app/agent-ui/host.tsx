"use client";
// AGENT-UI-CONTROL (owner, 7 Nov 2026): the person's side of AI employees driving the screen, mounted once for a signed-in
// staff seat (never inside a framed page). One live stream (/api/v0/screen/events, as Chats') brings what to do now and
// the prompts this person may answer:
//   * an action: the tab in front takes it (claim; a tab in the background waits a moment so the one in front wins), does
//     it (actions.tsx) and says how it went (done); a short violet line says what was done, with Pause (no AI screen
//     actions in this browser for 30 minutes);
//   * a prompt ("Pip wants to open the quotation beside the chat"): Allow once / Always (admins and leadership) / No, in
//     the tray at the top of the screen (a count in the top bar brings it back when closed);
//   * a one-tap card for what a browser allows only on a person's own tap (choose a file, start the microphone).
// AGENT-OPERATOR (13 Nov 2026): Pause and the operator view's Stop answer at once (the AI employee hears "they stopped
// you" instead of waiting for nothing); a step that did not work sends a picture of the page it worked in, so Pulse
// files it as a bug with the AI employee as reporter (one report per problem: the same one again is a note on it); in
// the operator view every step goes to its step strip (operator-frame.ts) and the prompt tray sits over its page.
// AI-AGENTS-3 (owner, 17 Nov 2026: "Watch Bharata work should not need a click: when an agent acts on screen, its work
// opens in the side panel immediately"): a step that would take the person away from their chat with that AI employee
// (opening a page, or a form that is a page) opens the operator view instead, with that page beside the chat, and runs
// there; the person never presses "Watch … work". Only when that chat is on screen (its Watch link names the chat).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, Paperclip, Pause, Sparkles, Square, X } from "lucide-react";
import { asks as asksWords, did, KINDS } from "./catalogue.mjs";
import { HANDLERS, type Outcome, type ScreenAction, type Tap } from "./actions";
import { operatorFrame, operatorStopped, pushStep, resolveAsks, useOperatorOpen } from "./operator-frame";
import { SideView, useSideViewOpen } from "./side-view";
import { ClientFormHost } from "./card";
import { GuideBar } from "./guide-bar";
import { useGuide } from "./guide";
import { matchTutorial, tutorial } from "../lib/learn.mjs";
import { keepStream } from "../lib/live-stream.mjs";
import css from "./agent-ui.module.css";

type Ask = ScreenAction & { mine: boolean; canAlways: boolean; expiresAt: string };
type Pending = { actions: ScreenAction[]; asks: Ask[]; manager?: boolean };
const PAUSE_KEY = "pulse.screen.paused";
const PAUSE_MS = 30 * 60000;
const never = () => () => {};
const pausedUntil = () => { try { return Number(window.sessionStorage.getItem(PAUSE_KEY)) || 0; } catch { return 0; } };
const call = async <T,>(path: string, body: unknown = {}): Promise<T> => {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(d.error ?? "That did not work. Try again.");
  return d;
};
const first = (name: string) => name.split(" ")[0] || name;
/** A person's own choice (they said no, chose no file, stopped it): not a problem to report. */
const theirChoice = (error: string) => /^They (chose|did not choose|pressed|paused)/.test(error);
/** A picture of the page the AI worked in (the operator view's framed page, else this one) as a data URL, or null. */
async function picture(): Promise<string | null> {
  try {
    const framed = operatorFrame()?.scope();
    const shoot = framed ? (framed.win as unknown as { pulseCaptureScreen?: () => Promise<Blob | null> }).pulseCaptureScreen : (await import("../bug-report/capture")).captureScreen;
    const blob = shoot ? await shoot() : null;
    if (!blob || blob.size > 3_000_000) return null;
    return await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
  } catch { return null; }
}
/** Steps that move the page: opened beside the chat (the operator view) when the person is in their chat with the AI. */
const FORM_PAGE: Record<string, string> = { quote: "/erp/new?type=quotation", person: "/people?add=member", ai_employee: "/people?add=ai" };
const PULSE_PAGE = /^\/(?!\/)/, NOT_HERE = /^\/(api|operator)(\/|\?|$)/;
function movesTo(a: ScreenAction): string | null {
  if (a.action === "page.open") { const p = typeof a.args.path === "string" ? a.args.path.trim() : ""; return PULSE_PAGE.test(p) && !NOT_HERE.test(p) ? p.slice(0, 400) : null; }
  if (a.action === "form.open") return FORM_PAGE[String(a.args.form ?? "")] ?? null;
  // DOCS-EDITOR-8: "show me how" opens beside the chat on its walkthrough's page.
  if (a.action === "guide.play") { const named = typeof a.args.tutorial === "string" ? tutorial(a.args.tutorial) : undefined; return (named ?? matchTutorial(String(a.args.question ?? "")))?.tryHref ?? null; }
  return null;
}
const sleep = (ms: number) => new Promise((ok) => window.setTimeout(ok, ms));
/** The person's chat with this AI employee is on screen and the operator view is not open: open it on the page the step
 *  goes to, and wait for its frame (up to 60 s: DOCS-EDITOR-8 saw a first load of the view take longer than 9 s, and the
 *  step then ran on the page it had left) and the page in it (up to 30 s). False when the step runs where it is. */
async function openBesideChat(a: ScreenAction, push: (href: string) => void): Promise<boolean> {
  const path = operatorFrame() ? null : movesTo(a);
  if (!path) return false;
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[data-chat-operator]")];
  const link = links.find((l) => !!a.channelId && l.dataset.chatOperator === a.channelId) ?? links.find((l) => !!a.agent.id && l.dataset.chatAgent === a.agent.id);
  const channel = link?.dataset.chatOperator;
  if (!channel) return false;
  push(`/operator?channel=${encodeURIComponent(channel)}&path=${encodeURIComponent(path)}`);
  // The view, then its framed page (a first load can take a while): the step then runs on that page without loading it again.
  for (let i = 0; i < 400 && !operatorFrame(); i++) await sleep(150);
  for (let i = 0; i < 200 && operatorFrame() && !operatorFrame()?.scope(); i++) await sleep(150);
  return !!operatorFrame();
}
/** The address of the page the AI worked in (without the frame's embed=1). */
function workedOn(): string {
  try { const w = operatorFrame()?.scope()?.win ?? window; return `${w.location.pathname}${w.location.search}`.replace(/([?&])embed=1(&|$)/, (_, a: string, b: string) => (b ? a : "")).replace(/[?&]$/, ""); } catch { return window.location.pathname; }
}
export function ScreenHost() {
  const router = useRouter();
  const [asks, setAsks] = useState<Ask[]>([]), [closed, setClosed] = useState<string[]>([]), [taps, setTaps] = useState<Tap[]>([]);
  const [activity, setActivity] = useState<{ key: number; text: string; paused?: boolean } | null>(null), [touch, setTouch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<{ id: string; text: string } | null>(null);
  const seen = useRef(new Set<string>()), push = useRef(router.push);
  useEffect(() => { push.current = router.push; }, [router]);
  const actions = useSyncExternalStore(never, () => document.querySelector<HTMLElement>("[data-shell-actions]"), () => null);
  // Drawn in the browser only (the server's page has no tray), so hydration matches.
  const client = useSyncExternalStore(never, () => true, () => false);
  // The side view is open on a computer: the tray keeps to its left.
  const beside = useSideViewOpen() && client && window.matchMedia("(min-width: 900px)").matches;
  // The operator view shows the steps itself (its strip) and the prompts over its page.
  const operator = useOperatorOpen();
  // DOCS-EDITOR-8: a walkthrough on the whole screen says what the AI is doing itself (its card sits where the pill would).
  const guiding = useGuide()?.where === "page";

  const say = useCallback((text: string, paused = false) => setActivity({ key: Date.now(), text, paused }), []);
  useEffect(() => { if (!activity) return; const t = window.setTimeout(() => setActivity(null), activity.paused ? 6000 : 4500); return () => window.clearTimeout(t); }, [activity]);
  // FIX-CHAT-AI (owner, 10 Nov 2026: "it should visibly work on screen like a human ... and show progress"): while an AI
  // employee works this screen, a pill at the bottom shows who, each step it took (ticked, or crossed when it did not
  // work) and Pause / Stop. It stays while steps keep coming and fades 8 seconds after the last.
  const [work, setWork] = useState<{ agent: string; steps: { key: number; text: string; ok: boolean }[]; at: number } | null>(null);
  const step = useCallback((agent: string, text: string, ok: boolean) => setWork((w) => {
    const now = Date.now(), fresh = !w || w.agent !== agent || now - w.at > 120000;
    return { agent, at: now, steps: [...(fresh ? [] : w.steps), { key: now, text, ok }].slice(-12) };
  }), []);
  useEffect(() => { if (!work) return; const t = window.setTimeout(() => setWork(null), 8000); return () => window.clearTimeout(t); }, [work]);

  const waitingTaps = useRef(new Map<string, (r: { ok: boolean; files?: File[] }) => void>());
  const tap = useCallback((t: Tap) => new Promise<{ ok: boolean; files?: File[] }>((resolve) => {
    waitingTaps.current.set(t.id, resolve);
    setTaps((list) => [...list.filter((x) => x.id !== t.id), t]);
  }), []);
  const endTap = useCallback((id: string, r: { ok: boolean; files?: File[] }) => {
    waitingTaps.current.get(id)?.(r); waitingTaps.current.delete(id);
    setTaps((list) => list.filter((x) => x.id !== id));
  }, []);

  // One action: taken by this tab (or not: another tab took it), done, and told back.
  const run = useCallback(async (a: ScreenAction) => {
    const paused = pausedUntil() > Date.now(), stopped = operatorStopped();
    if (paused || stopped) {
      // Taken and answered at once, so the AI employee stops instead of waiting for a screen that will not act.
      const took = await call<{ action: ScreenAction | null }>(`screen/actions/${a.id}/claim`).catch(() => ({ action: null }));
      if (took.action) await call(`screen/actions/${a.id}/done`, { ok: false, error: stopped ? "They pressed Stop: do no more screen steps until they ask again. Tell them in words what is left."
        : "They paused AI screen help in this browser: do no more screen steps. Tell them in words what you would do." }).catch(() => {});
      say(`${first(a.agent.name)} tried to ${asksWords(a.action, a.args)}. ${stopped ? "Stopped" : "Paused"}`, true); return;
    }
    const took = await call<{ action: ScreenAction | null }>(`screen/actions/${a.id}/claim`).catch(() => ({ action: null }));
    if (!took.action) return;
    await openBesideChat(a, (href) => push.current(href));
    // In the operator view a form that is a page opens in its frame too (the person stays beside the chat).
    const go = (href: string) => { const f = operatorFrame(); if (f && PULSE_PAGE.test(href)) { f.reveal?.(); void f.go(href); } else push.current(href); };
    let out: Outcome;
    try { out = await HANDLERS[a.action](a, { push: go, tap }); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "It did not work on this screen" }; }
    // A step that did not work (not their own choice) is reported with a picture of the page, as a bug.
    const problem = !out.ok && !theirChoice(out.error) ? { route: workedOn(), screenshot: await picture() } : null;
    const back = await call<{ bug?: { number: number; again: boolean } | null }>(`screen/actions/${a.id}/done`, out.ok ? { ok: true, result: out.result ?? {} } : { ok: false, error: out.error, ...(problem ? { problem } : {}) }).catch(() => null);
    const bug = back?.bug ?? null;
    // DOCS-EDITOR-8: "show me how" with no walkthrough for the question showed nothing (the AI explains in words).
    if (out.ok && out.result?.shown === false) return;
    if (out.ok) { say(`${first(a.agent.name)}: ${did(a.action, a.args)}`); setTouch(Date.now()); step(a.agent.name, did(a.action, a.args), true); pushStep({ agent: a.agent.name, text: did(a.action, a.args), state: "done" }); }
    else {
      say(`${first(a.agent.name)} could not ${asksWords(a.action, a.args)}: ${out.error}${bug ? ` (${bug.again ? "added to" : "filed as"} bug #${bug.number})` : ""}`);
      step(a.agent.name, `Could not ${asksWords(a.action, a.args)}`, false);
      pushStep({ agent: a.agent.name, text: `Could not ${asksWords(a.action, a.args)}`, state: "failed", bug });
    }
  }, [say, tap, step]);

  const askedSteps = useRef(new Set<string>());
  const apply = useCallback((p: Pending) => {
    setAsks(p.asks ?? []);
    // In the operator view a question for this person is a step too ("Waiting for your yes: click “Send”").
    if (operatorFrame()) {
      resolveAsks((p.asks ?? []).map((x) => x.id));
      for (const x of p.asks ?? []) if (x.mine && !askedSteps.current.has(x.id)) {
        askedSteps.current.add(x.id); pushStep({ agent: x.agent.name, text: `Wants to ${asksWords(x.action, x.args)}`, state: "asked", askId: x.id });
      }
    }
    for (const a of p.actions ?? []) {
      if (seen.current.has(a.id) || !HANDLERS[a.action]) continue;
      seen.current.add(a.id);
      // The tab in front takes it at once; one in the background only if no tab in front did.
      const front = document.visibilityState === "visible" && document.hasFocus();
      window.setTimeout(() => void run(a), front ? 0 : 1500);
    }
  }, [run]);

  useEffect(() => {
    let gone = false;
    const read = () => { if (document.visibilityState === "visible") void fetch("/api/v0/screen/pending", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<Pending> : null).then((p) => { if (p && !gone) apply(p); }).catch(() => {}); };
    // TEAM-TELEMETRY (21 Nov 2026): keepStream (FIX-LIVE, as Chats) opens the stream again when the browser gives up on it
    // (a 502 while the API restarts), with a growing wait. It used to stay closed until the tab was hidden and shown
    // again, with only the 15-second look below while the page stayed in view.
    const stream = keepStream("/api/v0/screen/events", (es) => {
      es.addEventListener("screen", (e) => { try { apply(JSON.parse((e as MessageEvent<string>).data) as Pending); } catch { /* a broken event is skipped */ } });
    });
    // The stream reconnects by itself; while it cannot, a look every 15 seconds (only when the page is in view).
    const poll = window.setInterval(() => { if (stream.current?.readyState !== EventSource.OPEN) read(); }, 15000);
    const back = () => { if (document.visibilityState === "visible") stream.wake(); };
    document.addEventListener("visibilitychange", back);
    return () => { gone = true; stream.close(); window.clearInterval(poll); document.removeEventListener("visibilitychange", back); };
  }, [apply]);

  async function decide(a: Ask, decision: "once" | "always" | "no") {
    setBusy(a.id); setError(null);
    try {
      await call(`screen/actions/${a.id}/decide`, { decision });
      setAsks((l) => l.filter((x) => x.id !== a.id));
      if (decision === "always") say(`Done. ${first(a.agent.name)} won’t ask again to ${KINDS[a.action] ?? "do this"}`);
    } catch (e) { setError({ id: a.id, text: e instanceof Error ? e.message : "That did not work. Try again." }); } finally { setBusy(null); }
  }
  const pause = () => { try { window.sessionStorage.setItem(PAUSE_KEY, String(Date.now() + PAUSE_MS)); } catch { /* none */ } say("AI screen help paused for 30 minutes in this browser", true); setWork(null); };
  const resume = () => { try { window.sessionStorage.removeItem(PAUSE_KEY); } catch { /* none */ } setActivity(null); };

  const open = asks.filter((a) => !closed.includes(a.id)), shown = open.slice(0, 3), hiddenCount = open.length - shown.length;
  const tray = <div className={css.tray} data-agent-ui="" data-beside={beside || undefined} data-operator={operator || undefined} aria-live="polite">
    {shown.map((a) => <section key={a.id} className={css.card} role="alertdialog" aria-label={`${a.agent.name} asks`} data-screen-ask={a.id} data-confirm={a.needed === "confirm" || undefined}>
      <div className={css.head}>
        <span className={css.mark} aria-hidden="true"><Sparkles size={15} /></span>
        <p className={css.words}><b>{operator ? first(a.agent.name) : a.agent.name}</b> wants to {asksWords(a.action, a.args)}{a.mine ? "" : <> for <b>{a.target.name}</b></>}.
          <span className={css.meta}>{a.why ? `${a.why.charAt(0).toUpperCase()}${a.why.slice(1).replace(/\.$/, "")}. ` : ""}{a.needed === "confirm" ? "This click is for real: it may send, pay or remove something. Only you can say yes." : a.needed === "admin" ? "This needs Admin screen access." : a.needed === "act" ? "This needs Act screen access." : ""}</span></p>
        {operator && a.mine ? null : <button type="button" className={css.close} onClick={() => setClosed((c) => [...c, a.id])} aria-label="Decide later" title="Decide later"><X size={15} aria-hidden="true" /></button>}
      </div>
      <div className={css.buttons}>
        <button type="button" className={css.primary} disabled={busy === a.id} onClick={() => void decide(a, "once")}>Allow once</button>
        {a.canAlways ? <button type="button" className={css.btn} disabled={busy === a.id} onClick={() => void decide(a, "always")} title={`Let ${first(a.agent.name)} do this without asking from now on`}>Always</button> : null}
        <button type="button" className={css.ghost} disabled={busy === a.id} onClick={() => void decide(a, "no")}>No</button>
      </div>
      {error?.id === a.id ? <p className={css.error} role="alert">{error.text}</p> : null}
    </section>)}
    {hiddenCount > 0 && shown.length ? <p className={css.more}>{hiddenCount} more waiting</p> : null}
    {taps.map((t) => <section key={t.id} className={css.card} role="dialog" aria-label={`${t.agent} asks`} data-screen-tap={t.id}>
      <div className={css.head}>
        <span className={css.mark} aria-hidden="true"><Sparkles size={15} /></span>
        <p className={css.words}><b>{t.agent}</b> {t.words}.</p>
        <button type="button" className={css.close} onClick={() => endTap(t.id, { ok: false })} aria-label="Not now"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className={css.buttons}>
        {t.file ? <label className={css.primary}><Paperclip size={14} aria-hidden="true" />{t.button}
          <input type="file" hidden accept={t.file.accept} multiple={t.file.multiple} onChange={(e) => { const files = [...(e.target.files ?? [])]; endTap(t.id, { ok: files.length > 0, files }); }} /></label>
          : <button type="button" className={css.primary} onClick={() => endTap(t.id, { ok: true })}>{t.button}</button>}
        <button type="button" className={css.ghost} onClick={() => endTap(t.id, { ok: false })}>Not now</button>
      </div>
    </section>)}
    {work && !activity?.paused && !operator && !guiding ? <section className={css.work} role="status" aria-label={`${work.agent} is working on your screen`} data-screen-work="">
      <div className={css.workHead}>
        <span className={css.workMark} aria-hidden="true"><Sparkles size={16} /></span>
        <p><b>{first(work.agent)} is working on your screen</b><small>{work.steps.length} step{work.steps.length === 1 ? "" : "s"} so far</small></p>
        <button type="button" onClick={pause} title="No AI screen actions in this browser for 30 minutes"><Pause size={14} aria-hidden="true" />Pause</button>
        <button type="button" onClick={() => { pause(); setWork(null); }} aria-label="Stop"><Square size={13} aria-hidden="true" />Stop</button>
      </div>
      <ol className={css.workSteps}>{work.steps.slice(-4).map((x, i, all) => <li key={x.key} data-ok={x.ok || undefined} data-now={i === all.length - 1 || undefined}>
        <span aria-hidden="true">{x.ok ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}</span>{x.text}</li>)}</ol>
      <i className={css.workBar} aria-hidden="true" key={work.at} />
    </section> : null}
    {activity && !operator && !(guiding && !activity.paused) ? <p key={activity.key} className={css.activity} role="status" data-screen-activity="">
      {activity.paused ? <Pause size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}<span>{activity.text}</span>
      {activity.paused ? <button type="button" onClick={resume}>Resume</button> : <button type="button" onClick={pause} title="No AI screen actions in this browser for 30 minutes">Pause</button>}
    </p> : null}
  </div>;
  const waiting = asks.length - open.length;
  return <>
    {client ? createPortal(tray, document.body) : null}
    {actions && waiting > 0 ? createPortal(<button type="button" className={css.barPill} onClick={() => setClosed([])} aria-label={`${waiting} AI request${waiting === 1 ? "" : "s"} waiting for you`} data-screen-asks="">
      <Sparkles size={14} aria-hidden="true" />Requests<i>{waiting}</i></button>, actions) : null}
    {touch ? <div key={touch} className={css.touch} aria-hidden="true" onAnimationEnd={() => setTouch(0)} /> : null}
    <SideView />
    <ClientFormHost />
    {client ? <GuideBar where="page" /> : null}
  </>;
}
