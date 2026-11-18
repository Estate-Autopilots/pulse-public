// PHONE-QA: drive a phone's Chrome tab or the Pulse QA WebView over the DevTools protocol (adb forward).
//   node tools/qa/phone-qa/phone-cdp.mjs <port> <urlSubstring> <command> [args...]
// commands: url | eval <js> | fill <label text> <value> | click <exact text> | goto <url> | text
// fill finds an input by its <label> text (or placeholder / aria-label) and sets it the way React sees typing.
const [port, match, cmd, ...args] = process.argv.slice(2);
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, Number(process.env.CDP_TIMEOUT ?? 25000)).unref?.();
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find((t) => t.type === 'page' && t.url.includes(match ?? '')) ?? tabs.find((t) => t.type === 'page');
if (!tab) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const waits = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.result; };
const HELPERS = `
const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim();
const visible=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
const byLabel=(t)=>{for(const l of document.querySelectorAll('label')){if(norm(l.textContent).toLowerCase().startsWith(t.toLowerCase())){const f=l.htmlFor?document.getElementById(l.htmlFor):l.querySelector('input,textarea,select');if(f)return f;const n=l.parentElement?.querySelector('input,textarea,select');if(n)return n;}}
 return [...document.querySelectorAll('input,textarea,select')].find(e=>visible(e)&&[e.placeholder,e.getAttribute('aria-label'),e.name].some(v=>v&&v.toLowerCase().includes(t.toLowerCase())));};
const setVal=(e,v)=>{const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
const byText=(t)=>{const all=[...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],[role=option],summary,label,li,span,div')].filter(visible);
 return all.find(e=>norm(e.textContent)===t&&/^(BUTTON|A|SUMMARY)$/.test(e.tagName))||all.find(e=>norm(e.getAttribute('aria-label'))===t)||all.find(e=>norm(e.textContent)===t)||all.find(e=>/^(BUTTON|A)$/.test(e.tagName)&&norm(e.textContent).startsWith(t));};`;
let out;
if (cmd === 'url') out = tab.url;
else if (cmd === 'eval') out = await ev(args[0]);
else if (cmd === 'goto') { await send('Page.navigate', { url: args[0] }); out = 'ok'; }
else if (cmd === 'text') out = await ev(`(document.querySelector('main')||document.body).innerText.slice(0, ${Number(args[0] ?? 3000)})`);
else if (cmd === 'fill') out = await ev(`(()=>{${HELPERS};const e=byLabel(${JSON.stringify(args[0])});if(!e)return 'NOT FOUND';e.focus();setVal(e,${JSON.stringify(args[1])});return 'ok '+e.tagName+' '+(e.name||e.id);})()`);
else if (cmd === 'click') out = await ev(`(()=>{${HELPERS};const e=byText(${JSON.stringify(args[0])});if(!e)return 'NOT FOUND';e.scrollIntoView({block:'center'});e.click();return 'ok '+e.tagName+' '+norm(e.textContent).slice(0,60);})()`);
console.log(typeof out === 'string' ? out : JSON.stringify(out));
ws.close(); process.exit(0);
