// UI-DIALOGS (owner, 8 Nov 2026: "the 'app.vitalsos.ai says / New folder name' browser prompt is ugly"): the logic
// behind the app's own confirm, prompt and toast (kit/dialogs.tsx draws them). Pure, so it is tested
// (dialogs.test.mjs) without a browser:
//   - one queue: a dialog asked for while another is open waits its turn; each answer settles its own promise;
//     going Back in the browser closes them all (each answers "no");
//   - what a typed answer must be (required, min/max length, a link), with the problem in plain words;
//   - "type the name to confirm" for actions that cannot be undone;
//   - when Enter answers the dialog, and what a toast says.

/** @typedef {{ id: number, kind: "confirm" | "prompt", options: any, settle: (value: any) => void }} DialogRequest */

/** A queue of dialogs, shown one at a time. `open` returns a promise that settles with the answer. */
export function createDialogQueue() {
  /** @type {DialogRequest[]} */
  let queue = [];
  let serial = 0;
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  /** What an unanswered dialog of this kind answers when it is closed without a choice. */
  const nothing = (kind) => (kind === "confirm" ? false : null);
  return {
    open(kind, options) {
      return new Promise((resolve) => {
        queue = [...queue, { id: ++serial, kind, options, settle: resolve }];
        emit();
      });
    },
    /** The dialog on screen now (the first waiting), or null. */
    current() { return queue[0] ?? null; },
    /** How many dialogs wait, the one on screen included. */
    size() { return queue.length; },
    /** Answers the dialog `id` (the one on screen); the next one waiting shows. */
    answer(id, value) {
      const hit = queue.find((r) => r.id === id);
      if (!hit) return false;
      queue = queue.filter((r) => r !== hit);
      hit.settle(value);
      emit();
      return true;
    },
    /** Closes everything (going Back, tests): each one answers "no". */
    clear() {
      const gone = queue; queue = [];
      for (const r of gone) r.settle(nothing(r.kind));
      if (gone.length) emit();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** The defaults every confirm gets: a "Cancel" button, a plain "Continue" when a caller gave no verb. */
export function confirmOptions(options) {
  const o = options ?? {};
  return {
    title: String(o.title ?? "Are you sure?"),
    body: o.body ?? null,
    confirmLabel: String(o.confirmLabel || "Continue"),
    cancelLabel: String(o.cancelLabel || "Cancel"),
    danger: !!o.danger,
    typeToConfirm: typeof o.typeToConfirm === "string" && o.typeToConfirm.trim() ? o.typeToConfirm.trim() : null,
  };
}

/** The defaults every prompt gets (calling it again on its own result changes nothing). `url: true` means a web link (https:// or http://); a list names the allowed
 *  starts (["https:", "http:", "mailto:"]). */
export function promptOptions(options) {
  const o = options ?? {};
  const url = o.url === true ? ["https:", "http:"] : Array.isArray(o.url) && o.url.length ? o.url.map((s) => String(s).toLowerCase()) : null;
  return {
    title: String(o.title ?? ""),
    label: o.label ? String(o.label) : null,
    body: o.body ?? null,
    placeholder: o.placeholder ? String(o.placeholder) : "",
    defaultValue: o.defaultValue == null ? "" : String(o.defaultValue),
    helper: o.helper ? String(o.helper) : null,
    confirmLabel: String(o.confirmLabel || "Save"),
    cancelLabel: String(o.cancelLabel || "Cancel"),
    required: o.required !== false,
    minLength: Number.isFinite(o.minLength) && o.minLength > 0 ? Math.floor(o.minLength) : 0,
    maxLength: Number.isFinite(o.maxLength) && o.maxLength > 0 ? Math.floor(o.maxLength) : 0,
    url,
    multiline: !!o.multiline,
    // BUGFIX #29: a password box ("Confirm it's you"): hidden as typed, filled by the browser's password manager, kept
    // exactly as typed (never trimmed), one line.
    password: !!o.password && !o.multiline && !url,
    danger: !!o.danger,
    validate: typeof o.validate === "function" ? o.validate : null,
  };
}

/** What a typed link becomes: "example.com/a" gets https:// in front; anything else stays as typed. */
export function normalizeLink(value, schemes = ["https:", "http:"]) {
  const v = String(value ?? "").trim();
  if (!v) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  if (schemes.includes("https:") && /^[\w-]+(\.[\w-]+)+([/?#:].*)?$/.test(v)) return `https://${v}`;
  return v;
}

/** Whether `value` is a link starting with one of `schemes` (with somewhere to go after it). */
export function isLink(value, schemes = ["https:", "http:"]) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (!schemes.includes(url.protocol)) return false;
  if (url.protocol === "mailto:") return /.+@.+/.test(url.pathname);
  return url.hostname === "localhost" || url.hostname.includes(".");
}

/** The answer a prompt gives back: trimmed; a link gets https:// when it was typed without it. */
export function promptValue(raw, options) {
  const o = promptOptions(options);
  if (o.password) return String(raw ?? "");
  const v = String(raw ?? "").trim();
  return o.url && v ? normalizeLink(v, o.url) : v;
}

/** What is wrong with a typed answer, in plain words, or null when it is fine. */
export function promptProblem(raw, options) {
  const o = promptOptions(options);
  const v = promptValue(raw, o);
  if (!v) return o.required ? (o.url ? "Please paste or type a link." : "Please fill this in.") : null;
  if (o.minLength && v.length < o.minLength) return `Please use at least ${o.minLength} ${o.minLength === 1 ? "character" : "characters"}.`;
  if (o.maxLength && v.length > o.maxLength) return `Please keep it to ${o.maxLength} characters or fewer (now ${v.length}).`;
  if (o.url && !isLink(v, o.url)) {
    const starts = o.url.map((s) => (s === "mailto:" ? "mailto:" : `${s}//`));
    return `This doesn't look like a link. It should start with ${starts.length > 1 ? `${starts.slice(0, -1).join(", ")} or ${starts.at(-1)}` : starts[0]}`;
  }
  if (o.validate) { const own = o.validate(v); if (own) return String(own); }
  return null;
}

/** "Type the name to confirm": spaces at the ends and capital letters do not matter. */
export function typedMatches(typed, expected) {
  const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  return !!norm(expected) && norm(typed) === norm(expected);
}

/** Whether this key press answers the dialog: Enter, but not while an IME is composing, not on a button or link (they
 *  press themselves), and in a box of several lines only without Shift (Shift+Enter is a new line). */
export function enterAnswers({ key, shiftKey = false, isComposing = false, tag = "", multiline = false }) {
  if (key !== "Enter" || isComposing) return false;
  const t = String(tag).toUpperCase();
  if (t === "BUTTON" || t === "A") return false;
  if (t === "TEXTAREA" || multiline) return !shiftKey;
  return true;
}

/** What gets focus when a dialog opens: the box to type in, else the main button. */
export function firstFocus(kind, options) {
  if (kind === "prompt") return "input";
  return options?.typeToConfirm ? "input" : "confirm";
}

const TONES = new Set(["success", "error", "info"]);
let toastSerial = 0;
/** The notice a toast sends to Pip's island (@pulse/ui-shell notify). An Error's own words become the title; without
 *  any, a plain "Something went wrong". Problems stay longer than confirmations. */
export function toastNotice(tone, what, extra = {}) {
  const t = TONES.has(tone) ? tone : "info";
  const fromError = what instanceof Error ? what.message : what && typeof what === "object" && "message" in what ? String(what.message ?? "") : null;
  const title = String((fromError ?? what) || (t === "error" ? "Something went wrong" : "Done")).trim() || (t === "error" ? "Something went wrong" : "Done");
  const notice = { id: extra.id ? String(extra.id) : `toast-${++toastSerial}`, tone: t, title };
  if (extra.message) notice.message = String(extra.message);
  if (extra.action && typeof extra.action.run === "function" && extra.action.label) notice.action = { label: String(extra.action.label), run: extra.action.run };
  notice.timeout = Number.isFinite(extra.timeout) ? extra.timeout : t === "error" ? 8000 : extra.action ? 7000 : 4000;
  return notice;
}
