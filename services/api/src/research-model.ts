/** Interpretable performance primitives. Output observations never imply person attribution. */
export function shrunkRate(
  successes: number,
  n: number,
  priorRate: number,
  priorWeight = 40,
) {
  if (n < 40)
    return {
      value: null,
      low: null,
      high: null,
      n,
      sufficiency: "thin",
      priorWeight,
    };
  const a = successes + priorRate * priorWeight,
    b = n - successes + (1 - priorRate) * priorWeight;
  const value = a / (a + b),
    se = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return {
    value,
    low: Math.max(0, value - 1.96 * se),
    high: Math.min(1, value + 1.96 * se),
    n,
    sufficiency: "enough",
    priorWeight,
  };
}
export function shrunkCpl(
  spend: number,
  leads: number,
  benchmark: number,
  priorLeads = 50,
) {
  if (spend < 5000 || leads < 50 || benchmark <= 0) return null;
  const value = (spend + priorLeads * benchmark) / (leads + priorLeads),
    relative = 1.96 / Math.sqrt(leads + priorLeads);
  return {
    value,
    low: value / (1 + relative),
    high: value / (1 - relative),
    n: leads,
    priorLeads,
  };
}
export function growthDelta(values: number[]) {
  if (values.length < 6) return null;
  const prior = values.slice(-6, -3).reduce((a, b) => a + b, 0),
    recent = values.slice(-3).reduce((a, b) => a + b, 0);
  return prior > 0 ? (recent / prior - 1) * 100 : null;
}
export const WORK_CREDITS = {
  model_video: 4,
  vov: 2,
  hook: 1,
  image_ad: 0.5,
  carousel_card: 0.25,
} as const;
export function versionKind(hours: number, feedback: boolean) {
  return hours < 24 ? "variant" : feedback ? "revision" : "refresh_candidate";
}
