// SELF-SERVE (owner, 4 Nov 2026): the sign-up's two questions, as the web shows them. The keys are the contract with
// services/api/src/self-serve-setup.ts (which owns what each answer sets up); its model test checks they match.
export const PROFILES = [
  { key: "employee", label: "I work at a company", hint: "Your own tasks, targets and week" },
  { key: "professional", label: "Professional practice", hint: "Psychologist, doctor, lawyer, CA, coach" },
  { key: "freelancer", label: "Freelancer", hint: "Projects for clients, paid per job" },
  { key: "creator", label: "Creator, model or artist", hint: "Content, shoots, bookings, brand deals" },
  { key: "owner", label: "Business owner", hint: "You run a company, shop or team" },
  { key: "student", label: "Student", hint: "Classes, assignments and exams" },
  { key: "other", label: "Something else", hint: "Plan your life and work your way" },
] as const;
export type ProfileKey = (typeof PROFILES)[number]["key"];

export const SPACES = [
  { key: "personal", label: "Just me", hint: "A personal space for your own life and work", served: null, named: false, hue: 172 },
  { key: "practice", label: "My practice", hint: "Therapist, doctor, lawyer, CA or coach", served: "clients", named: true, hue: 262 },
  { key: "agency", label: "Agency or studio", hint: "Marketing, design, video or software for clients", served: "clients", named: true, hue: 24 },
  { key: "shop", label: "Shop or store", hint: "A shop, salon, café or online store", served: "customers", named: true, hue: 142 },
  { key: "maker", label: "Manufacturer or dealer", hint: "You make, distribute or trade goods", served: "dealers", named: true, hue: 205 },
  { key: "real_estate", label: "Real estate", hint: "A developer, broker or channel partner", served: "buyers", named: true, hue: 340 },
  { key: "school", label: "School or classes", hint: "A school, coaching centre or course", served: "students", named: true, hue: 48 },
  { key: "ngo", label: "NGO or community", hint: "A charity, trust, club or volunteers", served: "donors", named: true, hue: 300 },
  { key: "other", label: "Another kind of organisation", hint: "Start plain and shape it in Settings", served: "clients", named: true, hue: 220 },
] as const;
export type SpaceKey = (typeof SPACES)[number]["key"];

/** What the people served are called (one choice; Settings → Industry & roles changes the words later). */
export const SERVED = [
  { key: "clients", label: "Clients" }, { key: "patients", label: "Patients" }, { key: "customers", label: "Customers" },
  { key: "students", label: "Students" }, { key: "members", label: "Members" }, { key: "buyers", label: "Buyers" },
  { key: "dealers", label: "Dealers" }, { key: "donors", label: "Donors" },
] as const;
export type ServedKey = (typeof SERVED)[number]["key"];

/** The second question's first suggestion from the first answer (the person can pick any). */
export function suggestSpace(profiles: readonly string[]): SpaceKey {
  if (profiles.includes("professional")) return "practice";
  if (profiles.includes("owner")) return "other";
  return "personal";
}

export type SetupAnswers = { profiles: ProfileKey[]; space: SpaceKey; served: ServedKey | null; orgName: string };
export const setupBody = (a: SetupAnswers) => ({ profiles: a.profiles, space: a.space, ...(a.space !== "personal" ? { served: a.served ?? undefined, orgName: a.orgName.trim() } : {}),
  timeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { return ""; } })() });
