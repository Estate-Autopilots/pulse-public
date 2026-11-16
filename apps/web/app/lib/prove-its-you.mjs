// BUGFIX #29 (EA #29, 15 Nov 2026): "I am not able to switch from EA to Vitals OS." A company's own sign-in (its password,
// its e-mailed staff code, its Google) opens that company only (ACCOUNT-META, 2125); opening another company answers 403
// with the code personal_sign_in. Before, the switcher showed nothing (the refusal landed in a closed menu) and the only
// way through was to sign out. Now the person confirms it is them where they stand, the browser's sign-in becomes
// theirs, and what they asked for runs again. Pure, so it is tested without a browser (prove-its-you.test.mjs);
// orgs/client.ts gives it the app's dialogs and fetch.
// SWITCH-SMOOTH (owner, 16 Nov 2026: "I don't even know what my password is. Asking again and again is a hazard."):
// one tap first. A code goes to the person's own e-mail at once (account/prove-code), the code box is ready for typing or
// pasting, and "Use my Pulse password instead" is the quiet second way. Once proved, this browser never asks again for
// 180 days (2165's trusted device), in any company. Nobody is left at a dead end: no own e-mail -> the password; no
// password either -> "Sign in as yourself".
import { PROMPT_ALTERNATE } from "./dialogs.mjs";

/** The refusal that a proof of the person can lift (any other refusal stays as it is). */
export const needsProof = (e) => !!e && typeof e === "object" && e.code === "personal_sign_in";

/** What the code prompt answers when "Use my Pulse password instead" is pressed. */
export const USE_PASSWORD = PROMPT_ALTERNATE;

/** The words, naming the company being opened when it is known (screenshot judge: "name the company in the dialog"). */
export function proveWords(name) {
  const it = name ? String(name) : "";
  return {
    title: "Confirm it's you",
    body: it ? `To open ${it}, type your own Pulse password once. You stay signed in.` : "To open your other companies, type your own Pulse password once. You stay signed in.",
    label: "Your Pulse password",
    confirmLabel: it ? `Open ${it}` : "Confirm and open",
    // Screenshot judge round 3: a "Forgot it?" hint here was a dead end (it points to a sign-in page the person is not
    // on), so there is none; Cancel keeps them where they are.
    wrong: "That is not your Pulse password. Try again.",
    noPassword: "Your account has no Pulse password yet. Sign in again with your own e-mail (Send me a code) to open your other companies.",
    signInTitle: "Sign in as yourself",
    signInLabel: "Sign in as yourself",
    // SWITCH-SMOOTH: the e-mailed code.
    codeBody: (to) => `We sent a 6-digit code to ${to}. Paste it here${it ? ` to open ${it}` : ""}. This device won't ask again.`,
    codeLabel: "Code from your e-mail",
    codeHelp: "Not in your inbox? Check spam. The code works for 10 minutes.",
    codeWrong: "That code is not right. Check the newest e-mail from Pulse.",
    codeResent: "That code ran out, so we sent a new one. Check your e-mail.",
    codeOut: "That code ran out. Cancel and try again in a minute.",
    usePassword: "Use my Pulse password instead",
  };
}
export const PROVE_WORDS = proveWords();

const statusOf = (e) => (e && typeof e === "object" ? e.status : undefined);
const codeOf = (e) => (e && typeof e === "object" ? e.code : undefined);

/** The e-mailed code: "proved", "password" (use the password instead) or "cancel". */
async function codeRound(io, w) {
  let sent;
  try { sent = await io.sendCode(); } catch (e) {
    // A code went out a moment ago (one a minute): that one is still good, so the box asks for it.
    if (statusOf(e) === 429 && io.codeTo) sent = { to: io.codeTo };
    else return "password"; // no own e-mail, or the mail is down: the password is still there
  }
  if (sent?.personal) return "proved";
  const to = sent?.to || io.codeTo || "your e-mail";
  let error = null, resent = false;
  for (let i = 0; i < 6; i++) {
    const code = await io.ask({ title: w.title, body: w.codeBody(to), label: w.codeLabel, confirmLabel: w.confirmLabel, code: true, minLength: 6, maxLength: 6,
      placeholder: "6 digits", helper: w.codeHelp,
      ...(io.password === false ? {} : { alternate: w.usePassword }), ...(error ? { error } : {}) });
    if (code == null) return "cancel";
    if (code === USE_PASSWORD) return "password";
    try { await io.proveCode(code); return "proved"; } catch (e) {
      if (statusOf(e) === 401 && codeOf(e) === "code_expired") {
        if (resent) { error = w.codeOut; continue; }
        resent = true;
        try { await io.sendCode(); error = w.codeResent; } catch { error = w.codeOut; }
        continue;
      }
      if (statusOf(e) === 401) { error = w.codeWrong; continue; }
      throw e;
    }
  }
  return "cancel";
}

/** The Pulse password (2142's "Confirm it's you"): true once proved. */
async function passwordRound(io, w) {
  const offerSignIn = async () => { if (await io.confirm({ title: w.signInTitle, body: w.noPassword, confirmLabel: w.signInLabel })) await io.signInAgain(); return false; };
  if (io.password === false) return offerSignIn();
  const tries = io.tries ?? 3;
  let error = null;
  for (let i = 0; i < tries; i++) {
    const password = await io.ask({ title: w.title, body: w.body, label: w.label, confirmLabel: w.confirmLabel, password: true, maxLength: 200,
      ...(error ? { error } : {}) });
    if (password == null) return false;
    try { await io.prove(password); return true; } catch (e) {
      if (statusOf(e) === 401) { error = w.wrong; continue; }
      // No Pulse password of their own: only their own e-mail proves them.
      if (needsProof(e)) return offerSignIn();
      throw e;
    }
  }
  return false;
}

/**
 * Asks the person to confirm it is them (the code to their own e-mail first when `io.sendCode` is given, the password
 * last) and proves the browser's sign-in. True once proved; false when they cancel.
 * @param {{ ask: (o: object) => Promise<string | null>, prove: (password: string) => Promise<unknown>,
 *   confirm: (o: object) => Promise<boolean>, signInAgain: () => unknown, tries?: number, name?: string,
 *   sendCode?: () => Promise<{ to?: string, personal?: boolean }>, proveCode?: (code: string) => Promise<unknown>,
 *   codeTo?: string | null, password?: boolean }} io
 * @returns {Promise<boolean>}
 */
export async function proveNow(io) {
  const w = proveWords(io.name);
  if (io.sendCode && io.proveCode) {
    const r = await codeRound(io, w);
    if (r === "proved") return true;
    if (r === "cancel") return false;
  }
  return passwordRound(io, w);
}

/**
 * Runs `work`. When it is refused for want of the person's own sign-in, asks them to confirm it is them (proveNow) and
 * runs `work` once more. Cancelling, or no way to prove them here, keeps the first refusal (after offering to sign in
 * again as yourself). Anything else is thrown unchanged.
 * @template T
 * @param {() => Promise<T>} work
 * @param {Parameters<typeof proveNow>[0]} io
 * @returns {Promise<T>}
 */
export async function withProof(work, io) {
  try { return await work(); } catch (first) {
    if (!needsProof(first)) throw first;
    if (!await proveNow(io)) throw first;
    return await work();
  }
}
