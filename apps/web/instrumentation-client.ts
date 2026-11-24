// REPLAY-FIXES #1: Next calls this as it starts a move to another page (a link, router.push/replace, Back/Forward), never
// for a refresh. The screen cache (app/screen-cache.tsx) shows the screen's last copy then, so a tap is answered at once
// even when the server takes seconds. Kept tiny: it loads before the app's code.
export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse") {
  try { window.dispatchEvent(new CustomEvent("pulse:nav-start", { detail: { url, type: navigationType } })); } catch { /* never breaks a move */ }
}
