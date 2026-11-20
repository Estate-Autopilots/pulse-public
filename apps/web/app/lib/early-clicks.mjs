// DOREVE-FIX (owner, 17 Nov 2026): "Clicking does nothing for a long time." Production showed pages painted in under a
// second whose code started 23-54 s later (Datup's /tasks on 5 Nov, /my-day on 15 Nov; Estate Autopilots' p90 5-25 s on
// most days): the page looked ready, and every button click in between did nothing, with no sign of why, and telemetry
// could not see those clicks because its collector is part of the code that had not started.
// EARLY_SHIM runs from the first HTML (inline, before the app's code): it notes clicks on buttons and fields made before
// the app starts (time, tag, the rail's data-nav-id only: never text) and shows "Pulse is starting…" so a click is never
// silent. The collector calls window.__pulseEarly.off() when it starts and sends one `ui.early` row (earlyReport).
// REPLAY-FIXES #2 (REPLAY-INSIGHTS: 3 people's taps before the screen was ready, all on rail links, 0.4-1.3 s before the
// app started, were lost: the browser's own page load the tap began did not survive the app taking over). The shim now
// keeps the last tap: a tap on a link to another page of Pulse waits ("Pulse is starting…") instead of starting a full
// page load, and once the app is up the same element is pressed for real (at most EARLY_REPLAY_MS after the tap). If the
// app has not started EARLY_FALLBACK_MS after a link tap, the browser opens the link itself, as it would have. A field
// (input, select, label) is never pressed again: focusing it later is the person's own move.
export const EARLY_MAX = 20;
export const EARLY_REPLAY_MS = 10000;
export const EARLY_FALLBACK_MS = 8000;
export const EARLY_SHIM = `(function(){try{var w=window,d=document,q=w.__pulseEarly={t:[],on:1,last:null},s,fb=0;
function hint(){if(s)return;s=d.createElement("div");s.setAttribute("role","status");s.setAttribute("data-pulse-starting","");
s.textContent="Pulse is starting\\u2026 your click will work in a moment";s.style.cssText="position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483000;padding:8px 14px;border-radius:999px;background:#1f1d2b;color:#fff;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none";
(d.body||d.documentElement).appendChild(s);d.documentElement.style.cursor="progress"}
function own(el,e){try{if(e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return 0;var t=el.getAttribute("target");if(t&&t!=="_self")return 0;if(el.getAttribute("download")!==null)return 0;
var u=new URL(el.getAttribute("href")||"",w.location.href);return u.origin===w.location.origin&&(u.pathname!==w.location.pathname||u.search!==w.location.search)?u.href:0}catch(x){return 0}}
function h(e){if(!q.on)return;var el=e.target&&e.target.closest&&e.target.closest('button,[role="button"],input,select,textarea,label,summary,a[href]');if(!el)return;
var a=el.tagName==="A",now=Math.round(performance.now());if(q.t.length<${EARLY_MAX})q.t.push([now,el.tagName.toLowerCase(),String(el.getAttribute("data-nav-id")||"").slice(0,40)]);
if(a){var to=own(el,e);if(!to)return;if(e.preventDefault)e.preventDefault();q.last={el:el,at:now};clearTimeout(fb);fb=setTimeout(function(){if(q.on){q.on=0;w.location.assign(to)}},${EARLY_FALLBACK_MS});hint();return}
var tag=el.tagName;if(tag!=="INPUT"&&tag!=="SELECT"&&tag!=="TEXTAREA"&&tag!=="LABEL")q.last={el:el,at:now};hint()}
w.addEventListener("click",h,true);
q.off=function(){var was=q.on;q.on=0;clearTimeout(fb);w.removeEventListener("click",h,true);d.documentElement.style.cursor="";if(s&&s.parentNode)s.parentNode.removeChild(s);s=null;
var l=q.last;q.last=null;if(was&&l&&l.el&&l.el.isConnected&&performance.now()-l.at<${EARLY_REPLAY_MS})setTimeout(function(){try{l.el.click()}catch(x){}},0)}}catch(e){}})();`;

/** The one telemetry row for clicks made before the app started: how many, when the first and last were (ms after the
 *  page began), when the app was ready, and the longest anyone waited (ready − first). Null when there were none. */
export function earlyReport(q, readyMs) {
  const t = Array.isArray(q?.t) ? q.t.filter((c) => Array.isArray(c) && Number.isFinite(c[0])) : [];
  if (!t.length || !Number.isFinite(readyMs)) return null;
  const first = t[0][0], last = t[t.length - 1][0], ready = Math.round(readyMs);
  const buttons = t.filter((c) => c[1] !== "a").length;
  const nav = t.map((c) => c[2]).find((v) => typeof v === "string" && v);
  return { d: Math.max(0, ready - first), v: t.length, x: { first, last, ready, buttons, ...(nav ? { nav } : {}) } };
}
