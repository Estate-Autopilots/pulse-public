// ONBOARD-SELF: what the "Start your company" wizard offers. The keys are the API's (services/api/src/self-serve-model.ts:
// templates, module choices, seats); the API checks them and decides what each brings.
export type TemplateKey = "sales" | "agency" | "creator" | "software" | "plants" | "solar" | "general";
export type ChoiceKey = "chats" | "money" | "leads" | "hr" | "briefs" | "map";
export type SeatKey = "leadership" | "manager" | "staff" | "sales" | "freelancer" | "client" | "accountant" | "partner" | "vendor";

export const TEMPLATES: { key: TemplateKey; name: string; note: string; modules: ChoiceKey[]; starter: string }[] = [
  { key: "sales", name: "Sales team", note: "Leads, calls, follow-ups and monthly targets.", modules: ["chats", "leads", "money"], starter: "Sales pipeline" },
  { key: "agency", name: "Agency or freelance projects", note: "Client projects from brief to invoice, with freelancers.", modules: ["chats", "money", "briefs"], starter: "First client project" },
  { key: "creator", name: "Content creator", note: "A content calendar: plan, script, shoot, publish.", modules: ["chats", "briefs"], starter: "Content calendar" },
  { key: "software", name: "Software product", note: "A roadmap, releases, owners and a weekly demo.", modules: ["chats"], starter: "Product roadmap" },
  { key: "plants", name: "STP / ATP plants", note: "Plant projects from survey to handover: checklist, vendor quotes, QA calls.", modules: ["chats", "money", "hr", "map"], starter: "First plant project" },
  { key: "solar", name: "Solar installer", note: "Enquiry, roof survey, quotation, install and invoice.", modules: ["chats", "money", "leads", "map"], starter: "First solar job" },
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

/** CA-ACCESS: the same seats as the API (services/api/src/self-serve-model.ts), with what each can do. PICKER is the
 *  Add people list, in order. */
export const SEATS: { key: SeatKey; label: string; line: string; who: string; sees: string[]; does: string[]; wont: string[] }[] = [
  { key: "staff", label: "Employee", line: "works on tasks", who: "Works on tasks for the company.", sees: ["Their own tasks and the projects they are on", "Chats they are in", "Their own leave and profile"], does: ["Finish tasks and add proof", "Ask questions on the task", "Ask for leave"], wont: ["Other people’s salaries or HR records", "Company money and settings"] },
  { key: "manager", label: "Manager", line: "runs a team", who: "Runs a team or projects.", sees: ["Their team’s tasks and projects", "Leave to approve for their team", "Team chats"], does: ["Give tasks to the team", "Check finished work", "Approve leave"], wont: ["Salaries and payroll", "Company money and settings"] },
  { key: "accountant", label: "CA / accountant", line: "checks your books", who: "Checks your books each month.", sees: ["Sales invoices, purchase bills and receipts", "GST and TDS registers", "Monthly payroll totals (no names)"], does: ["Mark each bill Verified, or ask you a question", "Tick GSTR-1, GSTR-3B, TDS and bank as done", "Download for GST and Tally"], wont: ["Each person’s salary (unless you tick the box)", "HR records, leave and attendance", "Chats, tasks and settings"] },
  { key: "partner", label: "Partner", line: "runs the company with you", who: "Runs the company with you.", sees: ["Every project, task and person", "Money, reports and the dashboard", "Settings and people"], does: ["Everything you can do, except change the owner"], wont: ["Other companies on Pulse"] },
  { key: "client", label: "Client", line: "sees work you share", who: "A customer who follows their own work.", sees: ["Only the work you share with them", "Chats you start with them"], does: ["Approve or comment on their work", "Ask the team in chat"], wont: ["Anything inside: people, other clients, money, settings"] },
  { key: "vendor", label: "Vendor", line: "sends you bills", who: "A supplier who sends you bills.", sees: ["Only the work you share with them", "Chats you start with them"], does: ["Send bills and updates in the chat", "Follow the orders you share"], wont: ["Anything inside: people, money, other vendors, settings"] },
  { key: "leadership", label: "Leadership", line: "runs the company with you", who: "Founders and partners who run the company with you.", sees: ["Every project, task and person", "Money, reports and the dashboard", "Settings and invitations"], does: ["Everything you can do, except change the owner"], wont: ["Other companies on Pulse"] },
  { key: "sales", label: "Sales rep", line: "calls leads and closes deals", who: "Calls leads and closes deals.", sees: ["Leads and the pipeline (when Leads is on)", "Their own tasks, follow-ups and chats"], does: ["Log calls and next steps"], wont: ["Salaries and HR records", "Company money and settings"] },
  { key: "freelancer", label: "Freelancer", line: "outside help, paid per job", who: "Outside help on some projects, paid per job.", sees: ["The tasks and projects you add them to", "Chats they are in"], does: ["Upload work on the task"], wont: ["Salaries, HR records and money", "Settings"] },
];
/** The Add people picker, in order (the owner's six). */
export const PICKER: SeatKey[] = ["staff", "manager", "accountant", "partner", "client", "vendor"];
/** The start-up wizard's seats (as before, Employee first). */
export const WIZARD: SeatKey[] = ["leadership", "manager", "staff", "sales", "freelancer", "client"];

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
