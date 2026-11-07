// SELF-SERVE (owner, 4 Nov 2026: "anyone can open Pulse, make an account and manage their life or work by their type"):
// the two sign-up questions and the starting setup they make. "Which describes you?" (several at once, changeable in
// Settings → About you) and "What will you use Pulse for?" (a personal space, or an organisation of a kind), with what
// the people served are called. From the answers: the space (a personal one, or an organisation) and its tailored start:
// modules switched on, the company's words (clients, patients, customers …), its client types, starter projects with
// first steps and the getting-started cards on its home. Everything it sets stays editable in Settings (words in
// Industry & roles, modules in Modules, client types on Clients, the cards are ticked or put away). One person holds
// several types and several organisations: Start another space asks the second question again
// (db/migrations/1520_self_serve_setup.sql writes it; the web shows the same keys: apps/web/app/signup/setup-catalogue.ts).
import { MODULE_KEYS, validateModules, type ModuleKey } from './modules.js';
import { PACK, packPayload, NEUTRAL_WORDS, type Words } from './flow/packs.js';
import { CHOICES, STARTS_OFF, type ChoiceKey, type OnboardPayload } from './self-serve-model.js';

/** A starter project (a key of its own: pulse.onboard_org stores it as starter:<key>). */
export type Starter = { key: string; name: string; summary: string; steps: string[] };

export const PROFILE_KEYS = ['employee', 'professional', 'freelancer', 'creator', 'owner', 'student', 'other'] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export const SPACE_KEYS = ['personal', 'practice', 'agency', 'shop', 'maker', 'real_estate', 'school', 'ngo', 'other'] as const;
export type SpaceKey = (typeof SPACE_KEYS)[number];
export const SERVED_KEYS = ['clients', 'patients', 'customers', 'students', 'members', 'buyers', 'dealers', 'donors'] as const;
export type ServedKey = (typeof SERVED_KEYS)[number];

export const PROFILES: { key: ProfileKey; label: string; hint: string }[] = [
  { key: 'employee', label: 'I work at a company', hint: 'Your own tasks, targets and week, next to your company’s Pulse' },
  { key: 'professional', label: 'Professional practice', hint: 'Psychologist, doctor, lawyer, CA, coach, consultant' },
  { key: 'freelancer', label: 'Freelancer', hint: 'Projects for clients, paid per job' },
  { key: 'creator', label: 'Creator, model or artist', hint: 'Content, shoots, bookings and brand deals' },
  { key: 'owner', label: 'Business owner', hint: 'You run a company, shop or team' },
  { key: 'student', label: 'Student', hint: 'Classes, assignments, exams and study time' },
  { key: 'other', label: 'Something else', hint: 'Plan your life and work your way' },
];
export const PROFILE = new Map(PROFILES.map((p) => [p.key, p]));

/** What the people served are called: the company's words for one and many (Settings → Industry & roles edits them). */
export const SERVED: Record<ServedKey, { one: string; many: string }> = {
  clients: { one: 'Client', many: 'Clients' }, patients: { one: 'Patient', many: 'Patients' }, customers: { one: 'Customer', many: 'Customers' },
  students: { one: 'Student', many: 'Students' }, members: { one: 'Member', many: 'Members' }, buyers: { one: 'Buyer', many: 'Buyers' },
  dealers: { one: 'Dealer', many: 'Dealers' }, donors: { one: 'Donor', many: 'Donors' },
};

export type Card = { key: CardKey; label: string; href: string; note: string };
export const CARD_KEYS = ['client', 'appointment', 'invoice', 'invite', 'project', 'todo', 'words', 'app'] as const;
export type CardKey = (typeof CARD_KEYS)[number];
const CARD = {
  client: (one: string, many: string): Card => ({ key: 'client', label: `Add your first ${one.toLowerCase()}`, href: '/clients/add', note: `They get an e-mail with a link to their own space: no password needed. Your ${many.toLowerCase()} are listed under ${many}.` }),
  appointment: (): Card => ({ key: 'appointment', label: 'Book the first appointment', href: '/appointments', note: 'It shows in their space with the time and the place or video link.' }),
  invoice: (): Card => ({ key: 'invoice', label: 'Send your first invoice', href: '/erp/documents', note: 'Quotes and invoices carry your name; paid ones are marked when the money comes in.' }),
  invite: (): Card => ({ key: 'invite', label: 'Invite your team', href: '/start/team', note: 'Who to invite and what each seat sees.' }),
  project: (word: string): Card => ({ key: 'project', label: `Start your first ${word.toLowerCase()}`, href: '/tasks/projects', note: 'Your starter is there already, with its first steps; add one of your own.' }),
  todo: (): Card => ({ key: 'todo', label: 'Add three things to do this week', href: '/my-day', note: 'My day lists what is due first, across every space you are in.' }),
  words: (many: string): Card => ({ key: 'words', label: 'Check what Pulse calls things', href: '/settings?tab=industry', note: `It says ${many.toLowerCase()} now. Change any word in Settings → Industry & roles.` }),
  app: (): Card => ({ key: 'app', label: 'Install the phone app', href: '/apps', note: 'Tasks, reminders and messages in your pocket.' }),
};

type ClientType = { key: string; label: string; plural: string; color: string; hint: string };
type Space = {
  key: SpaceKey; label: string; hint: string; pack: string; served: ServedKey; modules: ChoiceKey[];
  words: Partial<Words>; clientTypes: ClientType[]; starter: Starter | null; cards: (w: Words) => Card[]; home: string;
};
const ct = (key: string, label: string, plural: string, color: string, hint: string): ClientType => ({ key, label, plural, color, hint });

export const SPACES: Space[] = [
  { key: 'personal', label: 'Just me', hint: 'A personal space for your own life and work. Start an organisation any time.', pack: 'neutral', served: 'clients',
    modules: [], words: {}, clientTypes: [], starter: null, home: '/my-day',
    cards: () => [CARD.todo(), CARD.project('project'), CARD.app()] },
  { key: 'practice', label: 'My practice', hint: 'A therapist, doctor, lawyer, CA or coach, alone or with a small team', pack: 'neutral', served: 'clients',
    modules: ['chats', 'money'], words: { run: 'Session', runs: 'Sessions', lead: 'Enquiry', leads: 'Enquiries' }, home: '/dashboard',
    clientTypes: [ct('individual', 'Individual', 'Individuals', 'blue', 'One person you see on their own.'), ct('couple_family', 'Couple or family', 'Couples and families', 'violet', 'People you see together.'),
      ct('organisation', 'Organisation', 'Organisations', 'teal', 'A company or school you work with.')],
    starter: { key: 'practice', name: 'Set up my practice', summary: 'Your services, your first clients and how they book and pay.',
      steps: ['Write down your services and fees', 'Add your first client', 'Book the first appointment', 'Send the first invoice', 'Share your booking hours with clients'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.appointment(), CARD.invoice(), CARD.words(w.clients), CARD.app()] },
  { key: 'agency', label: 'Agency or studio', hint: 'Marketing, design, video, software or any work for clients', pack: 'marketing_agency', served: 'clients',
    modules: ['chats', 'money', 'briefs'], words: {}, home: '/dashboard',
    clientTypes: [ct('brand', 'Brand', 'Brands', 'orange', 'A business you make work for.'), ct('startup', 'Startup', 'Startups', 'violet', 'A young company.'),
      ct('individual', 'Individual', 'Individuals', 'blue', 'One person, such as a creator or a founder.')],
    starter: { key: 'agency', name: 'First client project', summary: 'One client’s work from the brief to the invoice, with the people on it.',
      steps: ['Write the brief and the scope', 'Agree deliverables and dates with the client', 'Add the team and freelancers on it', 'Share the first draft for review', 'Send the invoice'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.invite(), CARD.project(w.project), CARD.invoice(), CARD.app()] },
  { key: 'shop', label: 'Shop or store', hint: 'A shop, salon, café, studio or online store', pack: 'neutral', served: 'customers',
    modules: ['chats', 'money', 'leads'], words: { lead: 'Enquiry', leads: 'Enquiries', run: 'Order', runs: 'Orders' }, home: '/dashboard',
    clientTypes: [ct('regular', 'Regular', 'Regulars', 'green', 'Comes back often.'), ct('walk_in', 'Walk-in', 'Walk-ins', 'blue', 'Came in once.'),
      ct('wholesale', 'Wholesale', 'Wholesale', 'amber', 'Buys in bulk.')],
    starter: { key: 'shop', name: 'Run the shop on Pulse', summary: 'Products and prices, your regular customers and the week’s sales.',
      steps: ['Add your products and prices', 'Add your regular customers', 'Write down this week’s orders', 'Send the first bill', 'Plan next week’s stock'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.invoice(), CARD.invite(), CARD.words(w.clients), CARD.app()] },
  { key: 'maker', label: 'Manufacturer or dealer', hint: 'You make, distribute or trade goods', pack: 'neutral', served: 'dealers',
    modules: ['chats', 'money', 'leads', 'hr'], words: { lead: 'Enquiry', leads: 'Enquiries', run: 'Order', runs: 'Orders' }, home: '/dashboard',
    clientTypes: [ct('dealer', 'Dealer', 'Dealers', 'blue', 'Sells your goods on.'), ct('distributor', 'Distributor', 'Distributors', 'violet', 'Supplies dealers in a region.'),
      ct('retailer', 'Retailer', 'Retailers', 'green', 'A shop that stocks your goods.'), ct('direct', 'Direct buyer', 'Direct buyers', 'amber', 'Buys from you directly.')],
    starter: { key: 'maker', name: 'Orders to delivery', summary: 'Each order from the enquiry to the dispatch and the payment.',
      steps: ['Add your products and price list', 'Add your dealers and distributors', 'Write down open orders', 'Plan this week’s dispatch', 'Follow up unpaid invoices'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.invite(), CARD.invoice(), CARD.words(w.clients), CARD.app()] },
  { key: 'real_estate', label: 'Real estate', hint: 'A developer, broker or channel partner', pack: 'real_estate_developer', served: 'buyers',
    modules: ['chats', 'money', 'leads', 'map'], words: {}, home: '/dashboard',
    clientTypes: [ct('buyer', 'Buyer', 'Buyers', 'blue', 'Buying a home or an office.'), ct('investor', 'Investor', 'Investors', 'green', 'Buying to invest.'),
      ct('channel_partner', 'Channel partner', 'Channel partners', 'violet', 'Brings buyers to you.')],
    starter: { key: 'real_estate', name: 'First project launch', summary: 'Enquiries, site visits and bookings for one project.',
      steps: ['Add the project and its units', 'Add this week’s enquiries', 'Plan the site visits', 'Send the cost sheet', 'Book the first unit'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.invite(), CARD.project(w.project), CARD.app()] },
  { key: 'school', label: 'School or classes', hint: 'A school, coaching centre, academy or course', pack: 'neutral', served: 'students',
    modules: ['chats', 'money', 'hr'], words: { team: 'Class', teams: 'Classes', project: 'Course', projects: 'Courses', run: 'Batch', runs: 'Batches' }, home: '/dashboard',
    clientTypes: [ct('student', 'Student', 'Students', 'blue', 'Learns with you.'), ct('parent', 'Parent', 'Parents', 'violet', 'A parent or guardian.'),
      ct('organisation', 'Organisation', 'Organisations', 'teal', 'A company that sends its people.')],
    starter: { key: 'school', name: 'This term', summary: 'Courses, batches, fees and the term’s dates.',
      steps: ['Add this term’s courses and batches', 'Add your teachers', 'Add the first students', 'Send the fee reminders', 'Put the exam dates in'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.invite(), CARD.project(w.project), CARD.invoice(), CARD.app()] },
  { key: 'ngo', label: 'NGO or community', hint: 'A charity, trust, club or volunteer group', pack: 'neutral', served: 'donors',
    modules: ['chats', 'money'], words: { project: 'Programme', projects: 'Programmes' }, home: '/dashboard',
    clientTypes: [ct('donor', 'Donor', 'Donors', 'green', 'Gives money or goods.'), ct('beneficiary', 'Beneficiary', 'Beneficiaries', 'blue', 'Someone you help.'),
      ct('volunteer', 'Volunteer', 'Volunteers', 'violet', 'Gives their time.'), ct('partner', 'Partner', 'Partners', 'teal', 'An organisation you work with.')],
    starter: { key: 'ngo', name: 'First programme', summary: 'One programme: its goal, the volunteers, the donors and the report.',
      steps: ['Write the programme’s goal', 'Add your volunteers', 'Add your donors', 'Plan the first activity', 'Write the first report for donors'] },
    cards: (w) => [CARD.client(w.client, w.clients), CARD.invite(), CARD.project(w.project), CARD.app()] },
  { key: 'other', label: 'Another kind of organisation', hint: 'Any team: start plain and shape it in Settings', pack: 'neutral', served: 'clients',
    modules: ['chats'], words: {}, home: '/dashboard', clientTypes: [],
    starter: { key: 'general', name: 'Getting started', summary: 'Your team’s first week on Pulse.',
      steps: ['Move your current to-do list into Pulse', 'Agree how the week runs: who plans, who reviews', 'Ask everyone to install the phone app', 'Hold the first weekly review on Pulse'] },
    cards: (w) => [CARD.invite(), CARD.project(w.project), CARD.todo(), CARD.app()] },
];
export const SPACE = new Map(SPACES.map((s) => [s.key, s]));

/** A personal space's starters: one for each of the person's types (at most three), the plain list when none fits. */
const PERSONAL: Partial<Record<ProfileKey, Starter>> = {
  employee: { key: 'my_work', name: 'My work', summary: 'Your own week at work: what is due, your targets and what you are learning.',
    steps: ['Write down this week’s work', 'Set one target for the month', 'Note what you finished each Friday'] },
  professional: { key: 'my_practice', name: 'My practice', summary: 'Your own plan for the practice, before you open it to clients.',
    steps: ['Write down your services and fees', 'List the clients you see this week', 'Start your practice space when you are ready to invite them'] },
  freelancer: { key: 'freelance', name: 'Client work', summary: 'Each job from the brief to the payment.',
    steps: ['Add the jobs you have now', 'Put the due dates in', 'Send the invoice when a job is done'] },
  creator: { key: 'creator', name: 'Content calendar', summary: 'What goes out this month, who makes it and when it is due.',
    steps: ['Plan this month’s posts and videos', 'Script the next three pieces', 'Shoot and edit', 'Publish and note what worked'] },
  owner: { key: 'owner', name: 'Business to-dos', summary: 'What the business needs from you this week.',
    steps: ['Write down this week’s top three', 'List the payments to chase', 'Start your organisation and invite the team'] },
  student: { key: 'studies', name: 'My studies', summary: 'Subjects, assignments and exams in one plan.',
    steps: ['Add this term’s subjects', 'Put in the assignment due dates', 'Put in the exam dates', 'Plan the week’s study hours'] },
};
const PLAIN: Starter = { key: 'personal', name: 'My plans', summary: 'Your own to-dos, goals and reminders.',
  steps: ['Write down three things for this week', 'Add a goal for the month', 'Add the bills and renewals to remember'] };

const str = (x: unknown, max: number) => String(x ?? '').slice(0, max);
const keys = <T extends string>(x: unknown, allowed: readonly T[]): T[] | null => {
  const list = Array.isArray(x) ? [...new Set(x.map((k) => str(k, 30)))] : [];
  return list.every((k) => (allowed as readonly string[]).includes(k)) ? list as T[] : null;
};

/** The people served word a space starts with (the person may choose another). */
export const servedFor = (space: SpaceKey, profiles: ProfileKey[] = []): ServedKey =>
  space === 'practice' && profiles.includes('professional') ? 'clients' : SPACE.get(space)?.served ?? 'clients';

export type Setup = { space: SpaceKey; profiles: ProfileKey[]; served: ServedKey; clientTypes: ClientType[]; cards: Card[]; home: string };
export type SetupPayload = Omit<OnboardPayload, 'starters' | 'templates'> & { starters: Starter[]; templates: string[]; setup: Setup };

/** The two answers (and the name), cleaned into the one payload pulse.onboard_org writes plus its setup: unknown keys
 *  refused, the space's modules, its pack with the chosen words for the people served, its client types, starters and
 *  cards. A personal space is named after the person and has starters for each of their types. */
export function setupPlan(b: Record<string, unknown>, personName = ''): SetupPayload | { error: string } {
  const profiles = keys(b.profiles, PROFILE_KEYS);
  if (!profiles) return { error: 'Choose from the listed kinds of person' };
  if (!profiles.length) return { error: 'Choose what describes you: one or more' };
  const spaceKey = str(b.space, 30) as SpaceKey;
  const space = SPACE.get(spaceKey);
  if (!space) return { error: 'Choose what you will use Pulse for' };
  const personal = space.key === 'personal';
  const servedKey = (str(b.served, 30) || servedFor(space.key, profiles)) as ServedKey;
  if (!SERVED[servedKey]) return { error: 'Choose what you call the people you serve' };
  const person = personName.trim().replace(/\s+/g, ' ');
  const name = personal ? (person.length >= 2 ? `${person.slice(0, 70)}'s Pulse` : '') : str(b.orgName, 80).trim().replace(/\s+/g, ' ');
  if (name.length < 2) return { error: personal ? 'Give your name' : 'Give your organisation a name of 2 to 80 characters' };
  const pack = PACK.get(space.pack) ?? PACK.get('neutral')!;
  const words: Words = { ...NEUTRAL_WORDS, ...pack.words, ...space.words, client: SERVED[servedKey].one, clients: SERVED[servedKey].many };
  const on = new Set(space.modules.filter((m) => !(personal && m === 'chats')));
  if (personal && profiles.some((p) => p === 'freelancer' || p === 'professional' || p === 'owner')) on.add('money');
  const off = new Set<ModuleKey>(STARTS_OFF);
  for (const c of CHOICES) if (!on.has(c.key)) c.modules.forEach((m) => off.add(m));
  const modulesDoc = { off: MODULE_KEYS.filter((k) => off.has(k)), on: [] as string[] };
  if (!validateModules(modulesDoc).valid) return { error: 'Those modules cannot be combined' };
  const timeZone = str(b.timeZone, 60);
  if (timeZone && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(timeZone)) return { error: 'Choose a time zone' };
  const starters = personal ? (() => { const s = profiles.map((p) => PERSONAL[p]).filter((x): x is Starter => !!x).slice(0, 3); return s.length ? s : [PLAIN]; })()
    : [space.starter!, ...(profiles.includes('creator') && space.key !== 'school' ? [PERSONAL.creator!] : [])].slice(0, 3);
  return {
    name, handle: str(b.handle, 40).trim().replace(/^@/, '').toLowerCase(), pack: { ...packPayload(pack), words }, templates: [`space:${space.key}`],
    timeZone, workDays: personal ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6], dayStart: '09:30', dayEnd: '18:30', modulesDoc,
    companyModules: { chats: on.has('chats'), finance: on.has('money') }, starters,
    setup: { space: space.key, profiles, served: servedKey, clientTypes: space.clientTypes, cards: space.cards(words), home: space.home },
  };
}

/** The e-mail a professional's client gets: who set up their space, what is in it, the one-click link. */
export function practiceInviteMail(p: { org: string; by: string; contact: string; link: string; message?: string }) {
  const first = p.contact.trim().split(/\s+/)[0] || 'there';
  return {
    subject: `${p.by} has set up your space on Pulse`,
    body: `Hi ${first},\n\n${p.by} (${p.org}) uses Pulse for appointments, files, invoices and messages. Your own space is ready.`
      + (p.message ? `\n\n${p.message}` : '')
      + `\n\nOpen it with one click (no password needed):\n${p.link}\n\nThe link is only for you and works for 30 days. Next time, sign in with a code Pulse e-mails to this address.`,
  };
}
