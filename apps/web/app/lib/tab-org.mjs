// ORG-PER-TAB (owner, 14 Nov 2026: "In one Chrome tab Vitals Technology is open, and in another tab on the same Chrome
// profile I should be able to use another company"). Each tab keeps its own company; one sign-in serves them all.
//
// - The tab remembers its company in sessionStorage (per tab; a reload or "Duplicate tab" keeps it).
// - Its calls say so: fetch and XHR send x-pulse-tab-org; EventSource, pictures, video and frames of /api/v0 and /photo
//   carry ?_o=<company> (TAB_SHIM below, before the app's own scripts run).
// - A full page load says so with a short-lived cookie (pulse_nav) set by the tab right before it leaves the page.
// - Anything else (a new tab, a bookmark, a picture in the first HTML) opens in the company of the page drawn last
//   (pulse_view, set here on every page).
// proxy.ts turns these into x-pulse-org; the API proxy and the server render pass it on; the API opens that company's
// session of the same sign-in (services/api/src/tab-session.ts) or answers "Not found" with no data.

export const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ok = (v) => (typeof v === "string" && ORG_ID.test(v) ? v : null);

/** The tab's company for one request: { org, from, doc, nav } (`from`: header | none | address | nav | view). */
export function tabOrgFor(headers, search, cookies) {
  const doc = headers.get("sec-fetch-dest") === "document" || headers.get("sec-fetch-mode") === "navigate";
  const nav = cookies.get("pulse_nav")?.value;
  const sent = headers.get("x-pulse-tab-org");
  let org = null, from = null;
  // The tab said which company (or "none": the browser's own sign-in, e.g. when it opens another company).
  if (sent !== null) { org = ok(sent); from = org ? "header" : "none"; }
  else if (ok(search.get("_o"))) { org = ok(search.get("_o")); from = "address"; }
  else if (doc && ok(nav)) { org = ok(nav); from = "nav"; }
  else if (ok(cookies.get("pulse_view")?.value)) { org = ok(cookies.get("pulse_view").value); from = "view"; }
  return { org, from, doc, nav: nav !== undefined };
}

/** Set-Cookie lines for the answer: the navigation cookie is used once; a page remembers the company it was drawn in. */
export function tabCookies(tab, page) {
  const out = [];
  if (tab.doc && tab.nav) out.push("pulse_nav=; Path=/; Secure; SameSite=Lax; Max-Age=0");
  if (page && tab.doc && tab.org && tab.from !== "view") out.push(`pulse_view=${tab.org}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return out;
}

/** The current company of an account state (the switcher's list), or null. */
export const renderedOrg = (orgs) => ok((orgs ?? []).find((o) => o.current)?.id) ?? null;

/** Runs in the page before the app (layout.tsx, with the page's nonce). data-org: the company the server drew. */
export const TAB_SHIM = `(function(){
var K="pulse.tab.org",RT="pulse.tab.retry",U=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var me=document.currentScript,R=(me&&me.getAttribute("data-org"))||"",ss=null;try{ss=window.sessionStorage}catch(e){}
function get(){try{var v=ss&&ss.getItem(K);return v&&U.test(v)?v:""}catch(e){return ""}}
function put(v){try{if(ss){if(v)ss.setItem(K,v);else ss.removeItem(K)}}catch(e){}}
function nav(o){if(!o)return;document.cookie="pulse_nav="+o+"; Path=/; Max-Age=15; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"")}
var t=get();
if(!R&&/^\\/login(\\/|$)/.test(location.pathname)){put("");t=""}
if(R&&U.test(R)&&!/^\\/at\\//.test(location.pathname)){
 if(!t){put(R);t=R}
 else if(t!==R){
  var at=0;try{at=+(ss.getItem(RT)||0)}catch(e){}
  if(Date.now()-at>15000){try{ss.setItem(RT,String(Date.now()))}catch(e){}nav(t);document.documentElement.style.visibility="hidden";location.replace(location.href);return}
  put(R);t=R
 }
}
window.__pulseTab={get:get,set:function(v){if(U.test(v||""))put(v)},clear:function(){put("")},nav:function(){nav(get())},drawn:R};
function same(u){try{var x=new URL(u,location.href);return x.origin===location.origin?x:null}catch(e){return null}}
function hint(u){var o=get();if(!o||typeof u!=="string")return u;var x=same(u);if(!x||!/^\\/(api\\/v0\\/|photo\\/)/.test(x.pathname)||x.searchParams.has("_o"))return u;x.searchParams.set("_o",o);return x.pathname+x.search+x.hash}
window.__pulseTab.hint=hint;
var F=window.fetch;
if(F)window.fetch=function(i,init){var o=get();
 try{var u=typeof i==="string"?i:(i&&i.url)||String(i);if(o&&same(u)){var h=new Headers((init&&init.headers)||(typeof i==="object"&&i.headers)||undefined);
  if(!h.has("x-pulse-tab-org")){h.set("x-pulse-tab-org",o);init=Object.assign({},init||{},{headers:h})}}}catch(e){}
 return F.call(this,i,init).then(function(r){
  try{if(r.status===404&&o&&o===get()&&r.headers.get("x-pulse-tab")==="closed"){put("");location.reload()}}catch(e){}return r})};
var XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){this.__pt=!!same(String(u));return XO.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(){var o=get();if(o&&this.__pt){try{this.setRequestHeader("x-pulse-tab-org",o)}catch(e){}}return XS.apply(this,arguments)};
var ES=window.EventSource;if(ES){var P=function(u,c){return new ES(hint(String(u)),c)};P.prototype=ES.prototype;P.CONNECTING=0;P.OPEN=1;P.CLOSED=2;window.EventSource=P}
var SA=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==="src"||n==="poster")&&typeof v==="string")v=hint(v);return SA.call(this,n,v)};
["HTMLImageElement","HTMLMediaElement","HTMLSourceElement","HTMLIFrameElement","HTMLEmbedElement","HTMLTrackElement"].forEach(function(k){var C=window[k];if(!C)return;
 var d=Object.getOwnPropertyDescriptor(C.prototype,"src");if(!d||!d.set||!d.configurable)return;
 Object.defineProperty(C.prototype,"src",{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,hint(String(v)))}})});
function link(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var x=same(a.href);if(!x)return;
 if(/^\\/(api\\/v0\\/|photo\\/)/.test(x.pathname)){var h=hint(x.pathname+x.search+x.hash);if(h!==x.pathname+x.search+x.hash)a.setAttribute("href",h);return}
 nav(get())}
document.addEventListener("click",link,true);document.addEventListener("auxclick",link,true);document.addEventListener("contextmenu",link,true);
window.addEventListener("beforeunload",function(){nav(get())});
})();`;
