// QUOTE-FIXES (Mac test of production b7110a07, 21 Nov 2026, DEVICE-BUG-0700 qt-new-client-place-of-supply): a new client
// typed into a quotation was set to Karnataka, but the place of supply stayed Maharashtra with CGST + SGST, and the PDF
// showed both states. The place of supply follows the client's state until someone sets it apart; a draft for a client
// with no state yet starts at the company's own state (the server's default), which nobody chose, so the first state
// given to the client moves it too.

/**
 * The place of supply after the client's state changes.
 * @param {string | null | undefined} pos the draft's place of supply now
 * @param {string | null | undefined} oldState the client's state before the change
 * @param {string | null | undefined} newState the client's state after it
 * @param {string} sellerState the company's own state (two digits)
 * @returns {string | null}
 */
export function placeAfterBuyer(pos, oldState, newState, sellerState) {
  const follows = !pos || pos === oldState || (!oldState && pos === sellerState);
  return follows ? newState ?? pos ?? null : pos;
}
