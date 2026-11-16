// KAZUK-REST (slice 3; Willow Lane, early-Nov meeting: "calls stay on Connecting…", "it never says the mic is busy").
// What a call screen says when something stands in the way, in plain words, and when "Connecting…" has gone on too
// long. Pure: the call engine (calls/engine.ts) and its screen (calls/call-host.tsx) use it; unit-tested beside it.

/** How long the browser may take to hand over the microphone before Pulse says so (a permission prompt left open, or
 *  a phone whose microphone another app holds, can keep getUserMedia waiting for good). */
export const MEDIA_WAIT_MS = 15000;
/** "Connecting…" turns into "Still connecting…" after this long, and into a plain message with Try again after STUCK_MS. */
export const SLOW_MS = 12000;
export const STUCK_MS = 30000;

/** Why the microphone (or camera) could not be used, from the browser's error name. */
export function mediaReason(name) {
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "media-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "media-missing";
  // Chrome on Windows and Android says NotReadableError (TrackStartError in old versions); Firefox says AbortError.
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "media-busy";
  if (name === "TimeoutError") return "media-timeout";
  return "media-unsupported";
}

/** The message for a reason: a short title and what to do. `video` names the camera too. */
export function mediaProblem(reason, video = false) {
  const what = video ? "microphone and camera" : "microphone";
  switch (reason) {
    case "media-busy": return { reason, title: `Your ${what} ${video ? "are" : "is"} in use`,
      text: "Another app is using it: a phone call, WhatsApp, Meet, Zoom or a recorder. Close that call or app, then press Try again." };
    case "media-denied": return { reason, title: `Pulse may not use your ${what}`,
      text: `Allow the ${what} for this site (the lock or settings icon beside the address, or the phone’s app settings), then press Try again.` };
    case "media-missing": return { reason, title: video ? "No camera or microphone found" : "No microphone found",
      text: "Plug in or switch on a microphone (or headphones with one), then press Try again." };
    case "media-timeout": return { reason, title: `Your ${what} did not answer`,
      text: "Pulse waited 15 seconds. Another app may be holding it, or a permission question is still open. Close other calls, answer the question if you see one, then press Try again." };
    default: return { reason: "media-unsupported", title: "Calls can’t start in this browser",
      text: "Calls need a browser with a microphone: Chrome, Edge, Safari or Firefox, or the Pulse phone app." };
  }
}

/** Where a call that is not connected yet stands: connecting, slow (say "Still connecting…") or stuck (say why, offer
 *  Try again). `since` and `now` are milliseconds; `since` null means it is not connecting. */
export function connectStage(since, now) {
  if (since === null || since === undefined || !Number.isFinite(since) || !Number.isFinite(now)) return null;
  const waited = now - since;
  return waited >= STUCK_MS ? "stuck" : waited >= SLOW_MS ? "slow" : "connecting";
}

/** The call's status line while it connects. */
export function connectLine(stage) {
  return stage === "stuck" ? "Not connecting" : stage === "slow" ? "Still connecting…" : "Connecting…";
}

/** The message for a call that does not connect. */
export const STUCK_PROBLEM = { reason: "no-connect", title: "The call isn’t connecting",
  text: "Your network or theirs may be blocking calls (office Wi-Fi often does). Press Try again, or switch between Wi-Fi and mobile data." };

/** The message for a microphone that stopped during the call (another app took it). */
export const MIC_LOST = { reason: "mic-lost", title: "Your microphone stopped",
  text: "Another app may have taken it (a phone call or a recorder). Close it, then press Try again. The others can’t hear you until then." };

/** A promise that gives up after `ms` with a TimeoutError; what arrives late is handed to `late` (to stop a stream). */
export function withTimeout(promise, ms, late) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { done = true; const e = new Error("timed out"); e.name = "TimeoutError"; reject(e); }, ms);
    promise.then((v) => { if (done) { try { late?.(v); } catch { /* ignore */ } return; } done = true; clearTimeout(t); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(t); reject(e); });
  });
}
