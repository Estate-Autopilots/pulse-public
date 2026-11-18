// Scores only current office evidence. No coordinates or location trail.
export const PRESENCE_THRESHOLD = 65;
export const SIGNAL_TTL = 10 * 60000;
export function triangulate(signals, at = Date.now()) {
  const fresh = (s) => s && Number.isFinite(s.at) && s.at <= at + 120000 && at - s.at <= SIGNAL_TTL;
  const region = signals?.region?.inside === true && at - signals.region.at < 12 * 3600000;
  const wifi = fresh(signals?.wifi) ? signals.wifi.strength : null;
  const ip = fresh(signals?.ip) && signals.ip.matched === true;
  const score = Math.min(100, (region ? 45 : 0) + (wifi === 'strong' ? 40 : wifi === 'weak' ? 10 : 0) + (ip ? 35 : 0));
  return { score, confident: score >= PRESENCE_THRESHOLD, holding: region || wifi === 'strong' || ip, signals: { region, wifi: wifi ?? null, ip: !!ip } };
}
export function dwellDecision({ signals, previous = {}, at, dwellMinutes = 3, leaveMinutes = 15, consent, autoConsent, hrAuto, workingDay, state }) {
  if (!consent) return { kind: 'off', score: 0, since: null, lastPresence: null, leftAt: null };
  const evidence = triangulate(signals, at);
  const since = evidence.confident ? previous.since ?? at : null;
  const lastPresence = evidence.holding ? at : previous.lastPresence ?? null;
  const leftAt = evidence.holding ? null : previous.leftAt ?? (lastPresence !== null ? at : null);
  let kind = evidence.confident ? 'dwelling' : evidence.holding ? 'holding' : 'none';
  if (evidence.confident && since !== null && at - since >= Math.max(1, Math.min(30, dwellMinutes)) * 60000 && autoConsent && hrAuto && workingDay && state === 'out') kind = 'auto-check-in';
  if (['in','break'].includes(state) && leftAt !== null) kind = at - leftAt >= Math.max(1,leaveMinutes) * 60000 ? 'checkout-needs-confirmation' : 'leave-reminder';
  return { ...evidence, kind, since, lastPresence, leftAt };
}
