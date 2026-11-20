// One attendance state for widgets, the Android ribbon and iOS Live Activity. No credential or person's name.
import { deriveView, liveSeconds } from './view.js';
export function surfaceState(payload, at = Date.now()) {
  if (!payload) return { state: 'signed-out', title: 'Open Pulse to sign in', active: false, actions: [], seconds: 0, timerSince: null, mood: 'idle', pending: false };
  const view = deriveView(payload, at);
  const active = ['in', 'break'].includes(payload.state) && !!payload.entry && !payload.entry.out;
  const seconds = Math.max(0, Math.floor(payload.state === 'break' ? (at - Date.parse(payload.entry?.breakStartedAt ?? '')) / 1000 : liveSeconds(payload.entry, at).worked));
  return { state: payload.state, title: payload.state === 'in' ? 'You’re checked in' : view.title, active,
    actions: (['out','in','break','done'].includes(payload.state)?view.actions:[]).map(a => ({ id: a.id, label: a.label })), seconds: Number.isFinite(seconds) ? seconds : 0,
    timerSince: active ? at - (Number.isFinite(seconds) ? seconds : 0) * 1000 : null,
    mood: view.mood, pending: !!payload.pending };
}
