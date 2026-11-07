import { headers } from "next/headers";

// FLOAT-2 (device audit, 22 Oct 2026): Cloudflare's Email Obfuscation rewrote every e-mail address in Pulse's HTML
// into "[email protected]" (an <a class="__cf_email__">, a mailto: link to /cdn-cgi/l/email-protection) plus its own
// decoding script, which our CSP blocks. React then found different text while hydrating (#418) and /settings showed
// "Something glitched" on every device. The setting is off now; this guard keeps any such rewrite from breaking a page
// again: before React starts, each rewritten address is turned back into the text and link the server sent, and the
// foreign script is removed. It does nothing when nothing was rewritten.
const GUARD = `(function(){var S='.__cf_email__[data-cfemail],a[href*="/cdn-cgi/l/email-protection#"],script[src*="/cdn-cgi/scripts/"][src*="email-decode"]';
function d(h){try{var k=parseInt(h.substr(0,2),16),s="";for(var i=2;i<h.length;i+=2)s+=String.fromCharCode(parseInt(h.substr(i,2),16)^k);return decodeURIComponent(escape(s))}catch(e){return null}}
function one(n){if(!n.parentNode)return;if(n.tagName==="SCRIPT"){n.parentNode.removeChild(n);return}
var c=n.getAttribute("data-cfemail");if(c&&n.classList.contains("__cf_email__")){var t=d(c);if(t!==null){var p=n.parentNode;p.replaceChild(document.createTextNode(t),n);p.normalize()}return}
var h=n.getAttribute("href")||"",m=h.split("#")[1],e=m&&d(m);if(e)n.setAttribute("href","mailto:"+e)}
function scan(n){if(!n||n.nodeType!==1)return;if(n.matches(S))one(n);var l=n.querySelectorAll(S);for(var i=0;i<l.length;i++)one(l[i])}
new MutationObserver(function(r){for(var i=0;i<r.length;i++){var a=r[i].addedNodes;for(var j=0;j<a.length;j++)scan(a[j])}}).observe(document.documentElement,{childList:true,subtree:true});
scan(document.documentElement);document.addEventListener("DOMContentLoaded",function(){scan(document.documentElement)})})();`;

// Owner workbench UI (22 Oct 2026): the theme is on <html> before the page paints. ThemeProvider set it only after
// hydration, so a dark-mode page (most visibly one framed in the chat side panel) showed light-theme text on dark
// surfaces for seconds. Same rule as ThemeProvider: the saved choice (pulse.theme), else the system setting.
const THEME = `(function(){try{var p=localStorage.getItem("pulse.theme");var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){}})();`;

/** Owner workbench UI (22 Oct 2026): a plain inline script carrying the CSP nonce of this request. With next/script,
 *  beforeInteractive left the nonce out of the client props while browsers hide it in the DOM (nonce=""), so every page
 *  logged a hydration mismatch and pulse-dev showed the red "1 Issue" badge. Browsers always hide a nonce, so its
 *  attribute is left out of the hydration check (suppressHydrationWarning). */
export async function EmailGuard() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <>
    <script id="pulse-email-guard" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: GUARD }} />
    <script id="pulse-theme-boot" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME }} />
  </>;
}
