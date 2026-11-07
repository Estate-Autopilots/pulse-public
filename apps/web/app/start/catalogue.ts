// ONBOARD-SELF: what the "Start your company" wizard offers. The keys are the API's (services/api/src/self-serve-model.ts:
// templates, module choices, seats); the API checks them and decides what each brings.
export type TemplateKey = "sales" | "agency" | "creator" | "software" | "general";
export type ChoiceKey = "chats" | "money" | "leads" | "hr" | "briefs" | "map";
export type SeatKey = "leadership" | "manager" | "staff" | "sales" | "freelancer" | "client";

export const TEMPLATES: { key: TemplateKey; name: string; note: string; modules: ChoiceKey[]; starter: string }[] = [
  { key: "sales", name: "Sales team", note: "Leads, calls, follow-ups and monthly targets.", modules: ["chats", "leads", "money"], starter: "Sales pipeline" },
  { key: "agency", name: "Agency or freelance projects", note: "Client projects from brief to invoice, with freelancers.", modules: ["chats", "money", "briefs"], starter: "First client project" },
  { key: "creator", name: "Content creator", note: "A content calendar: plan, script, shoot, publish.", modules: ["chats", "briefs"], starter: "Content calendar" },
  { key: "software", name: "Software product", note: "A roadmap, releases, owners and a weekly demo.", modules: ["chats"], starter: "Product roadmap" },
  { key: "general", name: "General team", note: "Tasks, projects and chat for any team.", modules: ["chats"], starter: "Getting started" },
];

export const CHOICES: { key: ChoiceKey; name: string; note: string }[] = [
  { key: "chats", name: "Team chat", note: "Groups and one-to-one chats, calls and files." },
  { key: "leads", name: "Leads and sales pipeline", note: "Every enquiry, its stage and the next follow-up." },
  { key: "money", name: "Money", note: "Quotes, invoices and expenses." },
  { key: "hr", name: "Leave and attendance", note: "Leave requests and approvals; attendance when HR sets it up." },
  { key: "briefs", name: "Briefs", note: "Write a brief once; the team works from it." },
  { key: "map", name: "Map and site visits", note: "Where your team and customers are." },
];

export const SEATS: { key: SeatKey; label: string; who: string; sees: string[]; wont: string[] }[] = [
  { key: "leadership", label: "Leadership", who: "Founders and partners who run the company with you.", sees: ["Every project, task and person", "Money, reports and the dashboard", "Settings and invitations"], wont: ["Other companies on Pulse"] },
  { key: "manager", label: "Manager", who: "People who lead a team or run projects.", sees: ["Their team’s tasks and projects", "Leave to approve for their team", "Team chats"], wont: ["Salaries and payroll", "Company money and settings"] },
  { key: "staff", label: "Team member", who: "Employees who do the work.", sees: ["Their own tasks and projects they are on", "Chats they are in", "Their own leave and profile"], wont: ["Other people’s salaries or HR records", "Company money and settings"] },
  { key: "sales", label: "Sales rep", who: "People who call leads and close deals.", sees: ["Leads and the pipeline (when Leads is on)", "Their own tasks, follow-ups and chats"], wont: ["Salaries and HR records", "Company money and settings"] },
  { key: "freelancer", label: "Freelancer", who: "Outside help on some projects, paid per job.", sees: ["The tasks and projects you add them to", "Chats they are in"], wont: ["Salaries, HR records and money", "Settings"] },
  { key: "client", label: "Client", who: "Customers who follow and approve their own work.", sees: ["Only the work you share with them", "Chats you start with them"], wont: ["Anything internal: people, other clients, money, settings"] },
];

export const DAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7]] as const;

export const TIME_ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Dhaka", "Asia/Kathmandu", "Asia/Colombo", "Europe/London", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "Africa/Nairobi", "UTC"];

/** E-mail addresses pasted in bulk ("Asha <user-3eeffa7a@org-e6abb3.example>, user-bc0866ba@org-e6abb3.example; …" or one per line), each once. */
export function parseEmails(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [], invalid: string[] = [];
  for (const raw of text.slice(0, 20000).split(/[\s,;]+/)) {
    const part = raw.replace(/^.*</, "").replace(/>.*$/, "").replace(/^mailto:/i, "").trim().toLowerCase();
    if (!part || !part.includes("@")) continue;
    if (/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(part) && part.length <= 254) { if (!emails.includes(part)) emails.push(part); } else invalid.push(part);
  }
  return { emails, invalid };
}

export const handleOf = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").slice(0, 30);
