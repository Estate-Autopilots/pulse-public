// PM-BUILD-1 (owner, 17 Nov 2026: "things that are leadership-only should be treated that way (ask/mark)"): the words
// that make a task leadership business. When a task's words carry one of these and it is open to the team, the task page
// asks leadership once whether to make it leadership-only; it never changes who sees a task by itself. Kept narrow on
// purpose: a real-estate agency's own work says "home loan", "investor persona" and "brand equity" every day, and those
// are not leadership business.
export const TOPICS = [
  { key: "pay", label: "pay and salaries", re: /\b(salar(y|ies)|payroll|pay ?slips?|increments?|appraisals?|compensation|ctc|pay (rise|raise|revision|cut|hike)|minimum pay)\b/i },
  { key: "people", label: "warnings, exits or someone's job", re: /\b(terminat(e|ed|ion)|layoffs?|lay off|warning letter|disciplinary|performance improvement plan|notice period|resignations?|let (him|her|them) go)\b/i },
  { key: "money", label: "funding and the company's own money", re: /\b(funding round|fund ?rais(e|ing)|term sheet|cap table|shareholders?'? agreement|esops?|equity (split|stake|shares)|board meeting|bank statements?)\b/i },
  { key: "legal", label: "a legal matter", re: /\b(legal notice|lawsuit|litigation|court (case|hearing|notice)|arbitration)\b/i },
];

/** The leadership topic a task's words carry, or null. */
export function leadershipTopic(title, notes = "") {
  const text = `${title ?? ""}\n${notes ?? ""}`;
  return TOPICS.find((t) => t.re.test(text)) ?? null;
}
