/** A company's public card (GET /v1/directory/companies). Hidden fields are null; ids is [] unless shown. */
export type DirectoryCompany = {
  id: string;
  handle: string;
  name: string;
  legalName: string | null;
  city: string | null;
  industry: string | null;
  website: string | null;
  logo: string | null;
  verified: boolean;
  verifiedBy: "gstin" | "cin" | null;
  ids: { kind: string; label: string; value: string }[];
  match?: "id" | "handle" | "name" | "prefix" | "words" | "fuzzy" | "sounds";
};
/** A person who turned on "Let people find me" (GET /v1/directory/people). */
export type DirectoryPerson = {
  handle: string;
  name: string;
  headline: string | null;
  photo: string | null;
  company: { handle: string; name: string } | null;
  email: string | null;
  phone: string | null;
  match?: DirectoryCompany["match"];
};
/** A pending invite for a company not on Vitals (POST /api/v0/directory/invites). link is shown once. */
export type CompanyInvite = {
  id: string;
  companyName: string;
  email: string | null;
  phone: string | null;
  purpose: "contract" | "general";
  note: string | null;
  status: "pending" | "joined" | "cancelled";
  link?: string;
  createdAt: string;
  joinedAt: string | null;
  joinedCompany: { id: string; handle: string; name: string } | null;
};
type SearchOptions = { signal?: AbortSignal; limit?: number; fetchImpl?: typeof fetch };
export function gstinValid(value: unknown): boolean;
export function cinValid(value: unknown): boolean;
export function gstinProblem(value: unknown): string | null;
export function cinProblem(value: unknown): string | null;
export function matchWords(match: string | undefined): string;
export function initials(name: string | null | undefined): string;
export function searchUrl(kind: "companies" | "people", q: string, options?: { limit?: number; excludeOwn?: boolean }): string;
export function searchable(q: string | null | undefined): boolean;
export function searchCompanies(q: string, options?: SearchOptions & { excludeOwn?: boolean }): Promise<DirectoryCompany[]>;
export function searchPeople(q: string, options?: SearchOptions): Promise<DirectoryPerson[]>;
export function browseDirectory(options?: { signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ verified: DirectoryCompany[]; recent: DirectoryCompany[]; colleagues: DirectoryPerson[] }>;
export function contactKind(value: string | null | undefined): "email" | "phone" | null;
export function makeInvite(input: { companyName: string; contact: string; purpose?: "contract" | "general"; note?: string }, options?: { fetchImpl?: typeof fetch }): Promise<CompanyInvite>;
export function whatsappInvite(invite: Pick<CompanyInvite, "link" | "phone" | "purpose">, fromCompany?: string | null): string;
export function nextIndex(current: number, count: number, key: string): number;
