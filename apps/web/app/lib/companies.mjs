// CONNECTIONS part A (owner, 16 Nov 2026: the home said "9 companies" and he is not in nine). The companies a person is
// IN (a seat) are counted apart from their own personal space and from test or demo companies (pulse.org.purpose,
// 2199), and apart from the companies and people they only WORK WITH (a connection: client, vendor, partner).
// Pure: no clock, no browser. Used by the switcher, Organisations, Settings, My day and the home.

/** A test or demo company: it still opens, under its own heading, and is never counted. */
export const isPractice = (o) => o?.purpose === "test" || o?.purpose === "demo";
/** The person's own personal space. */
export const isPersonal = (o) => !!o && (o.mine === true || o.orgKind === "personal" || o.personal === true);
/** A real company the person is in. */
export const isRealCompany = (o) => !!o && !isPersonal(o) && !isPractice(o);

/** The switcher's order: my own space first, then the real companies (their order kept), then test and demo ones. */
export function switcherOrder(orgs) {
  const list = Array.isArray(orgs) ? orgs : [];
  return [...list.filter(isPersonal), ...list.filter(isRealCompany), ...list.filter((o) => !isPersonal(o) && isPractice(o))];
}

/** How many real companies, in words: "5 companies", "1 company", "No companies yet". */
export function companiesText(n) {
  const k = Number(n) || 0;
  return k === 0 ? "No companies yet" : k === 1 ? "1 company" : `${k} companies`;
}

/** A test or demo company's small label. */
export const practiceWord = (purpose) => (purpose === "demo" ? "Demo" : purpose === "test" ? "Test" : "");

/** One "work with" line, by what they are to the company the relationship lives in ("you" for your own space):
 *  "Client of Vitals", "Freelancer for you · Designer", "Vendor to EA", "Partner of AC". */
export function workWithLine(w) {
  if (!w) return "";
  const via = w.via?.personal ? "you" : w.via?.name ?? "";
  const role = w.role ? ` · ${w.role}` : "";
  switch (w.kind) {
    case "partner": return `Partner of ${via}${role}`;
    case "freelancer": return `Freelancer for ${via}${role}`;
    case "cofounder": return `Co-founder with ${via}`;
    case "advisor": return `Advisor to ${via}`;
    case "accountant": return `Accountant for ${via}`;
    case "investor": return `Investor in ${via}`;
    case "employee": return `Works for ${via}${role}`;
    case "vendor": return w.weServe ? `Client of ${via}` : `Vendor to ${via}${role}`;
    // weServe: the company I am in does the work for them (they are its client); else they do the work for us.
    default: return w.weServe ? `Client of ${via}` : `Works for ${via}${role}`;
  }
}

/** The same other party reached from several of my companies is one entry with each relationship listed. */
export function groupWorkWith(rows) {
  const by = new Map();
  for (const w of Array.isArray(rows) ? rows : []) {
    const key = w.org ? `org:${w.org}` : `name:${String(w.name ?? "").trim().toLowerCase()}`;
    const g = by.get(key) ?? { key, name: w.name, org: w.org ?? null, handle: w.handle ?? null, individual: !!w.individual, lines: [] };
    g.lines.push(workWithLine(w));
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** "Kite Studio is a demo company, so it is not counted." / "A and B are test or demo companies, so they are not counted." */
export function practiceLine(list) {
  const l = Array.isArray(list) ? list : [];
  if (!l.length) return "";
  if (l.length === 1) return `${l[0].name} is a ${l[0].purpose === "demo" ? "demo" : "test"} company, so it is not counted.`;
  const names = l.map((x) => x.name);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are test or demo companies, so they are not counted.`;
}
