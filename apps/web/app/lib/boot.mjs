// SPEED-NET (owner, 16 Nov 2026: "It's so slow for me to load"): from India every request crosses Cloudflare's Marseille
// or Singapore location before it reaches the server in Kuala Lumpur, 0.3-0.8 s a round trip, while the server answers in
// 10-60 ms. A page load asked for the shell's own data (badges, check-in, what's new, notification settings, policies due,
// the task companion, the insights rail…) in 10-16 separate calls, in two or three waves one after the other, and asked
// for some of them two or three times. Now:
//   * The page starts ONE call, GET /api/v0/boot?k=…, from its first HTML (BOOT_SHIM, before the app's code arrives); the
//     web server (api/proxy.mjs) asks the API for each part next to it (a few ms each) and answers them together.
//   * When a part of the shell then asks for one of those addresses, it gets the boot's answer (fresh: at most 10 s
//     old, and only until anything is saved), with no round trip. A slow phone's app starts seconds after the boot
//     answered; past that, the part asks the network itself.
//   * Two parts asking for the same shell address at once share one request, and an answer just received (REUSE_MS) is
//     handed to the next asker; anything saved forgets those.
// Keys are API addresses after /api/v0/, with their query, exactly as the shell's parts ask for them.

/** Addresses the boot may read: the shell's own start-up reads, nothing that writes or that only a page needs. */
export const BOOT_FIXED = Object.freeze(["whats-new/unseen", "companion/notification-settings", "telemetry/settings", "tasks/reviews/count",
  "companion", "companion?visible=0", "presence", "presence?touch=1", "freshness", "companion/updates", "briefs/tick", "work/companion",
  "agreements/policies?due=1", "mailbox"]);
export const BOOT_MAX = 16, BOOT_PARALLEL = 5;

/** The insights rail's read for a page (intelligence/rail.tsx builds it the same way), or null. */
export function railKey(pathname, search) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 200) return null;
  const s = new URLSearchParams(search ?? "");
  const q = new URLSearchParams({ path: pathname, tab: s.get("tab") ?? "" });
  const subject = s.get("task") ?? s.get("location");
  if (subject) q.set("subject", subject);
  return `intelligence?${q}`;
}

/** `raw` when the boot may read it, else null. */
export function bootKey(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 400) return null;
  if (BOOT_FIXED.includes(raw)) return raw;
  if (!raw.startsWith("intelligence?")) return null;
  const q = new URLSearchParams(raw.slice("intelligence?".length));
  const names = [...q.keys()];
  if (names.some((n) => !["path", "tab", "subject"].includes(n)) || new Set(names).size !== names.length) return null;
  const path = q.get("path"), tab = q.get("tab"), subject = q.get("subject");
  if (path === null || tab === null || !path.startsWith("/") || path.length > 200 || tab.length > 60 || (subject ?? "").length > 80 || /[\s\\]/.test(path)) return null;
  // Only the rail's own spelling of it (path, tab, then subject), so the rail's ask matches the boot's key.
  const again = new URLSearchParams({ path, tab });
  if (subject !== null) again.set("subject", subject);
  return `intelligence?${again}` === raw ? raw : null;
}

/** The keys a boot request asks for (?k=…), allowed and once each, at most BOOT_MAX. */
export function bootKeys(searchParams) {
  const out = [];
  for (const k of searchParams.getAll("k")) {
    const ok = bootKey(k);
    if (ok && !out.includes(ok)) out.push(ok);
    if (out.length >= BOOT_MAX) break;
  }
  return out;
}

/** The shell's start-up reads for a signed-in person (layout.tsx knows which parts it draws for them). */
export function shellBootKeys({ staff, admin = false, off = [] }) {
  const keys = ["whats-new/unseen", "companion/notification-settings", "telemetry/settings"];
  if (!off.includes("tasks")) keys.push("tasks/reviews/count");
  if (staff) {
    keys.push("companion", "presence?touch=1", "freshness", "companion/updates");
    // ERROR-SWEEP: a company with Briefs switched off answers 404 here (by design), once per page start.
    if (!off.includes("briefs")) keys.push("briefs/tick");
    if (!off.includes("tasks")) keys.push("work/companion");
    if (!off.includes("hr")) keys.push("agreements/policies?due=1");
    if (admin) keys.push("mailbox");
  }
  return keys;
}

/** Asks the API for every key at once (fetchOne(key) → its Response) and answers {v, r: {key: {s, b, t?}}}: each
 *  JSON answer's status and body as the API gave them. A part that fails or is not JSON is left out (it asks for itself);
 *  `t: "closed"` keeps ORG-PER-TAB's "this tab's company is closed" answer, which the page must see from the real call. */
export async function bootAnswer(keys, fetchOne, limit = BOOT_PARALLEL) {
  const r = {};
  let next = 0;
  // At most `limit` parts at once: the API's pool has 10 clients (three are its listeners'), so a boot never holds all
  // of them while other people's calls wait (each part takes 10-120 ms; the whole boot stays far under one round trip).
  const worker = async () => {
    while (next < keys.length) {
      const k = keys[next++];
      try {
        const up = await fetchOne(k);
        const text = await up.text();
        if (!/^application\/json/i.test(up.headers.get("content-type") ?? "")) continue;
        r[k] = { s: up.status, b: text, ...(up.headers.get("x-pulse-tab") === "closed" ? { t: "closed" } : {}) };
      } catch { /* that part asks for itself */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, keys.length)) }, worker));
  return { v: 1, r };
}

/** Runs in the page before the app (layout.tsx, after ORG-PER-TAB's TAB_SHIM so the boot call carries the tab's company,
 *  with the page's nonce). Off in a browser driven by tests (navigator.webdriver): the browser specs stand in for single
 *  API addresses (page.route), which a boot answered by the server would go around; a spec or the lab turns it on with
 *  localStorage "pulse.boot" = "on". "off" switches it off on one device; PULSE_BOOT=0 on the server for everyone. data-keys: the shell's start-up reads (shellBootKeys); data-rail: the insights rail is drawn.
 *  window.__pulseBoot keeps the numbers telemetry reports (perf.boot): when it started and answered, how many parts it
 *  answered for the page, how many asks were shared. Answers it hands out carry x-pulse-boot: 1 or x-pulse-shared: 1. */
export const BOOT_SHIM = `(function(){
var W=window,F=W.fetch,me=document.currentScript;if(!F||W.__pulseBoot||typeof Response!=="function")return;
if(document.documentElement.style.visibility==="hidden")return;
var force=null;try{force=localStorage.getItem("pulse.boot")}catch(e){}
if(force==="off"||(force!=="on"&&W.navigator&&W.navigator.webdriver))return;
var P="/api/v0/",TTL=${10000},REUSE=${2000},keys=[];
try{keys=JSON.parse((me&&me.getAttribute("data-keys"))||"[]")}catch(e){keys=[]}
var hidden=document.visibilityState==="hidden";
keys=keys.map(function(k){return hidden&&k==="companion"?"companion?visible=0":hidden&&k==="presence?touch=1"?"presence":k}).filter(function(k){
 if(k!=="telemetry/settings")return true;try{var s=JSON.parse(sessionStorage.getItem("pulse.telemetry.settings")||"null");return !(s&&Date.now()-s.at<600000)}catch(e){return true}});
if(me&&me.getAttribute("data-rail")==="1"){try{var s=new URLSearchParams(location.search),q=new URLSearchParams({path:location.pathname,tab:s.get("tab")||""}),sub=s.get("task")||s.get("location");if(sub)q.set("subject",sub);keys.push("intelligence?"+q)}catch(e){}}
var B={t0:performance.now(),t1:0,s:0,keys:keys.length,served:0,shared:0,at:0,saved:false};W.__pulseBoot=B;
var got=Promise.resolve({});
if(keys.length)got=Promise.race([F.call(W,P+"boot?"+keys.map(function(k){return "k="+encodeURIComponent(k)}).join("&"),{cache:"no-store",credentials:"same-origin"})
 .then(function(r){B.s=r.status;return r.ok?r.json():null}).then(function(d){B.t1=performance.now();B.at=Date.now();return (d&&d.r)||{}},function(){B.t1=performance.now();return {}}),
 new Promise(function(done){setTimeout(function(){if(!B.at)B.late=true;done({})},${5000})})]);
var flight={},recent={};
function mk(e,mark){var h=new Headers({"content-type":e.ct||"application/json"});if(mark)h.set(mark,"1");else if(e.st)h.set("server-timing",e.st);return new Response(e.s===204||e.s===205||e.s===304?null:e.b,{status:e.s,headers:h})}
function usable(e){return !!e&&!e.t&&e.s>=200&&e.s<500&&e.s!==429&&e.s!==204&&e.s!==205}
var SHARE=/^(whats-new\\/unseen|companion\\/notification-settings|telemetry\\/settings|tasks\\/reviews\\/count|companion|companion\\?visible=0|presence|presence\\?touch=1|freshness|briefs\\/tick|work\\/companion|agreements\\/policies\\?due=1|mailbox|notices)$/;
function plain(init,sig){if(!init)return true;if(init.body!=null||(init.signal&&!sig))return false;var ok=true;if(init.headers){try{new Headers(init.headers).forEach(function(v,n){if(n!=="content-type"&&n!=="accept"&&n!=="x-pulse-request-id")ok=false})}catch(e){ok=false}}return ok}
function share(self,args,k){
 var r=recent[k];if(r&&Date.now()-r.at<REUSE){B.shared++;return Promise.resolve(mk(r.e,"x-pulse-shared"))}
 if(flight[k]){B.shared++;return flight[k].then(function(e){return e?mk(e,"x-pulse-shared"):F.apply(self,args)})}
 var p=F.apply(self,args).then(function(res){return res.text().then(function(b){return {s:res.status,b:b,ct:res.headers.get("content-type"),st:res.headers.get("server-timing")}})});
 flight[k]=p.then(function(e){delete flight[k];if(e.s>=200&&e.s<300)recent[k]={at:Date.now(),e:e};return e},function(){delete flight[k];return null});
 return p.then(function(e){return mk(e,null)});
}
W.fetch=function(i,init){
 var k=null,m="GET",str=typeof i==="string"||(typeof URL==="function"&&i instanceof URL);
 try{var u=new URL(str?String(i):(i&&i.url)||"",location.href);m=String((init&&init.method)||(!str&&i&&i.method)||"GET").toUpperCase();
  if(u.origin===location.origin&&u.pathname.indexOf(P)===0)k=u.pathname.slice(P.length)+u.search}catch(e){}
 if(k===null)return F.apply(this,arguments);
 if(m!=="GET"){if(m!=="HEAD"&&k!=="telemetry"&&k!=="companion/web-push"){recent={};B.saved=true}return F.apply(this,arguments)}
 if(!str||!plain(init,true))return F.apply(this,arguments);
 var self=this,args=arguments,sig=init&&init.signal,alone=!plain(init,false);
 // A call with its own signal (the insights rail, the check-in queue's time limit) may take the boot's answer; it is
 // never shared with another asker (one of them may give up).
 if(!B.saved&&keys.indexOf(k)>=0&&(!B.at||Date.now()-B.at<TTL))return got.then(function(map){var e=map[k];
  if(usable(e)&&!B.saved&&Date.now()-B.at<TTL&&!(sig&&sig.aborted)){B.served++;return mk(e,"x-pulse-boot")}return SHARE.test(k)&&!alone?share(self,args,k):F.apply(self,args)});
 return SHARE.test(k)&&!alone?share(self,args,k):F.apply(this,arguments);
};
})();`;
