// COMPANY-SEARCH (8 Nov 2026): the directory's browser side. Find companies (name, @handle, GSTIN, CIN, any public ID)
// and people who turned on "Let people find me", through GET /api/v1/directory/… (the API's /v1/directory/…). Shared by
// <CompanyPicker> (Contracts), the "Find companies and people" page and ⌘K. Plain words at a 6th-7th grade level.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const STATES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")), "97", "99"]);

/** GSTIN check, the same as the database's pulse.gstin_valid: state code, shape and the mod-36 check letter. */
export function gstinValid(value) {
  const g = String(value ?? "").replace(/\s/g, "").toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$/.test(g) || !STATES.has(g.slice(0, 2))) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = ALPHABET.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36] === g[14];
}

const CIN_STATES = new Set("AN AP AR AS BR CH CG CT DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TG TN TR TS UK UP UR WB".split(" "));
const CIN_KINDS = new Set("PLC PTC GOI SGC FLC FTC GAP GAT NPL ULL ULT OPC".split(" "));
/** CIN check, the same as pulse.cin_valid (a CIN has no check digit: its parts are checked). */
export function cinValid(value) {
  const c = String(value ?? "").replace(/\s/g, "").toUpperCase();
  if (!/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(c)) return false;
  const year = Number(c.slice(8, 12));
  return CIN_STATES.has(c.slice(6, 8)) && year >= 1850 && year <= 2100 && CIN_KINDS.has(c.slice(12, 15));
}

/** What is wrong with a GSTIN as it is typed, in plain words; null when it is fine (or empty). */
export function gstinProblem(value) {
  const g = String(value ?? "").replace(/\s/g, "").toUpperCase();
  if (!g) return null;
  if (g.length !== 15) return `A GSTIN has 15 letters and numbers. This has ${g.length}.`;
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$/.test(g)) return "This does not look like a GSTIN. Check it for typos.";
  if (!STATES.has(g.slice(0, 2))) return `A GSTIN starts with a state code. ${g.slice(0, 2)} is not one.`;
  if (!gstinValid(g)) return "The last letter does not match the rest. Check it for typos.";
  return null;
}

export function cinProblem(value) {
  const c = String(value ?? "").replace(/\s/g, "").toUpperCase();
  if (!c) return null;
  if (c.length !== 21) return `A CIN has 21 letters and numbers. This has ${c.length}.`;
  return cinValid(c) ? null : "This does not look like a CIN. Check it for typos.";
}

/** Why a result came up, in a few words (shown small beside it). */
export function matchWords(match) {
  return ({ id: "Same ID", handle: "Same @handle", name: "Same name", prefix: "", words: "", fuzzy: "Close spelling", sounds: "Sounds like it" })[match] ?? "";
}

/** One or two capital letters for a company or person with no picture. */
export function initials(name) {
  const words = String(name ?? "").replace(/\b(pvt|private|ltd|limited|llp|the)\b\.?/gi, " ").trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[1]] : words.slice(0, 1)).map((w) => [...w][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** The search address for the browser (companies or people). */
export function searchUrl(kind, q, { limit = 8, excludeOwn = false } = {}) {
  const p = new URLSearchParams({ q: String(q ?? "").trim().slice(0, 120), limit: String(limit) });
  if (excludeOwn && kind === "companies") p.set("exclude_own", "1");
  return `/api/v1/directory/${kind}?${p}`;
}

/** Worth asking the server: at least 2 letters once spaces are dropped. */
export const searchable = (q) => String(q ?? "").replace(/\s+/g, "").length >= 2;

async function read(response) {
  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    const error = new Error(response.status === 429 ? "Too many searches. Wait a minute and try again."
      : response.status === 401 ? "Sign in again to search." : (data && typeof data.error === "string" ? data.error : "Search is not working right now. Try again."));
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function searchCompanies(q, { signal, limit = 8, excludeOwn = false, fetchImpl = fetch } = {}) {
  if (!searchable(q)) return [];
  const data = await read(await fetchImpl(searchUrl("companies", q, { limit, excludeOwn }), { signal, cache: "no-store" }));
  return Array.isArray(data?.companies) ? data.companies : [];
}

export async function searchPeople(q, { signal, limit = 8, fetchImpl = fetch } = {}) {
  if (!searchable(q)) return [];
  const data = await read(await fetchImpl(searchUrl("people", q, { limit }), { signal, cache: "no-store" }));
  return Array.isArray(data?.people) ? data.people : [];
}

/** UI-SWEEP: what to browse before anything is typed: verified and recently joined companies, and the people of your
 *  company who chose to be found. A list the answer lacks is empty, never invented. */
export async function browseDirectory({ signal, fetchImpl = fetch } = {}) {
  const data = await read(await fetchImpl("/api/v0/directory/browse", { signal, cache: "no-store" }));
  const list = (x) => (Array.isArray(x) ? x : []);
  return { verified: list(data?.verified), recent: list(data?.recent), colleagues: list(data?.colleagues) };
}

/** An e-mail or a phone, as typed into the invite form: which one it is, or null. */
export function contactKind(value) {
  const v = String(value ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  const digits = v.replace(/[\s()-]/g, "");
  if (/^\+?[0-9]{10,15}$/.test(digits)) return "phone";
  return null;
}

/** "Not on Vitals? Invite them": makes the pending invite. Pulse sends nothing; the answer carries the join link. */
export async function makeInvite({ companyName, contact, purpose = "general", note }, { fetchImpl = fetch } = {}) {
  const kind = contactKind(contact);
  if (!String(companyName ?? "").trim()) throw new Error("Type the company's name.");
  if (!kind) throw new Error("Type an e-mail, or a phone number with 10 numbers.");
  const body = { companyName: String(companyName).trim(), purpose, ...(note ? { note } : {}),
    ...(kind === "email" ? { email: String(contact).trim() } : { phone: String(contact).replace(/[\s()-]/g, "") }) };
  const data = await read(await fetchImpl("/api/v0/directory/invites", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }));
  return data.invite;
}

/** A WhatsApp link that only opens on the person's own device with the invite text filled in (nothing is sent by Pulse). */
export function whatsappInvite(invite, fromCompany) {
  const text = `${fromCompany ? `${fromCompany} invites you` : "You are invited"} to Vitals${invite?.purpose === "contract" ? " to sign an agreement" : ""}. Join here: ${invite?.link ?? ""}`;
  const phone = String(invite?.phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${phone.length === 10 ? `91${phone}` : phone}?text=${encodeURIComponent(text)}`;
}

/** The next row when moving with the arrow keys (wraps around; -1 means "none"). */
export function nextIndex(current, count, key) {
  if (count <= 0) return -1;
  if (key === "ArrowDown") return current < 0 || current >= count - 1 ? 0 : current + 1;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return current;
}
