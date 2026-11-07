// Pulse's rule for charts (MOBILE-SHELL, 9 Oct 2026): a chart shows a shape only when at least three points carry a
// value. With none, one or two, the page says the fact in words or as a side-by-side comparison instead of drawing
// one or two lonely bars.
export const CHART_MIN_POINTS = 3;

/** The points that carry a value when there are too few for a chart; null when a chart is right. */
export function sparse(points, value = (p) => p.value) {
  const some = points.filter((p) => Number(value(p)) > 0);
  return some.length < CHART_MIN_POINTS ? some : null;
}

/** "Up 3 (+33%)", "Down 2", "Same": how the second of two values compares with the first. */
export function change(first, second) {
  const d = second - first;
  if (!d) return "Same";
  const pct = first ? ` (${d > 0 ? "+" : "−"}${Math.round((Math.abs(d) / first) * 100)}%)` : "";
  return `${d > 0 ? "Up" : "Down"} ${Math.abs(d)}${pct}`;
}
