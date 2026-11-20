// AI-FIX-5 (BC-172, 20 Nov 2026): what an AI employee's run was about, in words, when the run has no text of its own to
// show (a run about a task shows the task; a run about a message shows what was asked, when the viewer is in that chat).
// Before, every such run read "A question", even a missed call, a recorded call or a colleague's answer.

/**
 * @param {string} kind     the run's event type (agent_event.event_type)
 * @param {boolean} [where] true when the conversation's name shows beside it
 * @returns {string}
 */
export function runAbout(kind, where = false) {
  if (kind.startsWith("task.")) return "A task";
  if (kind === "consult.answer") return "A colleague’s answer";
  if (kind === "call.missed") return "A missed call";
  if (kind === "call.recorded") return "A recorded call";
  if (kind === "client.silent") return "A client who went quiet";
  return where ? "A message" : "A message in a chat";
}

/**
 * A failed run the viewer may ask again (agent_runs_page's `retry`: they may change this AI employee, and the run was
 * about a message or a task).
 * @param {{ state: string, retry?: boolean | null }} r
 */
export const canRetry = (r) => r.state === "error" && r.retry === true;
