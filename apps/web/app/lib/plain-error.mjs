// SIGNED-OUT-SHELL (phone QA, 4 Nov 2026): the API proxy's same-origin guard answers "Invalid origin" (api/proxy.mjs),
// and sign-up, Start your company and the e-mailed sign-in code showed those two words as they were. What a person
// sees instead says what happened and what to do; any other text stands as it is.

export const UNUSUAL_ADDRESS = "This page was opened from an unusual address. Open Pulse from its usual link and try again.";

const PLAIN = new Map([["Invalid origin", UNUSUAL_ADDRESS]]);

/**
 * The words to show for an error text from the API or the web app's own routes.
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function plainError(text) {
  const t = String(text ?? "").trim();
  return PLAIN.get(t) ?? String(text ?? "");
}
