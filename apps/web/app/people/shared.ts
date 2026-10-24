/** Small helpers shared by the Team directory and the staff profile. */
import { userId } from "../lib/format";

export const EMPLOYMENT: Record<string, string> = { full_time: "Full time", part_time: "Part time", intern: "Intern", contract: "Contract", freelance: "Freelance" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Time since a joining date: "1 yr 3 mo", "8 mo", "under a month". Null when the date is in the future. */
export function tenure(joinedOn: string, today: string = new Date().toISOString().slice(0, 10)) {
  const [y, m, d] = joinedOn.split("-").map(Number); const [ty, tm, td] = today.split("-").map(Number);
  let months = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0);
  if (joinedOn > today) return null;
  if (months < 1) return "under a month";
  const years = Math.floor(months / 12); months %= 12;
  return [years ? `${years} yr` : "", months ? `${months} mo` : ""].filter(Boolean).join(" ");
}
/** "Aug 2025" for a joining date. */
export const monthYear = (value: string) => `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;

/** The employee ID for a staff number, or a plain note when none is assigned yet. */
export const employeeId = (no: number | null, code?: string) => userId(no, code) ?? "Not assigned";

/** Does a search for an employee ID ("EA-P007", "p007", "7") name this staff number? Null when the search is not an ID. */
export function idQuery(query: string): number | null {
  const m = /^(?:[a-z]{2,4}[\s-]?)?p?[\s-]?0*(\d{1,5})$/i.exec(query.trim());
  return m ? Number(m[1]) : null;
}
