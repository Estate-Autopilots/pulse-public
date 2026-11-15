// BUGFIX #29 (EA #29, 15 Nov 2026): "I am not able to switch from EA to Vitals OS." A company's own sign-in (its password,
// its e-mailed staff code, its Google) opens that company only (ACCOUNT-META, 2125); the switch answers 403 with the code
// personal_sign_in. Before, the switcher showed nothing (the refusal landed in a closed menu) and the only way through was
// to sign out. Now the person confirms it is them where they stand: they type their own Pulse password once, the session
// becomes theirs (POST account/prove), and the switch they asked for runs again. Pure, so it is tested without a browser
// (prove-its-you.test.mjs); orgs/client.ts gives it the app's dialogs and fetch.

/** The refusal that a proof of the person can lift (any other refusal stays as it is). */
export const needsProof = (e) => !!e && typeof e === "object" && e.code === "personal_sign_in";

export const PROVE_WORDS = {
  title: "Confirm it's you",
  body: "You signed in with this company's own sign-in. It opens this company only. To open your other companies, type your own Pulse password once. You stay signed in.",
  label: "Your Pulse password",
  confirmLabel: "Confirm and open",
  wrong: "That is not your Pulse password. Try again.",
  noPassword: "Your account has no Pulse password yet. Sign in again with your own e-mail (Send me a code) to open your other companies.",
  signInTitle: "Sign in as yourself",
  signInLabel: "Sign in as yourself",
};

/**
 * Runs `work`. When it is refused for want of the person's own sign-in, asks for their Pulse password (at most `tries`
 * times), proves it, and runs `work` once more. Cancelling, or an account with no password, keeps the first refusal
 * (after offering to sign in again as yourself). Anything else is thrown unchanged.
 * @template T
 * @param {() => Promise<T>} work
 * @param {{ ask: (o: object) => Promise<string | null>, prove: (password: string) => Promise<unknown>,
 *   confirm: (o: object) => Promise<boolean>, signInAgain: () => unknown, tries?: number }} io
 * @returns {Promise<T>}
 */
export async function withProof(work, io) {
  try { return await work(); } catch (first) {
    if (!needsProof(first)) throw first;
    const tries = io.tries ?? 3;
    let helper;
    for (let i = 0; i < tries; i++) {
      const password = await io.ask({ title: PROVE_WORDS.title, body: PROVE_WORDS.body, label: PROVE_WORDS.label, confirmLabel: PROVE_WORDS.confirmLabel,
        password: true, maxLength: 200, ...(helper ? { helper } : {}) });
      if (password == null) throw first;
      try { await io.prove(password); return await work(); } catch (e) {
        const status = e && typeof e === "object" ? e.status : undefined;
        if (status === 401) { helper = PROVE_WORDS.wrong; continue; }
        if (needsProof(e)) {
          // No Pulse password of their own: only their own e-mail proves them.
          if (await io.confirm({ title: PROVE_WORDS.signInTitle, body: PROVE_WORDS.noPassword, confirmLabel: PROVE_WORDS.signInLabel })) await io.signInAgain();
          throw first;
        }
        throw e;
      }
    }
    throw first;
  }
}
