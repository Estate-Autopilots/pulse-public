// R47: read a WhatsApp "Export chat" text file (exported without media) into messages. The preview in the browser and
// the API's approved import run this same code, so what the owner approved is what the server writes. Plain ESM, no
// dependencies; hashing uses Web Crypto (browsers and Node).
// Nothing here reads media, logs in to WhatsApp or fetches anything: the input is the text file a person exported.

export const PARSER = 'whatsapp-text/1';
export const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, messages: 100000, body: 12000, sender: 80 });

export class ExportError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const SP = '[ \\u00a0\\u202f]';
// 12/10/2026, 14:05 · 12.10.26, 2:05 pm · 2026-10-12 14:05:33 · 10/12/26, 2:05 PM (newer phones use a narrow space)
const STAMP = `(\\d{1,4})[./-](\\d{1,2})[./-](\\d{1,4}),?${SP}(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?(?:${SP}?([aApP])\\.?${SP}?[mM]\\.?)?`;
const ANDROID = new RegExp(`^${STAMP}${SP}[-–]${SP}(.*)$`);
const IOS = new RegExp(`^\\u200e?\\[${STAMP}\\]${SP}(.*)$`);
const LEADING_MARKS = /^[‎‏]+/;
const LABEL_MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;
const EDITED = /\s*‎?<This message was edited>\s*$/;
const DELETED = /^(?:this message was deleted|you deleted this message)\.?$/i;
// A photo, video, voice note, sticker, document or contact: only its place in the conversation is kept, never the
// file, its name or a transcription. A caption written under it is the sender's text and stays.
const MEDIA = [
  /^<(?:media omitted|medien ausgeschlossen|mídia oculta|multimedia omitido|médias omis|मीडिया छोड़ा गया)>$/i,
  /^(?:image|video|audio|sticker|gif|document|contact card|view once \w+) omitted$/i,
  /(?:^|\s)document omitted$/i,
  /<attached: [^>]*>/i,
  /\(file attached\)$/i,
];
const PHONE = /^\+?[\d\s\-().]{7,24}$/;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const isMedia = (line) => MEDIA.some((re) => re.test(line));

/** The export's text: UTF-8 only (a .zip with media, or any other file, is refused before anything is read). */
export function decodeExport(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ExportError('not_text', 'Choose the exported .txt file');
  if (bytes.length === 0) throw new ExportError('empty', 'The file is empty');
  if (bytes.length > LIMITS.bytes) throw new ExportError('too_large', 'Choose an export up to 8 MB (export without media)');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new ExportError('not_text', 'This is a .zip: export the chat without media and choose the .txt file inside');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ExportError('not_utf8', 'This file is not a WhatsApp text export'); }
}

export function validZone(zone) {
  try { formatter(zone); return typeof zone === 'string' && zone.length > 0; } catch { return false; }
}

const formats = new Map();
function formatter(zone) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(zone, f);
  }
  return f;
}
function offsetAt(zone, ms) {
  const p = {};
  for (const { type, value } of formatter(zone).formatToParts(new Date(ms))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
/** A wall-clock time in a zone as an instant. Around a clock change a time can happen twice (the earlier is used) or
 *  not at all (read with the offset before the change); both are reported, never silently guessed. */
export function zonedToUtc(wall, zone, cache = new Map()) {
  const slot = zone + '|' + Math.floor(wall / 1800000);
  let offsets = cache.get(slot);
  if (!offsets) { offsets = [offsetAt(zone, wall - 43200000), offsetAt(zone, wall + 43200000)]; cache.set(slot, offsets); }
  const candidates = [...new Set(offsets.map((o) => wall - o))];
  const valid = candidates.length === 1 ? candidates : candidates.filter((t) => offsetAt(zone, t) === wall - t);
  if (valid.length === 1) return { ms: valid[0], time: 'exact' };
  if (valid.length > 1) return { ms: Math.min(...valid), time: 'ambiguous' };
  return { ms: wall - offsets[0], time: 'missing' };
}

function stampOf(m) {
  return { a: m[1], b: m[2], c: m[3], h: +m[4], mi: +m[5], s: m[6] === undefined ? 0 : +m[6], ap: m[7] ? m[7].toLowerCase() : null };
}
function wallOf(st, order) {
  let y, mo, d;
  if (order === 'ymd') { if (st.a.length !== 4) return null; [y, mo, d] = [+st.a, +st.b, +st.c]; }
  else {
    if (st.a.length > 2 || st.b.length > 2 || (st.c.length !== 2 && st.c.length !== 4)) return null;
    y = st.c.length === 2 ? 2000 + +st.c : +st.c;
    [d, mo] = order === 'dmy' ? [+st.a, +st.b] : [+st.b, +st.a];
  }
  let h = st.h;
  if (st.ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (st.ap === 'p' ? 12 : 0); }
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || st.mi > 59 || st.s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, st.mi, st.s);
  if (new Date(ms).getUTCDate() !== d) return null; // 31 April and friends
  return { ms, local: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(st.mi)}:${pad(st.s)}` };
}
function backwards(stamps, order) {
  let n = 0, last = -Infinity;
  for (const st of stamps) { const w = wallOf(st, order); if (!w) continue; if (w.ms < last) n++; last = w.ms; }
  return n;
}
/** Day-first or month-first: decided by the dates themselves when one of them says so (a 13 or more), else the order
 *  that keeps the conversation in time order, reported as a guess. */
export function detectDateOrder(stamps) {
  if (stamps.length && stamps.every((s) => s.a.length === 4)) return { order: 'ymd', certain: true };
  const dayFirst = stamps.some((s) => +s.a > 12), monthFirst = stamps.some((s) => +s.b > 12);
  if (dayFirst && monthFirst) return { order: null, certain: false };
  if (dayFirst) return { order: 'dmy', certain: true };
  if (monthFirst) return { order: 'mdy', certain: true };
  const order = backwards(stamps, 'mdy') < backwards(stamps, 'dmy') ? 'mdy' : 'dmy';
  return { order, certain: false };
}

export function cleanLabel(raw) {
  return raw.normalize('NFC').replace(LABEL_MARKS, '').replace(/[\s  ]+/g, ' ').trim();
}
export function isPhoneLabel(label) {
  return PHONE.test(label) && label.replace(/\D/g, '').length >= 7;
}
/** How a sender who is only a phone number is shown and stored: never the number. */
export function displayLabel(label) {
  return isPhoneLabel(label) ? 'Number ending ' + label.replace(/\D/g, '').slice(-3) : label;
}

function classify(raw, ios) {
  let body = raw.normalize('NFC');
  const marked = LEADING_MARKS.test(body);
  body = body.replace(LEADING_MARKS, '');
  let edited = false;
  if (EDITED.test(body)) { edited = true; body = body.replace(EDITED, ''); }
  body = body.replace(/\s+$/, '');
  const [first, ...rest] = body.split('\n');
  const firstLine = first.replace(LEADING_MARKS, '').trim();
  if (DELETED.test(firstLine) && rest.length === 0) return { kind: 'deleted', body: '', edited };
  if (isMedia(firstLine)) return { kind: 'media', body: rest.join('\n').trim(), edited };
  // iOS marks lines Pulse should not import (group changes, the encryption notice) with a direction mark.
  if (ios && marked) return { kind: 'system', body, edited };
  if (!body.trim()) return { kind: 'system', body: '', edited };
  return { kind: 'text', body, edited };
}

/**
 * Read an export. `timeZone` is the zone of the phone that exported it (its times are that phone's wall clock);
 * `dateOrder` is 'auto', 'dmy', 'mdy' or 'ymd'.
 */
export function parseWhatsAppExport(text, { timeZone, dateOrder = 'auto' } = {}) {
  if (typeof text !== 'string') throw new ExportError('not_text', 'Choose the exported .txt file');
  if (!validZone(timeZone)) throw new ExportError('zone', 'Choose the time zone of the phone that exported the chat');
  if (!['auto', 'dmy', 'mdy', 'ymd'].includes(dateOrder)) throw new ExportError('date_order', 'Choose how dates are written');
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ios = /^‎?\[/.test(line), m = (ios ? IOS : ANDROID).exec(line);
    if (m) heads.push({ i, ios, stamp: stampOf(m), rest: m[8] });
  }
  if (!heads.length) throw new ExportError('not_whatsapp', 'No WhatsApp messages found: choose the .txt file from “Export chat”');
  const detected = detectDateOrder(heads.map((h) => h.stamp));
  const order = dateOrder === 'auto' ? detected.order : dateOrder;
  if (!order) throw new ExportError('date_order', 'Dates in this file are written both day-first and month-first; choose how they are written');
  const warnings = [], cache = new Map();
  const counts = { badStamp: 0, ambiguous: 0, missing: 0, long: 0, firstBadStamp: null, firstUncertain: null };
  const messages = [];
  let current = null, h = 0, before = 0;
  const close = () => {
    if (!current) return;
    const c = current.sender === null ? { kind: 'system', body: current.raw, edited: false } : classify(current.raw, current.ios);
    let body = c.body;
    if (body.length > LIMITS.body) { body = body.slice(0, LIMITS.body); counts.long++; }
    messages.push({ line: current.line, local: current.local, at: current.at, time: current.time, sender: current.sender, kind: c.kind, body, edited: c.edited });
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const head = heads[h] && heads[h].i === i ? heads[h++] : null;
    const wall = head && wallOf(head.stamp, order);
    if (head && !wall) { counts.badStamp++; counts.firstBadStamp ??= i + 1; }
    if (!wall) {
      if (current) current.raw += '\n' + lines[i];
      else before++;
      continue;
    }
    close();
    const { ms, time } = zonedToUtc(wall.ms, timeZone, cache);
    if (time !== 'exact') { counts[time]++; counts.firstUncertain ??= i + 1; }
    let sender = null, raw = head.rest;
    const colon = raw.indexOf(': ');
    if (colon > 0) {
      const label = cleanLabel(raw.slice(0, colon));
      // An Android group notice ("Ravi changed the subject to “a: b”") is not a sender.
      if (label && label.length <= LIMITS.sender && !/["“”]/.test(label)) { sender = label; raw = raw.slice(colon + 2); }
    }
    current = { line: i + 1, local: wall.local, at: new Date(ms).toISOString(), time, sender, raw, ios: head.ios };
    if (messages.length >= LIMITS.messages) throw new ExportError('too_many', 'Choose an export with up to 100,000 messages');
  }
  close();
  const participants = new Map();
  const stats = { lines: lines.length, messages: messages.length, text: 0, media: 0, deleted: 0, system: 0, multiline: 0, edited: 0, outOfOrder: 0, first: null, last: null };
  let last = -Infinity;
  for (const m of messages) {
    stats[m.kind]++;
    if (m.body.includes('\n')) stats.multiline++;
    if (m.edited) stats.edited++;
    const t = Date.parse(m.at);
    if (t < last) stats.outOfOrder++;
    last = Math.max(last, t);
    if (m.kind === 'system') continue;
    stats.first ??= m.at; stats.last = m.at;
    let p = participants.get(m.sender);
    if (!p) { p = { label: m.sender, display: displayLabel(m.sender), phone: isPhoneLabel(m.sender), messages: 0, text: 0, media: 0, deleted: 0, first: m.at, last: m.at }; participants.set(m.sender, p); }
    p.messages++; p[m.kind]++; p.last = m.at;
  }
  if (!detected.certain && dateOrder === 'auto') warnings.push({ code: 'date_order_guess', order });
  if (before) warnings.push({ code: 'leading_lines', count: before });
  if (counts.badStamp) warnings.push({ code: 'bad_stamp', count: counts.badStamp, line: counts.firstBadStamp });
  if (counts.ambiguous) warnings.push({ code: 'time_ambiguous', count: counts.ambiguous, line: counts.firstUncertain });
  if (counts.missing) warnings.push({ code: 'time_missing', count: counts.missing, line: counts.firstUncertain });
  if (stats.outOfOrder) warnings.push({ code: 'out_of_order', count: stats.outOfOrder });
  if (counts.long) warnings.push({ code: 'long_message', count: counts.long });
  const phones = [...participants.values()].filter((p) => p.phone).length;
  if (phones) warnings.push({ code: 'phone_senders', count: phones });
  return { parser: PARSER, timeZone, dateOrder: order, dateOrderCertain: dateOrder !== 'auto' || detected.certain, messages, participants: [...participants.values()].sort((a, b) => b.messages - a.messages || a.label.localeCompare(b.label)), stats, warnings };
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Which sender a mapping decision is for, without keeping a phone number. */
export function participantKey(label) {
  return sha256Hex('whatsapp-participant/1\n' + label);
}
/** Stable keys: the same message read from this export or a later, longer one gets the same key, so importing an
 *  overlapping export adds only what is new. Identical messages in the same minute are told apart by their order. A
 *  sender who is a phone number enters the key as shown ("Number ending 123"), so no number can be worked back from it. */
export async function importKeys(messages) {
  const seen = new Map();
  return Promise.all(messages.map((m) => {
    const base = [PARSER, m.local, m.sender === null ? '' : displayLabel(m.sender), m.kind, m.body].join('\n');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return sha256Hex(base + '\n' + n);
  }));
}

const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * Who in Pulse a sender might be. Only one person with exactly the same name is a suggestion; several people with
 * that name, a first name alone or a phone number are left for a person to decide.
 */
export function suggestPeople(participants, people) {
  return participants.map((p) => {
    if (p.phone) return { status: 'phone', candidates: [] };
    const label = fold(p.label);
    const same = people.filter((x) => fold(x.name) === label).map((x) => x.id);
    if (same.length === 1) return { status: 'same_name', candidates: same };
    if (same.length > 1) return { status: 'several', candidates: same };
    const first = label.split(' ')[0];
    const firstName = label && !label.includes(' ') ? people.filter((x) => fold(x.name).split(' ')[0] === first).map((x) => x.id) : [];
    if (firstName.length) return { status: 'first_name', candidates: firstName };
    return { status: 'none', candidates: [] };
  });
}
