"use client";
// UI-DIALOGS kit (owner, 8 Nov 2026: the "app.vitalsos.ai says / New folder name" browser prompt is ugly): the app's own
// confirm, prompt and toast, used instead of window.confirm, window.prompt and window.alert (ESLint refuses those in
// apps/web, and lib/no-browser-dialogs.test.mjs checks none are left).
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title: "Archive this folder?", body: "Its docs stay.", confirmLabel: "Archive folder", danger: true }))) return;
//   const ask = usePrompt();
//   const name = await ask({ title: "Name the new folder", confirmLabel: "Create folder", maxLength: 80 });   // null = cancelled
//   toast.success("Folder made");  toast.error(e);  toast.success("Moved", { action: { label: "Undo", run } });
//
// No provider: the first dialog or toast mounts one small host on the page's body, so it works on every page (signed out,
// framed in the chat's side panel, the client portal). It is a native <dialog> opened with showModal(), so it shows in the
// browser's top layer above drawers, menus and popovers, and the page behind it cannot be clicked or focused. Behaviour
// follows Radix AlertDialog (MIT) without the dependency: focus goes in (the box to type in, else the main button) and
// Tab stays inside; Escape, Cancel, the phone's Back gesture or a press on the dimmed page (unless something was typed)
// answer "no"; Enter answers; focus goes back to what opened it. Keys pressed inside never reach the page behind (a
// drawer's Escape, page shortcuts). A card in the middle of a computer screen, a sheet from the bottom below 600 px;
// motion is off under prefers-reduced-motion. Dialogs asked for together show one after another. Going Back in the
// browser closes them.
//
// toast() sends a notice to Pip's island (@pulse/ui-shell notify; UX-NOTIFY: no corner toasts). A page without the
// island gets a small toast at the bottom from the same host.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { notify, dismissNotice } from "@pulse/ui-shell";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { confirmOptions, createDialogQueue, enterAnswers, firstFocus, promptOptions, promptProblem, promptValue, toastNotice, typedMatches,
  type ConfirmOptions, type DialogRequest, type PromptOptions, type ToastExtra, type ToastNotice, type ToastTone } from "../lib/dialogs.mjs";
import css from "./dialogs.module.css";

export type { ConfirmOptions, PromptOptions, ToastExtra, ToastTone } from "../lib/dialogs.mjs";

const queue = createDialogQueue();
const LEAVE_MS = 150;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

// ---- the host: mounted once, on first use, at the end of <body>
let container: HTMLDivElement | null = null;
function ensureHost() {
  if (typeof document === "undefined") return false;
  if (container) { if (!container.isConnected) document.body.appendChild(container); return true; }
  container = document.createElement("div");
  container.dataset.pulseDialogs = "";
  document.body.appendChild(container);
  createRoot(container).render(<DialogHost />);
  return true;
}

/** Asks a yes/no question in the app's own dialog. Resolves true for the main button, false for anything else. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!ensureHost()) return Promise.resolve(false);
  return queue.open("confirm", options);
}
/** Asks for a line (or a few lines) of text. Resolves with the trimmed answer, or null when cancelled. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  if (!ensureHost()) return Promise.resolve(null);
  return queue.open("prompt", options);
}
/** `const confirm = useConfirm()` in a component; the same function as confirmDialog. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> { return confirmDialog; }
/** `const ask = usePrompt()` in a component; the same function as promptDialog. */
export function usePrompt(): (options: PromptOptions) => Promise<string | null> { return promptDialog; }

// ---- toasts
let fallback: ToastNotice[] = [];
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((l) => l());
const islandOnPage = () => typeof document !== "undefined" && !!document.querySelector("[data-pip]");
function dropToast(id: string) { if (!fallback.some((t) => t.id === id)) return; fallback = fallback.filter((t) => t.id !== id); emitToasts(); }
function show(tone: ToastTone, what: unknown, extra?: ToastExtra): string {
  const notice = toastNotice(tone, what, extra);
  if (typeof document === "undefined") return notice.id;
  notify(notice);
  if (!islandOnPage() && ensureHost()) { fallback = [...fallback.filter((t) => t.id !== notice.id), notice].slice(-3); emitToasts(); }
  return notice.id;
}
type Toast = ((what: unknown, extra?: ToastExtra & { tone?: ToastTone }) => string) & {
  success: (what: unknown, extra?: ToastExtra) => string; error: (what: unknown, extra?: ToastExtra) => string;
  info: (what: unknown, extra?: ToastExtra) => string; dismiss: (id: string) => void };
/** A short confirmation or problem: `toast.success("Saved")`, `toast.error(e)` (an Error's own words), `toast("…")`.
 *  Returns the toast's id (`toast.dismiss(id)`). */
export const toast: Toast = Object.assign((what: unknown, extra?: ToastExtra & { tone?: ToastTone }) => show(extra?.tone ?? "info", what, extra), {
  success: (what: unknown, extra?: ToastExtra) => show("success", what, extra),
  error: (what: unknown, extra?: ToastExtra) => show("error", what, extra),
  info: (what: unknown, extra?: ToastExtra) => show("info", what, extra),
  dismiss: (id: string) => { dismissNotice(id); dropToast(id); },
});

function DialogHost() {
  const request = useSyncExternalStore(queue.subscribe, queue.current, () => null);
  const toasts = useSyncExternalStore((l) => { toastListeners.add(l); return () => { toastListeners.delete(l); }; }, () => fallback, () => fallback);
  // Going Back (or forward) in the browser leaves the page the question was about.
  useEffect(() => { const back = () => queue.clear(); addEventListener("popstate", back); return () => removeEventListener("popstate", back); }, []);
  return <>{request ? <DialogView key={request.id} request={request} /> : null}{toasts.length ? <ToastList toasts={toasts} /> : null}</>;
}

function DialogView({ request }: { request: DialogRequest }) {
  const prompt = request.kind === "prompt";
  const c = prompt ? null : confirmOptions(request.options as ConfirmOptions);
  const p = prompt ? promptOptions(request.options as PromptOptions) : null;
  const o = (c ?? p)!;
  const typeToConfirm = c?.typeToConfirm ?? null;
  const ref = useRef<HTMLDialogElement>(null), form = useRef<HTMLFormElement>(null);
  const before = useRef<HTMLElement | null>(null), done = useRef(false), downOutside = useRef(false);
  const [text, setText] = useState(p?.defaultValue ?? "");
  const [tried, setTried] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const id = useId(), titleId = `${id}-t`, bodyId = `${id}-b`, inputId = `${id}-i`, underId = `${id}-u`;
  const problem = p ? promptProblem(text, p) : null;
  const ready = typeToConfirm ? typedMatches(text, typeToConfirm) : true;

  const finish = (value: boolean | string | null) => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    const end = () => {
      const d = ref.current;
      if (d?.open) { try { d.close(); } catch { /* already closed */ } }
      const back = before.current;
      if (back?.isConnected && !back.closest("[inert]")) back.focus({ preventScroll: true });
      queue.answer(request.id, value);
    };
    if (reduced()) end(); else setTimeout(end, LEAVE_MS);
  };
  const cancel = () => finish(prompt ? null : false);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (p) {
      if (problem) { setTried(true); ref.current?.querySelector<HTMLElement>(`#${CSS.escape(inputId)}`)?.focus(); return; }
      finish(promptValue(text, p));
      return;
    }
    if (!ready) return;
    finish(true);
  };

  useLayoutEffect(() => {
    const d = ref.current; if (!d) return;
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof d.showModal === "function") { try { d.showModal(); } catch { d.setAttribute("open", ""); d.dataset.fallback = ""; } }
    else { d.setAttribute("open", ""); d.dataset.fallback = ""; }
    const target = d.querySelector<HTMLElement>(firstFocus(request.kind, c ?? undefined) === "input" ? `#${CSS.escape(inputId)}` : "[data-dialog-confirm]");
    target?.focus({ preventScroll: true });
    // The given answer is chosen, so typing replaces it (as window.prompt did); a link's "https://" keeps the caret at its end.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (p?.url && /^[a-z]+:\/*$/i.test(target.value)) target.setSelectionRange(target.value.length, target.value.length); else target.select();
    }
    return () => { if (d.open) { try { d.close(); } catch { /* gone */ } } };
    // Opens once per request (the component is keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    // Nothing behind a modal dialog reacts to keys pressed in it (a drawer's Escape and Tab, page shortcuts).
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key === "Tab") {
      const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      const first = all[0], last = all.at(-1), now = document.activeElement;
      if (!first || !last) { e.preventDefault(); return; }
      if (!e.currentTarget.contains(now)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && now === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && now === last) { e.preventDefault(); first.focus(); }
      return;
    }
    const tag = e.target instanceof HTMLElement ? e.target.tagName : "";
    if (enterAnswers({ key: e.key, shiftKey: e.shiftKey, tag, multiline: !!p?.multiline && tag === "TEXTAREA" })) { e.preventDefault(); submit(); }
  };
  // A press on the dimmed page (outside the card) answers "no", unless something was typed that would be lost.
  const untouched = () => (p ? text === p.defaultValue : !typeToConfirm || !text);
  const onMouseDown = (e: ReactMouseEvent<HTMLDialogElement>) => { downOutside.current = e.target === e.currentTarget; };
  const onClick = (e: ReactMouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget && downOutside.current && untouched()) cancel(); downOutside.current = false; };

  const showProblem = !!p && tried && !!problem;
  const length = p ? promptValue(text, p).length : 0;
  const over = !!p?.maxLength && length > p.maxLength;
  const fieldLabel = p ? p.label : typeToConfirm ? <>Type <span className={css.need}>{typeToConfirm}</span> to confirm</> : null;
  const body = o.body == null || o.body === "" ? null : typeof o.body === "string" ? <p>{o.body}</p> : o.body as ReactNode;
  const showField = !!p || !!typeToConfirm;
  const multiline = !!p?.multiline;
  const fieldProps = {
    id: inputId, className: css.input, value: text, placeholder: p?.placeholder || undefined, autoComplete: p?.password ? "current-password" : "off", spellCheck: multiline || undefined,
    "aria-labelledby": fieldLabel ? undefined : titleId, "aria-describedby": (p?.helper || showProblem || p?.maxLength) ? underId : undefined,
    "aria-invalid": showProblem || undefined, "aria-required": p?.required || !!typeToConfirm || undefined,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
  };
  return (
    <dialog ref={ref} className={css.dialog} data-pulse-dialog={request.kind} data-tone={o.danger ? "danger" : undefined} data-leaving={leaving ? "" : undefined}
      role={prompt ? "dialog" : "alertdialog"} aria-modal="true" aria-labelledby={titleId} aria-describedby={body ? bodyId : undefined}
      onCancel={(e) => { e.preventDefault(); cancel(); }} onKeyDown={onKeyDown} onMouseDown={onMouseDown} onClick={onClick}>
      <form ref={form} className={css.card} onSubmit={submit} noValidate>
        <div className={css.grip} aria-hidden="true" />
        <div className={css.head}>
          {o.danger ? <span className={css.icon} aria-hidden="true"><TriangleAlert size={18} /></span> : null}
          <div className={css.words}>
            <h2 id={titleId} className={css.title}>{o.title}</h2>
            {body ? <div id={bodyId} className={css.body}>{body}</div> : null}
          </div>
        </div>
        {showField ? (
          <div className={css.field}>
            {fieldLabel ? <label htmlFor={inputId} className={css.label}>{fieldLabel}</label> : null}
            {multiline
              ? <textarea {...fieldProps} rows={3} enterKeyHint="done" />
              : <input {...fieldProps} type={p?.password ? "password" : p?.url ? "url" : "text"} inputMode={p?.url ? "url" : undefined} enterKeyHint="done" autoCapitalize={p?.url || typeToConfirm ? "none" : undefined} autoCorrect={p?.url || typeToConfirm ? "off" : undefined} />}
            {p && (p.helper || showProblem || p.maxLength) ? (
              <div id={underId} className={css.under}>
                {showProblem ? <span className={css.problem} role="alert"><CircleAlert size={14} aria-hidden="true" />{problem}</span> : <span>{p.helper ?? ""}{multiline ? <span className={css.hint}>{p.helper ? " " : ""}Shift+Enter starts a new line.</span> : null}</span>}
                {p.maxLength ? <span className={css.count} data-over={over ? "" : undefined} aria-label={`${length} of ${p.maxLength} characters`}>{length}/{p.maxLength}</span> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={css.actions}>
          <button type="button" className={`${css.btn} ${css.quiet}`} onClick={cancel}>{o.cancelLabel}</button>
          <button type="submit" className={`${css.btn} ${css.primary}`} data-danger={o.danger ? "" : undefined} data-dialog-confirm="" disabled={!ready}>{o.confirmLabel}</button>
        </div>
      </form>
    </dialog>
  );
}

function ToastList({ toasts }: { toasts: ToastNotice[] }) {
  const box = useRef<HTMLDivElement>(null);
  // In the top layer (as kit/layer.tsx), so a drawer or a framed page's own layers never cover it.
  useLayoutEffect(() => { const el = box.current; if (el && "showPopover" in el) { try { if (!el.matches(":popover-open")) el.showPopover(); } catch { /* shown */ } } });
  return <div ref={box} popover="manual" className={css.toasts} data-pulse-toasts="">{toasts.map((t) => <ToastItem key={t.id} t={t} />)}</div>;
}

function ToastItem({ t }: { t: ToastNotice }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || !Number.isFinite(t.timeout)) return;
    const timer = setTimeout(() => dropToast(t.id), t.timeout);
    return () => clearTimeout(timer);
  }, [paused, t.id, t.timeout]);
  const Icon = t.tone === "success" ? CircleCheck : t.tone === "error" ? CircleAlert : Info;
  return (
    <div className={css.toast} data-tone={t.tone} role={t.tone === "error" ? "alert" : "status"} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <Icon className={css.toastIcon} size={17} aria-hidden="true" />
      <div className={css.toastWords}><strong>{t.title}</strong>{t.message ? <span>{t.message}</span> : null}</div>
      {t.action ? <button type="button" className={css.toastAction} onClick={() => { t.action?.run(); dropToast(t.id); }}>{t.action.label}</button> : null}
      <button type="button" className={css.toastClose} aria-label="Close" onClick={() => dropToast(t.id)}><X size={15} aria-hidden="true" /></button>
    </div>
  );
}
