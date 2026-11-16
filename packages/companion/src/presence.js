// Presence decisions for the phone: office geofences, confirmed shoot sites and office Wi-Fi.
// Location is only ever an input at a moment (an OS region event, the app opening, a check-in); nothing here keeps a
// trail. The output is a suggestion ("You're at the office — check in?"), an automatic check-in when both HR and the
// person allow it, or nothing. Check-out is never automatic.
import { friendlyClock } from './time.js';

const EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export const WEAK_GPS_METERS = 100;       // worse than this, GPS can't place you indoors; Wi-Fi decides
export const REPEAT_MINUTES = 30;         // the same suggestion for the same place at most twice an hour
export const IOS_REGION_LIMIT = 20;
export const ANDROID_REGION_LIMIT = 100;

export function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Offices first, then confirmed sites, within the platform's region-monitoring limit. */
export function regionsToMonitor(presence, limit = IOS_REGION_LIMIT) {
  const offices = (presence?.offices ?? []).map((o) => ({ id: `office:${o.id}`, kind: 'office', placeId: o.id, name: o.name, lat: o.lat, lng: o.lng, radius: o.radius }));
  const sites = (presence?.sites ?? []).filter((s) => ['exact', 'building'].includes(s.precision))
    .map((s) => ({ id: `site:${s.id}`, kind: 'site', placeId: s.id, name: s.name, lat: s.lat, lng: s.lng, radius: s.radius }));
  return [...offices, ...sites].filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && r.radius >= 50).slice(0, limit);
}

/** The place a one-off position falls in, or why it can't say. Accuracy counts against you: no guessing at edges. */
export function placeAt(coords, presence) {
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return { place: null, reason: 'no-fix' };
  if (!Number.isFinite(coords.accuracy) || coords.accuracy > WEAK_GPS_METERS) return { place: null, reason: 'weak-gps' };
  let best = null;
  for (const r of regionsToMonitor(presence, Infinity)) {
    const d = distanceMeters(coords, r);
    if (d + coords.accuracy * 0.5 <= r.radius && (!best || d < best.distance)) best = { ...r, distance: Math.round(d) };
  }
  return best ? { place: best, reason: 'inside' } : { place: null, reason: 'outside' };
}

const normal = (s) => String(s ?? '').trim();
const mac = (s) => String(s ?? '').trim().toLowerCase().replace(/-/g, ':');

/**
 * Office Wi-Fi match. A registered BSSID (the access point's hardware address) is a strong signal; the network name
 * alone is weak (anyone can name a hotspot "EA Office"), so it only ever leads to a suggestion.
 */
export function wifiMatch(wifi, presence) {
  if (!wifi || !normal(wifi.ssid)) return null;
  const ssid = normal(wifi.ssid), bssid = mac(wifi.bssid);
  let weak = null;
  for (const o of presence?.offices ?? []) for (const w of o.wifi ?? []) {
    if (normal(w.ssid) !== ssid) continue;
    if (bssid && (w.bssids ?? []).map(mac).includes(bssid)) return { id: `office:${o.id}`, kind: 'office', placeId: o.id, name: o.name, strength: 'strong', via: 'wifi' };
    weak ??= { id: `office:${o.id}`, kind: 'office', placeId: o.id, name: o.name, strength: 'weak', via: 'wifi' };
  }
  return weak;
}

/**
 * What to do about a presence signal.
 * signal: { trigger: 'enter' | 'exit' | 'wifi' | 'open', place: { kind, placeId, name, strength? } }
 * Returns { kind: 'none' | 'suggest-check-in' | 'auto-check-in' | 'suggest-leave', ... } with the notification text.
 */
export function decidePresence({ signal, payload, prefs, at, recent = [] }) {
  const none = (reason) => ({ kind: 'none', reason });
  if (!signal?.place || !payload) return none('no-place');
  if (payload.attendanceEnabled !== true) return none('attendance-off');
  if (!prefs?.presence) return none('presence-off');
  const { trigger, place } = signal;
  const state = payload.state;
  const start = Date.parse(payload.shiftStartsAt ?? ''), end = Date.parse(payload.shiftEndsAt ?? '');
  const key = `${trigger === 'exit' ? 'leave' : 'arrive'}:${place.id ?? place.placeId}`;
  if (recent.some((r) => r.key === key && at - r.at < REPEAT_MINUTES * 60000)) return none('repeat');
  const where = place.kind === 'office' ? `at ${place.name || 'the office'}` : `at ${place.name || 'the shoot site'}`;
  const mode = place.kind === 'office' ? 'office' : 'field';

  if (trigger === 'exit') {
    if (state !== 'in' && state !== 'break') return none('not-checked-in');
    // ATT: leaving is Pulse's to judge from every signal together (a break, the end of the day, or one question when
    // they conflict); the phone no longer asks on its own the moment a geofence says "exit".
    if (payload.presence?.autoCheckOut === true) return none('server-decides');
    const early = Number.isFinite(end) && at < end - 60 * 60000;
    return { kind: 'suggest-leave', key, placeId: place.placeId, actions: early ? ['break-start', 'check-out'] : ['check-out'],
      title: early ? 'Heading out?' : 'Leaving for the day?', body: early ? 'Take a break or check out — one tap.' : 'Check out when you’re done for the day.' };
  }
  // enter / wifi / open
  if (state === 'in' || state === 'break' || state === 'leave') return none(`state-${state}`);
  const windowOpen = Number.isFinite(start) && Number.isFinite(end) && at >= start - 2 * 3600000 && at <= end;
  if (!windowOpen) return none('outside-shift-window');
  if (state === 'done') {
    return { kind: 'suggest-check-in', key, placeId: place.placeId, mode, title: `Back ${where}?`, body: 'Check in again — the time away counts as a break.', actions: ['check-in'] };
  }
  const strong = place.kind === 'office' && (trigger === 'enter' || place.strength === 'strong');
  const auto = strong && payload.presence?.autoCheckIn === true && prefs.autoCheckIn === true && payload.shift?.workingDay && at >= start - 60 * 60000;
  if (auto) return { kind: 'auto-check-in', key, placeId: place.placeId, mode, title: `Checked in ${where}`, body: 'Automatic check-in is on. Tap to undo with a correction if this is wrong.', actions: [] };
  const by = payload.shift?.onTimeBy ? ` On time until ${friendlyClock(payload.shift.onTimeBy)}.` : '';
  return { kind: 'suggest-check-in', key, placeId: place.placeId, mode, title: `You’re ${where} — check in?`, body: `One tap and you’re in.${by}`, actions: ['check-in'] };
}

/** The check-in body for a presence-driven action: where and why, never coordinates. */
export function presenceBody(decision, signal, auto = false) {
  return { mode: decision.mode ?? 'office', via: 'mobile', trigger: auto ? 'auto' : 'suggested', place: { kind: signal.place.kind, id: signal.place.placeId, signal: signal.trigger === 'wifi' || signal.place.via === 'wifi' ? 'wifi' : 'region' } };
}
