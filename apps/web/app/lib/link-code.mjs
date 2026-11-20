// SIGNIN-CODE (19 Nov 2026): what the one-time sign-in page (/login/link) does with what a person types or pastes when
// it was opened without a link (a phone app: on an iPhone a link opens Safari, not the installed app). HR's link, or
// its token alone, signs in as the link does; otherwise the link's 8-character code goes with the username (db 2399).
const CODE = /^[2-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/** The token of a pasted sign-in link (…/login/link#<token>) or of a pasted token alone; "" for anything else. */
export function pastedToken(value) {
  const m = String(value ?? "").trim().match(/(?:^|\/login\/link#)([A-Za-z0-9_-]{43})$/);
  return m ? m[1] : "";
}

/** A typed code as the server reads it (upper case, spaces and dashes dropped), or "" when it is not one. */
export function typedCode(value) {
  const c = String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
  return CODE.test(c) ? c : "";
}

/** The request body for the page's Sign in, or an error to show: a link or token alone, or the username with a code.
 *  `otp` is the authenticator's code when two-step asks for it. */
export function linkSignInBody({ username, entry, otp = "" }) {
  const token = pastedToken(entry);
  if (token) return { body: { token, code: otp } };
  const signInCode = typedCode(entry);
  if (!signInCode) return { error: "Type the 8-character code from HR (like 7KQM-2RXD), or paste the whole sign-in link." };
  const user = String(username ?? "").trim();
  if (!user) return { error: "Type your username too: the code works only with it." };
  return { body: { username: user, signInCode, code: otp } };
}
