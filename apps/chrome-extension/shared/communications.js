// Inbox and conversations reuse Pulse's member-scoped routes. No second chat storage.
// The shell is the companion's frame on every surface: who is signed in, a segmented Today / Inbox / Chats control
// with unread pills, one actionable banner only when a ping cannot arrive, and a messenger-style Chats tab.
import { pipSvg } from './pip.js';

export function createFeed({call,load=()=>null,save=()=>{},acknowledge=async()=>{},onSnapshot=()=>{},onPing=()=>{},onError=()=>{}}){
 let session=null,cursor=null,page=null,busy=false,epoch=0,seen=new Set();
 return {
  reset(identity){if(session===identity)return;session=identity;epoch++;const old=load(identity);cursor=old?.cursor??null;page=old?.page??null;seen=new Set(old?.seen??[]);},
  async poll(){
   if(!session||busy)return;busy=true;const generation=epoch;
   try{
    const state=await call(`companion/updates${cursor?`?since=${encodeURIComponent(cursor)}`:''}${page?`&page=${encodeURIComponent(page)}`:''}`);
    if(generation!==epoch)return;
    for(const row of state.rows){if(generation!==epoch)return;if(seen.has(row.id))continue;seen.add(row.id);if(row.pingAllowed)await onPing(row);}
    if(generation!==epoch)return;
    await acknowledge(state.rows);if(generation!==epoch)return;
    cursor=state.cursor;page=state.page;seen=new Set([...seen].slice(-2000));save(session,{cursor,page,seen:[...seen]});onSnapshot(state);
   }catch(e){if(generation===epoch)onError(e);}finally{busy=false;}
  },
 };
}

const uuid = /^[0-9a-f-]{36}$/;
export function conversationTarget(href){
 try{const u=new URL(href,'https://pulse.invalid');const id=u.searchParams.get('channel');return u.pathname==='/chats'&&uuid.test(id??'')?id:null;}catch{return null;}
}

// ------------------------------------------------------------------------------------------------ pure helpers
const SVG = {
  back: '<path d="m15 18-6-6 6-6"/>',
  send: '<path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8V5h6v5.8l2.4 3.2H6.6Z"/><path d="M8 3h8"/>',
  group: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M18 14.3c1.6.7 2.7 2.3 3 4.7"/>',
  approval: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  mention: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  decision: '<path d="M20 6 9 17l-5-5"/>',
  policy: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  holiday: '<path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/><circle cx="12" cy="12" r="4"/>',
  payroll: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  update: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.8 7L3 21l2-6.2A8 8 0 1 1 21 12Z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  hide: '<path d="m6 9 6 6 6-6"/>',
  shield: '<path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  location: '<path d="M12 21s-7-6.1-7-11a7 7 0 1 1 14 0c0 4.9-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/>',
};
export function glyph(name, size = 16) {
  return `<svg class="pc-glyph" aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${SVG[name] ?? SVG.update}</svg>`;
}

/** Up to two initials: "Asha Rao" → "AR", "pod-2" → "P2". */
export function initials(name) {
  const words = String(name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const pick = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return pick.toUpperCase();
}
/** A stable, calm hue per name so the same person always gets the same avatar colour. */
export function hueOf(text) {
  let h = 0;
  for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return [258, 200, 158, 24, 330, 214, 280, 12][h % 8];
}

/** "now", "5m", "3h", "Yesterday", "Mon", "6 Oct". */
export function shortTime(at, now = Date.now()) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const day = (x) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(now) - day(t)) / 86400000);
  if (days === 0) return `${Math.floor(s / 3600)}h`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
/** Day separator text for a message bubble group. */
export function dayLabel(at, now = Date.now()) {
  const d = new Date(Date.parse(at)), n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

const NEEDS_YOU = new Set(['approval']);
const MENTIONS = new Set(['mention', 'reply']);
/** Inbox sections in a fixed order; empty sections are dropped. */
export function inboxGroups(rows) {
  const groups = [['needs', 'Needs you', []], ['mentions', 'Mentions', []], ['updates', 'Updates', []]];
  for (const row of rows ?? []) groups[NEEDS_YOU.has(row.kind) ? 0 : MENTIONS.has(row.kind) ? 1 : 2][2].push(row);
  return groups.filter(([, , items]) => items.length).map(([id, title, items]) => ({ id, title, items }));
}
/** The one thing to do with an inbox item. */
export function primaryAction(row) {
  if (row.kind === 'approval') return 'Review';
  if (row.kind === 'mention' || row.kind === 'reply' || row.kind === 'chat') return 'Reply';
  if (row.kind === 'policy') return 'Read';
  return 'View';
}

/** Mirrors of the same audience (pod, team and Google group with one name) appear once; nothing is deleted. */
export function visibleConversations(channels, pinned = []) {
  const list = (channels ?? []).filter((c) => !c.moderationOnly && !c.duplicateOf);
  const order = (a, b) => (Date.parse(b.lastAt ?? 0) || 0) - (Date.parse(a.lastAt ?? 0) || 0) || String(a.name).localeCompare(String(b.name));
  return {
    pinned: list.filter((c) => pinned.includes(c.id)).sort(order),
    recent: list.filter((c) => !pinned.includes(c.id)).sort(order),
  };
}

// ------------------------------------------------------------------------------------------------ DOM helpers
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action, cls = 'pc-link') => { const node = element('button', text, cls); node.type = 'button'; node.addEventListener('click', action); return node; };
const iconButton = (name, label, action, cls = 'pc-icon-btn') => { const node = button(undefined, action, cls); node.insertAdjacentHTML('beforeend', glyph(name, 18)); node.setAttribute('aria-label', label); node.title = label; return node; };
function avatar(name, { group = false, size = 'md' } = {}) {
  const node = element('span', undefined, `pc-avatar pc-avatar-${size}${group ? ' pc-avatar-group' : ''}`);
  node.style.setProperty('--pc-hue', String(hueOf(name)));
  node.setAttribute('aria-hidden', 'true');
  if (group) node.insertAdjacentHTML('beforeend', glyph('group', size === 'sm' ? 14 : 18)); else node.textContent = initials(name);
  return node;
}
function pill(count, label) {
  const node = element('span', count > 99 ? '99+' : String(count), 'pc-pill');
  node.setAttribute('aria-label', `${count} ${label}`);
  return node;
}

/**
 * The companion shell. Options: call(path, body), onOpen(href), onSwitch(), onResize(), onFixPings() (or the older
 * onEnablePings()), isVisible(), platform, tools: [{ id, label, icon, onClick }], store: { get(key, fallback), set(key, value) }.
 */
export function mountCommunications(root,{call,onOpen,onSwitch,onResize=()=>{},onEnablePings,onFixPings=onEnablePings,isVisible=()=>true,platform='desktop',tools=null,store=null}){
 const shell = element('section', undefined, 'pc-communications');
 shell.dataset.platform = platform;
 // Top bar: who is signed in and the host's tools (desktop: Pulse window, Settings, Hide).
 const bar = element('header', undefined, 'pc-bar');
 const me = element('div', undefined, 'pc-me');
 const meAvatar = avatar('Pulse', { size: 'sm' }), name = element('strong', 'Pulse');
 me.append(meAvatar, name);
 bar.append(me);
 const barTools = element('div', undefined, 'pc-bar-tools');
 if (tools?.length) for (const t of tools) barTools.append(iconButton(t.icon, t.label, () => t.onClick?.(), 'pc-icon-btn'));
 else if (onSwitch) barTools.append(button('Not you? Switch account', onSwitch, 'pc-link pc-switch'));
 bar.append(barTools);
 // Segmented control with unread pills.
 const tabs = element('div', undefined, 'pc-segment');
 tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Companion sections');
 const banner = element('div', undefined, 'pc-banner'); banner.hidden = true; banner.setAttribute('role', 'alert');
 const today = element('div', undefined, 'pc-pane pc-today'), content = element('div', undefined, 'pc-pane pc-comms-content');
 today.id = 'pc-pane-today'; content.id = 'pc-pane-list';
 const notice = element('p', undefined, 'pc-ping-status'); notice.setAttribute('role', 'status');
 shell.append(bar, tabs, banner, today, content, notice);

 let tab = 'today', selected = null, selectedHref = null, channels = [], people = [], inbox = [], person = null, counts = {}, loading = false, disposed = false;
 let conversation = null, messagesHost = null, reply = null, replyStatus = null, replyBusy = false, replyKey = null, replyText = null;
 let query = '', picking = false, pingIssue = null, flash = null, flashTimer = null, viewer = null;
 const pinsKey = () => `pins.${person?.id ?? 'none'}`;
 const pins = () => { try { return store?.get(pinsKey(), []) ?? JSON.parse(localStorage.getItem(`pulse.${pinsKey()}`) ?? '[]'); } catch { return []; } };
 const savePins = (list) => { try { if (store) store.set(pinsKey(), list); else localStorage.setItem(`pulse.${pinsKey()}`, JSON.stringify(list)); } catch { /* pins last this session */ } };

 const tabButtons = {};
 for (const [key, title] of [['today', 'Today'], ['inbox', 'Inbox'], ['chats', 'Chats']]) {
  const b = element('button', undefined, 'pc-tab');
  b.type = 'button'; b.id = `pc-tab-${key}`; b.dataset.tab = key;
  b.setAttribute('aria-controls', key === 'today' ? today.id : content.id);
  b.append(element('span', title, 'pc-tab-label'));
  b.addEventListener('click', () => select(key));
  b.addEventListener('keydown', (e) => {
   const keys = ['today', 'inbox', 'chats'], i = keys.indexOf(key);
   const next = e.key === 'ArrowRight' ? keys[(i + 1) % 3] : e.key === 'ArrowLeft' ? keys[(i + 2) % 3] : e.key === 'Home' ? 'today' : e.key === 'End' ? 'chats' : null;
   if (next) { e.preventDefault(); select(next); tabButtons[next].focus(); }
  });
  tabButtons[key] = b; tabs.append(b);
 }
 function select(key) { tab = key; selected = null; selectedHref = null; picking = false; attach(); draw(); void refresh(); }

 function attach() {
  if (root.firstElementChild !== shell) root.replaceChildren(shell);
  shell.dataset.tab = tab;
  today.hidden = tab !== 'today'; content.hidden = tab === 'today';
  for (const [key, b] of Object.entries(tabButtons)) { const on = key === tab; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-current', String(on)); }
  onResize();
 }
 /** A short, transient line for things like "Sent" or "Not a member"; never a permanent footer. */
 /** One line for things like "Sent" or a browser that cannot ping yet; empty by default, never a permanent hint. */
 function status(text, { transient = false } = {}) {
  flash = text || null; notice.textContent = flash ?? ''; notice.hidden = !flash;
  clearTimeout(flashTimer); if (flash && transient) flashTimer = setTimeout(() => { flash = null; notice.textContent = ''; notice.hidden = true; onResize(); }, 6000);
  onResize();
 }
 /** The single banner, shown only while a ping cannot arrive. */
 function showPingIssue(text) {
  pingIssue = text || null; banner.replaceChildren(); banner.hidden = !pingIssue;
  if (pingIssue) {
   const icon = element('span', undefined, 'pc-banner-icon'); icon.insertAdjacentHTML('beforeend', glyph('bell', 16));
   banner.append(icon, element('span', pingIssue, 'pc-banner-text'));
   if (onFixPings) banner.append(button('Fix', () => void onFixPings(), 'pc-banner-fix'));
  }
  onResize();
 }
 function showCounts() {
  for (const key of ['inbox', 'chats']) {
   const b = tabButtons[key]; b.querySelector('.pc-pill')?.remove();
   const n = counts[key] ?? 0; if (n > 0) b.append(pill(n, key === 'chats' ? 'unread messages' : 'unread updates'));
  }
 }

 function draw() {
  attach(); showCounts(); if (tab === 'today') return;
  if (tab === 'chats' && selected) { if (conversation?.dataset.channel !== selected) drawConversation(); return; }
  conversation = null; content.replaceChildren();
  if (tab === 'inbox') drawInbox(); else if (picking) drawPeople(); else drawChats();
  onResize();
 }

 function drawInbox() {
  const groups = inboxGroups(inbox);
  if (!groups.length) {
   const empty = element('div', undefined, 'pc-empty');
   const pip = element('div', undefined, 'pc-empty-pip'); pip.innerHTML = pipSvg({ mood: 'done', size: 72, uid: 'inbox-empty' });
   empty.append(pip, element('h3', 'All caught up', 'pc-empty-title'), element('p', 'Requests, mentions and updates for you land here.', 'pc-empty-text'));
   content.append(empty); return;
  }
  for (const group of groups) {
   const section = element('section', undefined, 'pc-group');
   section.append(element('h3', group.title, 'pc-group-title'));
   const list = element('ul', undefined, 'pc-list'); list.setAttribute('aria-label', group.title);
   for (const row of group.items) {
    const li = element('li');
    const item = element('button', undefined, `pc-row pc-inbox-row${row.readAt ? '' : ' pc-unread'}`); item.type = 'button';
    const icon = element('span', undefined, `pc-kind pc-kind-${row.kind ?? 'update'}`); icon.insertAdjacentHTML('beforeend', glyph(row.kind, 16));
    const body = element('span', undefined, 'pc-row-body');
    body.append(element('span', row.title, 'pc-row-title pc-wrap'), element('time', shortTime(row.at), 'pc-row-time'));
    const action = element('span', primaryAction(row), 'pc-row-action');
    item.append(icon, body, action);
    item.setAttribute('aria-label', `${row.readAt ? '' : 'Unread. '}${row.title}. ${primaryAction(row)}`);
    item.addEventListener('click', () => void openItem(row));
    li.append(item); list.append(li);
   }
   section.append(list); content.append(section);
  }
 }

 function searchField(placeholder, onInput) {
  const wrap = element('label', undefined, 'pc-search');
  wrap.insertAdjacentHTML('beforeend', glyph('search', 15));
  const input = element('input'); input.type = 'search'; input.placeholder = placeholder; input.value = query; input.setAttribute('aria-label', placeholder);
  input.addEventListener('input', () => { query = input.value; onInput(); });
  wrap.append(input);
  return [wrap, input];
 }

 function drawChats() {
  const head = element('div', undefined, 'pc-list-head');
  const [search, input] = searchField('Search conversations', () => { const pos = input.selectionStart; draw(); const again = content.querySelector('.pc-search input'); again?.focus(); again?.setSelectionRange(pos, pos); });
  head.append(search, iconButton('compose', 'New message', () => { picking = true; query = ''; draw(); content.querySelector('.pc-search input')?.focus(); }, 'pc-icon-btn pc-compose'));
  content.append(head);
  const q = query.trim().toLowerCase();
  const { pinned, recent } = visibleConversations(channels.filter((c) => !q || String(c.name).toLowerCase().includes(q)), pins());
  if (!pinned.length && !recent.length) {
   const empty = element('div', undefined, 'pc-empty pc-empty-small');
   empty.append(element('p', q ? 'No conversation matches that name.' : 'No conversations yet. Groups you belong to appear here.', 'pc-empty-text'));
   content.append(empty); return;
  }
  for (const [title, list] of [['Pinned', pinned], ['Recent', recent]]) {
   if (!list.length) continue;
   const section = element('section', undefined, 'pc-group');
   if (pinned.length) section.append(element('h3', title, 'pc-group-title'));
   const ul = element('ul', undefined, 'pc-list'); ul.setAttribute('aria-label', title === 'Pinned' ? 'Pinned conversations' : 'Recent conversations');
   for (const ch of list) ul.append(chatRow(ch, title === 'Pinned'));
   section.append(ul); content.append(section);
  }
 }
 function chatRow(ch, isPinned) {
  const li = element('li', undefined, 'pc-chat-item');
  const row = element('button', undefined, `pc-row pc-chat-row${ch.unread ? ' pc-unread' : ''}`); row.type = 'button';
  const group = ch.kind !== 'direct';
  const body = element('span', undefined, 'pc-row-body');
  const top = element('span', undefined, 'pc-row-top');
  top.append(element('span', ch.name, 'pc-row-title'), element('time', ch.lastAt ? shortTime(ch.lastAt) : '', 'pc-row-time'));
  const bottom = element('span', undefined, 'pc-row-bottom');
  const preview = ch.preview ? `${group && ch.previewAuthor ? `${ch.previewAuthor.split(' ')[0]}: ` : ''}${ch.preview}` : group ? (ch.members ? `${ch.members} members` : 'Group') : 'Say hello';
  bottom.append(element('span', preview, 'pc-row-preview'));
  if (ch.unread) bottom.append(pill(ch.unread, 'unread'));
  body.append(top, bottom);
  row.append(avatar(ch.name, { group }), body);
  row.setAttribute('aria-label', `${ch.name}${ch.unread ? ` · ${ch.unread} unread` : ''}`);
  const described = `pc-preview-${ch.id}`; bottom.firstElementChild.id = described; row.setAttribute('aria-describedby', described);
  row.addEventListener('click', () => { selected = ch.id; selectedHref = null; drawConversation(); void loadMessages(); });
  const pin = iconButton('pin', isPinned ? `Unpin ${ch.name}` : `Pin ${ch.name}`, () => { const list = pins(); savePins(isPinned ? list.filter((x) => x !== ch.id) : [...list, ch.id].slice(-12)); draw(); }, `pc-icon-btn pc-pin${isPinned ? ' pc-pinned' : ''}`);
  li.append(row, pin);
  return li;
 }
 function drawPeople() {
  const head = element('div', undefined, 'pc-list-head');
  const back = iconButton('back', 'Back to chats', () => { picking = false; query = ''; draw(); }, 'pc-icon-btn');
  const [search, input] = searchField('Who do you want to message?', () => { const pos = input.selectionStart; draw(); const again = content.querySelector('.pc-search input'); again?.focus(); again?.setSelectionRange(pos, pos); });
  head.append(back, search);
  content.append(head, element('h3', 'New message', 'pc-group-title'));
  const q = query.trim().toLowerCase();
  const list = element('ul', undefined, 'pc-list'); list.setAttribute('aria-label', 'People');
  for (const p of people.filter((x) => x.id !== viewer && (!q || String(x.name).toLowerCase().includes(q))).slice(0, 40)) {
   const li = element('li');
   const row = element('button', undefined, 'pc-row'); row.type = 'button';
   const body = element('span', undefined, 'pc-row-body');
   body.append(element('span', p.name, 'pc-row-title'), element('span', [p.team, p.pod].filter(Boolean).join(' · '), 'pc-row-preview'));
   row.append(avatar(p.name), body);
   row.addEventListener('click', () => void startDirect(p));
   li.append(row); list.append(li);
  }
  if (!list.childElementCount) content.append(element('p', 'Nobody matches that name.', 'pc-empty-text')); else content.append(list);
 }
 async function startDirect(p) {
  try { const r = await call('chats/direct', { personId: p.id }); picking = false; query = ''; selected = r.id; selectedHref = null; tab = 'chats'; await refreshChannels(); drawConversation(); await loadMessages(); }
  catch (e) { status(e.message || 'Could not start this conversation.'); }
 }

 async function read(row) { try { await call('companion/read', { id: row.id }); row.readAt = new Date().toISOString(); counts = { ...counts, inbox: Math.max(0, (counts.inbox ?? 1) - 1) }; } catch (e) { status(e.message); } }
 async function openItem(row) {
  if (!row.readAt) await read(row);
  const id = conversationTarget(row.href);
  if (id && !row.href.includes('thread=')) { tab = 'chats'; selected = id; selectedHref = row.href; draw(); await loadMessages(); }
  else { draw(); onOpen(row.href); }
 }

 function drawConversation() {
  conversation = element('section', undefined, 'pc-conversation-view'); conversation.dataset.channel = selected;
  const ch = channels.find((c) => c.id === selected);
  const head = element('header', undefined, 'pc-convo-head');
  const title = element('div', undefined, 'pc-convo-title');
  title.append(element('strong', ch?.name ?? 'Conversation'), element('span', ch && ch.kind !== 'direct' ? (ch.members ? `${ch.members} members` : 'Group') : 'Direct message', 'pc-convo-sub'));
  head.append(
   iconButton('back', 'Back to chats', () => { selected = null; draw(); }, 'pc-icon-btn pc-back'),
   avatar(ch?.name ?? 'Conversation', { group: !!ch && ch.kind !== 'direct', size: 'sm' }), title,
   iconButton('open', 'Open in Pulse for files and threads', () => onOpen(selectedHref ?? `/chats?channel=${selected}`), 'pc-icon-btn'),
  );
  messagesHost = element('div', undefined, 'pc-messages'); messagesHost.setAttribute('role', 'log'); messagesHost.setAttribute('aria-label', 'Recent messages'); messagesHost.tabIndex = 0;
  const form = element('form', undefined, 'pc-composer');
  reply = element('textarea'); reply.maxLength = 12000; reply.rows = 1; reply.placeholder = `Message ${ch?.name ?? ''}`.trim(); reply.setAttribute('aria-label', 'Quick reply');
  reply.addEventListener('input', grow);
  reply.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  const send = element('button', undefined, 'pc-send'); send.type = 'submit'; send.setAttribute('aria-label', 'Send'); send.insertAdjacentHTML('beforeend', glyph('send', 18));
  replyStatus = element('p', undefined, 'pc-composer-status'); replyStatus.setAttribute('role', 'status');
  form.append(reply, send);
  form.addEventListener('submit', (event) => { event.preventDefault(); void sendReply(send); });
  conversation.append(head, messagesHost, form, replyStatus);
  content.replaceChildren(conversation); attach(); onResize();
  reply.focus({ preventScroll: true });
 }
 function grow() { reply.style.height = 'auto'; reply.style.height = `${Math.min(reply.scrollHeight, 96)}px`; onResize(); }

 function drawMessages(messages) {
  messagesHost.replaceChildren();
  if (!messages.length) { messagesHost.append(element('p', 'No messages yet. Say hello.', 'pc-empty-text pc-center')); return; }
  let lastDay = '', lastAuthor = '', lastAt = 0;
  for (const m of messages) {
   const at = Date.parse(m.createdAt), day = dayLabel(m.createdAt);
   if (day !== lastDay) { const sep = element('div', undefined, 'pc-day'); sep.append(element('span', day)); messagesHost.append(sep); lastDay = day; lastAuthor = ''; }
   const mine = !!viewer && m.authorId === viewer;
   const continued = m.authorId === lastAuthor && at - lastAt < 5 * 60000;
   const bubble = element('article', undefined, `pc-bubble${mine ? ' pc-mine' : ''}${continued ? ' pc-continued' : ''}`);
   if (!mine && !continued) bubble.append(element('strong', m.name, 'pc-bubble-name'));
   bubble.append(element('p', m.removed ? 'Message removed' : m.body, m.removed ? 'pc-removed' : undefined));
   const meta = element('span', undefined, 'pc-bubble-meta');
   if (m.attachments?.length || m.replies) meta.append(element('span', [m.attachments?.length ? `${m.attachments.length} file${m.attachments.length > 1 ? 's' : ''}` : '', m.replies ? `${m.replies} repl${m.replies > 1 ? 'ies' : 'y'}` : ''].filter(Boolean).join(' · ')));
   meta.append(element('time', new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
   bubble.append(meta);
   messagesHost.append(bubble);
   lastAuthor = m.authorId; lastAt = at;
  }
 }
 async function loadMessages() {
  const id = selected; if (!id || replyBusy) return;
  try {
   const result = await call(`chats/${id}/messages`); if (disposed || id !== selected || !messagesHost || !isVisible()) return;
   drawMessages(result.messages.slice(-40));
   const last = result.messages.at(-1); if (last) await call(`chats/${id}/read`, { through: last.createdAt });
   const ch = channels.find((c) => c.id === id); if (ch?.unread) { counts = { ...counts, chats: Math.max(0, (counts.chats ?? 0) - ch.unread) }; ch.unread = 0; showCounts(); }
   messagesHost.scrollTop = messagesHost.scrollHeight; onResize();
  } catch (e) { status(e.status === 403 || e.status === 404 ? 'You are not a member of this conversation with this account.' : e.message); }
 }
 async function sendReply(send) {
  if (replyBusy || !reply.value.trim() || !selected) return;
  const id = selected, text = reply.value.trim(); replyBusy = true; send.disabled = true; reply.disabled = true; if (replyText !== text) { replyKey = null; replyText = text; } replyKey ??= crypto.randomUUID();
  try { await call(`chats/${id}/messages`, { body: text, clientId: replyKey }); reply.value = ''; replyKey = null; replyStatus.textContent = ''; grow(); }
  catch (e) { replyStatus.textContent = e.message || 'Reply could not be sent. Your draft is kept.'; }
  finally { replyBusy = false; send.disabled = false; reply.disabled = false; reply.focus({ preventScroll: true }); await loadMessages(); }
 }

 async function refreshChannels() {
  const r = await call('chats');
  channels = (r.channels ?? []).filter((c) => !c.moderationOnly); people = r.people ?? people; viewer = r.viewer ?? viewer;
 }
 async function refresh() {
  if (loading || disposed || !isVisible()) return; loading = true; const before = JSON.stringify(tab === 'inbox' ? inbox : channels);
  try {
   if (tab === 'inbox') inbox = (await call('companion/inbox')).rows;
   if (tab === 'chats') { await refreshChannels(); if (selected) await loadMessages(); }
   if (!disposed && before !== JSON.stringify(tab === 'inbox' ? inbox : channels) && !(tab === 'chats' && (selected || picking || content.contains(document.activeElement)))) draw();
  } catch (e) { status(e.message); } finally { loading = false; }
 }
 status(null);
 return {todayHost:today,attach,refresh,status,pingIssue:showPingIssue,
  snapshot(state){
   if(person&&state.person?.id!==person.id){inbox=[];channels=[];selected=null;selectedHref=null;conversation=null;tab='today';}
   person=state.person;viewer=person?.id??viewer;name.textContent=person?.name??'Pulse';meAvatar.textContent=initials(person?.name??'Pulse');meAvatar.style.setProperty('--pc-hue',String(hueOf(person?.name)));
   counts=state.counts??{};showCounts();
   if(state.suppression)status(state.suppression);void refresh();
  },
  showInbox(){tab='inbox';selected=null;selectedHref=null;draw();void refresh();},
  showToday(){select('today');},
  showChats(){select('chats');},
  // A ping or link can open a conversation before the list has loaded: load it first so the header has its name.
  async open(id,href){selectedHref=href??null;tab='chats';selected=id;if(!channels.some(c=>c.id===id)){try{await refreshChannels();}catch{/* the header stays generic */}}if(selected!==id)return;conversation=null;draw();void loadMessages();},
  destroy(){disposed=true;clearTimeout(flashTimer);},
 };
}

/** Notification preferences as plain rows, for the desktop Settings sheet and the Chrome settings view. */
export const PING_TYPES = { chat: ['Group and direct messages', 'New messages in conversations you belong to'], mention: ['Mentions', 'When someone @mentions you'], reply: ['Thread replies', 'Replies in threads you take part in'], approval: ['Approvals waiting', 'Requests that need your decision'], decision: ['Request decisions', 'When your leave or correction is decided'], policy: ['Policy updates', 'New or changed company policies'], holiday: ['Holidays', 'Upcoming holidays and changes'], payroll: ['Salary credited', 'When payroll is processed'], task: ['Task assignments', 'Work assigned to you'], update: ['Other updates', 'Anything else Pulse tells you'] };
