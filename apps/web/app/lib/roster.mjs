// The HR desk roster tolerates a service that answers in an older shape (pulse-dev, 9 Oct 2026: the API process
// predated the per-session rows and one missing field took the whole desk down with "This view could not load").
// Minutes worked today: the day's sessions when the service sends them, otherwise the single entry's total.
export function workedToday(person) {
  const sessions = Array.isArray(person?.sessions) ? person.sessions : null;
  if (sessions?.length) return sessions.reduce((n, s) => n + (Number(s?.worked) || 0), 0);
  return Number(person?.entry?.worked) || 0;
}
