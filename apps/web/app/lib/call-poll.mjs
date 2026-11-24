// USER-INSIGHT (23 Nov 2026): when the calls engine reads its events directly (its stream is down or quiet). 87% of
// 1,295 failed reads in a week came from hidden apps with no network, once a minute for hours; now a device that is
// offline does not read (going online reads at once), and each failure doubles the wait. A call being set up keeps
// reading every second: its offer, answer and network candidates must get through (WL-ONBOARD-FIX, 17 Nov).

export const POLL_SETUP_MS = 1000;
const BASE = { shown: 5000, hidden: 15000 };
const CAP = { shown: 60000, hidden: 120000 };

/** Milliseconds between reads, or null for no reads now.
 * @param {{ setup: boolean, down: boolean, hidden: boolean, offline: boolean, fails: number }} s */
export function pollWait({ setup, down, hidden, offline, fails }) {
  if (offline) return null;
  if (setup) return POLL_SETUP_MS;
  if (!down) return null;
  const k = hidden ? "hidden" : "shown";
  return Math.min(CAP[k], BASE[k] * 2 ** Math.min(Math.max(0, fails | 0), 6));
}
