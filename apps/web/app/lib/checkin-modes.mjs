// VITALS-SWEEP (VTI #3): where someone works today, named the same plain way in both check-in places (the top bar's menu
// and My desk / HR). "Home" alone did not read as "work from home".
export const CHECKIN_MODES = [{ id: "office", label: "Office" }, { id: "wfh", label: "Work from home" }, { id: "field", label: "On duty" }];
export const CHECKIN_MODES_LABEL = "Where are you working today?";
export const modeLabel = (id) => (CHECKIN_MODES.find((m) => m.id === id) ?? CHECKIN_MODES[0]).label;

const DOING = { "check-in": "Checking in…", "check-out": "Checking out…", "break-start": "Starting break…", "break-end": "Ending break…" };
const DONE = { "check-in": "Checked in", "check-out": "Checked out", "break-start": "On break", "break-end": "Back from break" };
/** VITALS-SWEEP (VTI #2): a check-in button's words. In flight: "Checking in…". Accepted by Pulse while the page catches
 *  up (settled): "Checked in" at once, not "Checking in…" for the seconds the page takes to refresh. Saved on this device
 *  but not sent, or another button: its own name. */
export function pressLabel(action, idle, { doing, sending, settled }) {
  if (doing !== action) return idle;
  if (settled) return DONE[action] ?? idle;
  return sending ? DOING[action] ?? idle : idle;
}
