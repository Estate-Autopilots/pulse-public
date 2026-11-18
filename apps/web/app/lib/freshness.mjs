const DAY = 24 * 60 * 60 * 1000;
// A recent Pulse import cannot make an old upstream Drive crawl fresh.
export function freshnessState(at, upstreamAt, now) {
  const times = [at, upstreamAt].filter(value => value != null).map(value => Date.parse(value));
  const stale = times.some(value => !Number.isFinite(value) || now - value > DAY);
  return { stale, warning: stale ? 'Data is stale · over 24 hours since sync' : null };
}
