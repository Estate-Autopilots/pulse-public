// STAFF-UX (owner, 28 Oct 2026: "Date of birth shows 6 Oct 2026"): the date of birth in the first run is three pickers
// (year first) that start empty. The years run from 80 years ago to 16 years ago (the API takes 80 to 15), and a stored
// day outside that range (a stray tap on a calendar that opened on today) reads as empty, so it is chosen again.

/** The first and last day a date of birth may be, for a day given as YYYY-MM-DD. */
export function dobRange(today) {
  const y = Number(String(today).slice(0, 4));
  return { min: `${y - 80}-01-01`, max: `${y - 16}${String(today).slice(4, 10)}` };
}

/** A stored date of birth as its parts, or empty parts when it is missing, malformed or out of range. */
export function dobParts(value, today) {
  const { min, max } = dobRange(today);
  const ok = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= min && value <= max
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  return ok ? { year: value.slice(0, 4), month: value.slice(5, 7), day: value.slice(8, 10) } : { year: "", month: "", day: "" };
}

/** Days in a month (1 to 12) of a year; 31 until both are known. */
export function daysIn(year, month) {
  return year && month ? new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() : 31;
}

/** The parts as YYYY-MM-DD and what is wrong with them ("" when the day is fine). */
export function dobValue(parts, today) {
  const { min, max } = dobRange(today);
  const day = parts.day && Number(parts.day) <= daysIn(parts.year, parts.month) ? parts.day : "";
  const iso = parts.year && parts.month && day ? `${parts.year}-${parts.month}-${day}` : "";
  const problem = !iso ? "Choose the year, month and day you were born." : iso > today ? "A date of birth can’t be in the future."
    : iso > max ? "That is less than 16 years ago. Check the year." : iso < min ? "Check the year." : "";
  return { iso, day, problem };
}
