// AGREEMENTS: one icon per kind of policy (the Agreements page), and one per term when its title says what it is about
// (the acceptance view: "Notice" gets a calendar clock, "How your salary is split" a pie).
import { createElement } from "react";
import { BadgeCheck, BriefcaseBusiness, CalendarClock, CalendarDays, Clock, FileCheck2, Heart, House, PieChart, Plane, Receipt, ShieldCheck, UserCheck, Wallet, type LucideIcon } from "lucide-react";

const ICON: Record<string, LucideIcon> = { offer: BriefcaseBusiness, pay: Wallet, leave: CalendarDays, wfh: House, attendance: Clock, expenses: Receipt, travel: Plane, conduct: ShieldCheck };
const TERM: [RegExp, LucideIcon][] = [
  [/approv/i, UserCheck], [/probation|offer|joining/i, BadgeCheck], [/notice|exit|leaving/i, CalendarClock], [/salary|split|structure/i, PieChart],
  [/claim|expense|bill/i, Receipt], [/leave|holiday|day's pay|advance/i, CalendarDays], [/travel|trip/i, Plane], [/home|remote/i, House],
  [/hours|attendance|late/i, Clock], [/respect|conduct|harass|kind/i, Heart],
];
/** The icon of a kind of policy (a document for any other). */
export const policyIcon = (kind: string): LucideIcon => ICON[kind] ?? FileCheck2;
/** The same, drawn: one fixed icon per kind, so nothing new is made while drawing. */
export function PolicyIcon({ kind, size }: { kind: string; size: number }) {
  return createElement(policyIcon(kind), { size, "aria-hidden": true });
}
/** A term's icon: from its title when it says what it is about, otherwise its policy's. */
export function TermIcon({ title, kind, size }: { title: string; kind: string; size: number }) {
  return createElement(TERM.find(([re]) => re.test(title))?.[1] ?? policyIcon(kind), { size, "aria-hidden": true });
}
