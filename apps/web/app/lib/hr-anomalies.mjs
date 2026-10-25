// HR desk → Dashboard → "Worth a look" (HR-POLISH, 10 Oct 2026): the service's anomalies, grouped by kind, each said
// in one short line. The service's full sentence stays available as the row's tooltip; nothing is dropped.

/** Kinds in the order HR should look at them, with the group's name. */
export const ANOMALY_KINDS = [
  ["statistics_excluded", "Attendance needs review"], ["absent", "No check-in"], ["missed_out", "No check-out"], ["open", "Still checked in"],
  ["long_day", "Very long day"], ["late", "Often late"], ["long_break", "Long breaks"],
];
const KIND_LABEL = Object.fromEntries(ANOMALY_KINDS);

// The attendance-statistics labels (services/api/src/attendance-statistics.ts REASONS), shortened.
const SHORT = {
  "Times need review": "Times need review", "Check-out precedes check-in": "Check-out before check-in", "Recorded time is in the future": "Time in the future",
  "Check-out needs correction": "Check-out missing", "Session not yet closed": "Session not closed", "Correction awaiting a decision": "Correction pending",
  "Over the provisional 12-hour session bound": "Session over 12 h", "Sessions overlap": "Sessions overlap", "Break times need review": "Break times off",
  "Breaks overlap": "Breaks overlap", "Over the provisional 12-hour daily bound": "Day over 12 h",
};

/** One short line for an anomaly, e.g. "Session not closed (12 h+)", "Late 4 times", "2 days without a check-in". */
export function shortReason(a) {
  const detail = String(a.detail ?? "").trim();
  if (a.type === "statistics_excluded") {
    const labels = detail.replace(/\.\s*Day excluded from averages.*$/s, "").split(/;\s*/).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
    const short = [...new Set(labels.map((l) => SHORT[l] ?? l))];
    if (short.includes("Session not closed") && short.includes("Session over 12 h")) short.splice(short.indexOf("Session not closed"), 1, "Session not closed (12 h+)");
    const rest = short.filter((s) => s !== "Session over 12 h" || !short.includes("Session not closed (12 h+)"));
    return rest.slice(0, 2).join(" · ") || "Excluded from averages";
  }
  let m;
  if (a.type === "late" && (m = detail.match(/Late (\d+) times/))) return `Late ${m[1]} times in 14 days`;
  if (a.type === "absent" && (m = detail.match(/^(One|\d+) working days?/))) { const n = m[1] === "One" ? 1 : Number(m[1]); return `${n} ${n === 1 ? "day" : "days"} without a check-in`; }
  if (a.type === "long_break" && (m = detail.match(/up to (.+?)\.?$/))) return `Breaks took ${m[1].replace(/ 0 min$/, "")}`;
  if (a.type === "missed_out") return "No check-out recorded";
  if (a.type === "open") return "Still checked in";
  const first = detail.split(/(?<=\.)\s/)[0]?.replace(/\.$/, "") ?? "";
  return first || KIND_LABEL[a.type] || "Worth a look";
}

/** Anomalies by kind, most pressing kind first; each group keeps the service's order and counts distinct people. */
export function groupAnomalies(anomalies) {
  const order = ANOMALY_KINDS.map(([k]) => k);
  const groups = new Map();
  for (const a of anomalies ?? []) {
    if (!groups.has(a.type)) groups.set(a.type, { type: a.type, label: KIND_LABEL[a.type] ?? a.type, items: [] });
    groups.get(a.type).items.push(a);
  }
  return [...groups.values()].map((g) => ({ ...g, people: new Set(g.items.map((a) => a.personId)).size }))
    .sort((x, y) => (order.indexOf(x.type) + 1 || 99) - (order.indexOf(y.type) + 1 || 99));
}
