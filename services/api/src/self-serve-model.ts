// ONBOARD-SELF (owner, 2 Nov 2026): "start your company on Pulse" with no operator. What a company can start from
// (templates, each bringing modules, an industry pack and a starter project), the modules it can switch on, the seats it
// invites people to (what each will and won't see, plain words), and the cleaning of the wizard's answers into the one
// payload pulse.onboard_org writes (db/migrations/1462_self_serve_onboarding.sql). The web shows the same catalogue
// (apps/web/app/start/catalogue.ts); the keys are the contract between them.
import { MODULE_KEYS, validateModules, type ModuleKey } from './modules.js';
import { PACK, packPayload } from './flow/packs.js';

export const TEMPLATE_KEYS = ['sales', 'agency', 'creator', 'software', 'general'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const CHOICE_KEYS = ['chats', 'money', 'leads', 'hr', 'briefs', 'map'] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];
export const SEAT_KEYS = ['leadership', 'manager', 'staff', 'sales', 'freelancer', 'client'] as const;
export type SeatKey = (typeof SEAT_KEYS)[number];

export type Starter = { key: TemplateKey; name: string; summary: string; steps: string[] };
export type Template = { key: TemplateKey; name: string; modules: ChoiceKey[]; pack: string | null; starter: Starter };

export const TEMPLATES: Template[] = [
  { key: 'sales', name: 'Sales team', modules: ['chats', 'leads', 'money'], pack: null,
    starter: { key: 'sales', name: 'Sales pipeline', summary: 'Where every lead stands, who follows up and what closes this month.',
      steps: ['Add your first 10 leads', 'Agree the stages a lead moves through', 'Set this month’s calls, meetings and closing targets', 'Book a weekly pipeline review'] } },
  { key: 'agency', name: 'Agency or freelance projects', modules: ['chats', 'money', 'briefs'], pack: 'marketing_agency',
    starter: { key: 'agency', name: 'First client project', summary: 'One client’s work from the brief to the invoice, with the people on it.',
      steps: ['Write the brief and the scope', 'Agree deliverables and dates with the client', 'Add the freelancers and team on it', 'Share the first draft for review', 'Send the invoice'] } },
  { key: 'creator', name: 'Content creator', modules: ['chats', 'briefs'], pack: null,
    starter: { key: 'creator', name: 'Content calendar', summary: 'What goes out this month, who makes it and when it is due.',
      steps: ['Plan this month’s posts and videos', 'Script the next three pieces', 'Shoot and edit', 'Publish and note what worked'] } },
  { key: 'software', name: 'Software product', modules: ['chats'], pack: null,
    starter: { key: 'software', name: 'Product roadmap', summary: 'The next release: its goals, the work and who owns each part.',
      steps: ['Write down the next release’s goals', 'Break it into tasks with owners and dates', 'Set up a weekly demo', 'Collect customer feedback after the release'] } },
  { key: 'general', name: 'General team', modules: ['chats'], pack: null,
    starter: { key: 'general', name: 'Getting started', summary: 'Your team’s first week on Pulse.',
      steps: ['Move your current to-do list into Pulse', 'Agree how the week runs: who plans, who reviews', 'Ask everyone to install the phone app', 'Hold the first weekly review on Pulse'] } },
];
export const TEMPLATE = new Map(TEMPLATES.map((t) => [t.key, t]));

/** The modules a self-serve company chooses, and the switches behind each (the tenant/modules document's keys and the
 *  company's own tasks/chats/finance switches). Tasks and projects are always on. */
export const CHOICES: { key: ChoiceKey; name: string; modules: ModuleKey[] }[] = [
  { key: 'chats', name: 'Team chat', modules: ['chats'] },
  { key: 'money', name: 'Money: quotes, invoices and expenses', modules: ['money'] },
  { key: 'leads', name: 'Leads and sales pipeline', modules: ['acquisition'] },
  { key: 'hr', name: 'Leave and attendance', modules: ['hr'] },
  { key: 'briefs', name: 'Briefs', modules: ['briefs'] },
  { key: 'map', name: 'Map and site visits', modules: ['map'] },
];
/** Modules a new self-serve company starts without (they need set-up or an operator's offer); Settings turns them on. */
export const STARTS_OFF: ModuleKey[] = ['designers', 'relationships', 'skills', 'jobs'];

export type Seat = { key: SeatKey; label: string; kind: 'staff' | 'freelancer' | 'client'; who: string; sees: string[]; wont: string[]; tips: string[] };
export const SEATS: Seat[] = [
  { key: 'leadership', label: 'Leadership', kind: 'staff', who: 'Founders and partners who run the company with you.',
    sees: ['Every project, task and person', 'Money, reports and the company dashboard', 'Settings, invitations and roles'], wont: ['Other companies on Pulse'],
    tips: ['Start each week on the dashboard: what is late and who is stuck.', 'Invite your managers first; they bring their teams.', 'Give every project an owner and a due date.'] },
  { key: 'manager', label: 'Manager', kind: 'staff', who: 'People who lead a team or run projects.',
    sees: ['Their team’s tasks and projects', 'Leave and corrections to approve for their team', 'Team chats'], wont: ['Salaries and payroll', 'Company money and settings'],
    tips: ['Open My week each Monday and assign the week’s tasks.', 'Review finished work the same day so nobody waits.', 'Approve leave from the home page.'] },
  { key: 'staff', label: 'Team member', kind: 'staff', who: 'Employees who do the work.',
    sees: ['Their own tasks and the projects they are on', 'Chats they are in', 'Their own leave and profile'], wont: ['Other people’s salaries or HR records', 'Company money and settings'],
    tips: ['Check My day each morning: it lists what is due.', 'Mark a task done when it is done; add a note or a file as proof.', 'Ask questions in the task’s comments, not in private chats.'] },
  { key: 'sales', label: 'Sales rep', kind: 'staff', who: 'People who call leads and close deals.',
    sees: ['Leads and the pipeline (when Leads is on)', 'Their own tasks, follow-ups and chats'], wont: ['Salaries and HR records', 'Company money and settings'],
    tips: ['Log every call and its next step on the lead.', 'Follow-ups due today are on your home page.', 'Move a lead to its new stage as soon as it changes.'] },
  { key: 'freelancer', label: 'Freelancer', kind: 'freelancer', who: 'Outside help on some projects, paid per job.',
    sees: ['The tasks and projects you add them to', 'Chats they are in'], wont: ['Salaries, HR records and money', 'Settings and other companies’ work'],
    tips: ['Your tasks are on My day; open one to see the brief and files.', 'Upload your work on the task and mark it ready for review.', 'You keep one Pulse account for every company you work with.'] },
  { key: 'client', label: 'Client', kind: 'client', who: 'Customers who follow and approve their own work.',
    sees: ['Only the work you share with them', 'Chats you start with them'], wont: ['Anything internal: people, other clients, money, settings'],
    tips: ['Your shared tasks are under Work; approve or comment on each.', 'Use the chat to ask the team anything.', 'You can switch between companies with one Pulse account.'] },
];
export const SEAT = new Map(SEATS.map((s) => [s.key, s]));

/** The first-run checklist for leadership, in order. */
export const CHECKLIST = [
  { key: 'invite', label: 'Invite your team', href: '/start/team', note: 'Who to invite and what each seat sees.' },
  { key: 'project', label: 'Create your first project', href: '/tasks/projects', note: 'Your starter projects are there already; add one of your own.' },
  { key: 'targets', label: 'Set targets', href: '/tasks/projects', note: 'Give each project an owner and a due date.' },
  { key: 'app', label: 'Install the phone app', href: '/apps', note: 'Tasks, chats and approvals in your pocket.' },
] as const;

const str = (x: unknown, max: number) => String(x ?? '').slice(0, max);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type OnboardPayload = {
  name: string; handle: string; pack: unknown; templates: TemplateKey[]; timeZone: string; workDays: number[]; dayStart: string; dayEnd: string;
  modulesDoc: { off: ModuleKey[]; on: string[] }; companyModules: { chats: boolean; finance: boolean }; starters: Starter[];
};

/** The wizard's answers, cleaned: unknown keys refused, the modules each template brings when none were picked, and the
 *  starter projects of the chosen templates. A custom domain or address is never part of it (operator only). */
export function onboardingPlan(b: Record<string, unknown>): OnboardPayload | { error: string } {
  const name = str(b.name, 80).trim().replace(/\s+/g, ' ');
  if (name.length < 2) return { error: 'Give your company a name of 2 to 80 characters' };
  const templates = Array.isArray(b.templates) ? [...new Set(b.templates.map((t) => str(t, 20)))] : [];
  if (!templates.length) return { error: 'Choose what your company does' };
  if (templates.some((t) => !TEMPLATE.has(t as TemplateKey))) return { error: 'Choose from the listed kinds of work' };
  const chosen = templates as TemplateKey[];
  const picked = Array.isArray(b.modules) ? [...new Set(b.modules.map((m) => str(m, 20)))] : chosen.flatMap((t) => TEMPLATE.get(t)!.modules);
  if (picked.some((m) => !(CHOICE_KEYS as readonly string[]).includes(m))) return { error: 'Choose from the listed modules' };
  const on = new Set(picked as ChoiceKey[]);
  const off = new Set<ModuleKey>(STARTS_OFF);
  for (const c of CHOICES) if (!on.has(c.key)) c.modules.forEach((m) => off.add(m));
  const modulesDoc = { off: MODULE_KEYS.filter((k) => off.has(k)), on: [] as string[] };
  if (!validateModules(modulesDoc).valid) return { error: 'Those modules cannot be combined' };
  const days = Array.isArray(b.workDays) ? [...new Set(b.workDays.map(Number))].sort() : [1, 2, 3, 4, 5];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { error: 'Choose at least one working day' };
  const dayStart = str(b.dayStart || '09:30', 5), dayEnd = str(b.dayEnd || '18:30', 5);
  if (!TIME.test(dayStart) || !TIME.test(dayEnd) || dayEnd <= dayStart) return { error: 'Choose working hours: the day ends after it starts' };
  // Empty: the database's default zone (pulse.onboard_org); the wizard sends the browser's own.
  const timeZone = str(b.timeZone, 60);
  if (timeZone && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(timeZone)) return { error: 'Choose a time zone' };
  const packKey = chosen.map((t) => TEMPLATE.get(t)!.pack).find(Boolean) ?? 'neutral';
  const pack = PACK.get(packKey) ?? PACK.get('neutral');
  return { name, handle: str(b.handle, 40).trim().replace(/^@/, '').toLowerCase(), pack: pack ? packPayload(pack) : null, templates: chosen, timeZone,
    workDays: days, dayStart, dayEnd, modulesDoc, companyModules: { chats: on.has('chats'), finance: on.has('money') },
    starters: chosen.map((t) => TEMPLATE.get(t)!.starter) };
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** E-mail addresses pasted in bulk ("Asha <user-3eeffa7a@org-e6abb3.example>, user-bc0866ba@org-e6abb3.example; …" or one per line), lower-cased, each once. */
export function parseEmails(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [], invalid: string[] = [];
  for (const raw of String(text ?? '').slice(0, 20000).split(/[\s,;]+/)) {
    const part = raw.replace(/^.*</, '').replace(/>.*$/, '').replace(/^mailto:/i, '').trim().toLowerCase();
    if (!part || !part.includes('@')) { if (part.length > 2 && /[@.]/.test(part)) invalid.push(part); continue; }
    if (EMAIL.test(part) && part.length <= 254) { if (!emails.includes(part)) emails.push(part); } else invalid.push(part);
  }
  return { emails, invalid };
}

/** The invitation e-mail: who invited them, to what seat, what they will see, the link, and what to do when they
 *  already have a Pulse account (sign in with it, then open the link: the company joins their account). */
export function inviteMail(p: { org: string; by: string; seat: SeatKey; link: string; hasAccount: boolean }) {
  const s = SEAT.get(p.seat) ?? SEAT.get('staff')!;
  const title = `${p.by} invited you to ${p.org} on Pulse`;
  const body = [`Hello,`, ``, `${p.by} invited you to ${p.org} on Pulse as ${s.label.toLowerCase()}.`, ``,
    `You will see: ${s.sees.join('; ')}.`, `You won't see: ${s.wont.join('; ')}.`, ``,
    `Join here: ${p.link}`, ``,
    p.hasAccount ? `This e-mail already has a Pulse account: sign in with it (password, Google or a sign-in code), then open the link. ${p.org} is added to your account.`
      : `Opening the link makes your Pulse account (your name and a password). Already on Pulse with another e-mail? Sign in first, then open the link.`,
    ``, `The link is private, works once and expires in 14 days. Pulse never asks for your password by e-mail.`].join('\n');
  return { title, body };
}
