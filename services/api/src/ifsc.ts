// PEOPLE-CONTACTS (owner, 11 Oct 2026): "IFSC with validation, bank and branch auto-filled from IFSC".
// An IFSC is public reference data (bank + branch), never personal data, so the lookup may ask a public directory:
// Razorpay's open IFSC API (the RBI list), at PULSE_IFSC_URL. Answers are kept for a week in memory. Without the
// directory (PULSE_IFSC_LOOKUP=off, no network, a timeout) the bank still comes from the code's first four letters,
// from the table below, and the branch is typed by hand.
export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** The banks most salaries are paid into, by the first four letters of their IFSC. */
export const BANKS: Record<string, string> = {
  SBIN: "State Bank of India", HDFC: "HDFC Bank", ICIC: "ICICI Bank", UTIB: "Axis Bank", KKBK: "Kotak Mahindra Bank",
  PUNB: "Punjab National Bank", BARB: "Bank of Baroda", CNRB: "Canara Bank", UBIN: "Union Bank of India", IDIB: "Indian Bank",
  IOBA: "Indian Overseas Bank", BKID: "Bank of India", MAHB: "Bank of Maharashtra", CBIN: "Central Bank of India", UCBA: "UCO Bank",
  PSIB: "Punjab & Sind Bank", YESB: "Yes Bank", INDB: "IndusInd Bank", IDFB: "IDFC FIRST Bank", FDRL: "Federal Bank",
  KARB: "Karnataka Bank", KVBL: "Karur Vysya Bank", SIBL: "South Indian Bank", TMBL: "Tamilnad Mercantile Bank", CIUB: "City Union Bank",
  DCBL: "DCB Bank", RATN: "RBL Bank", BDBL: "Bandhan Bank", AUBL: "AU Small Finance Bank", ESFB: "Equitas Small Finance Bank",
  UJVN: "Ujjivan Small Finance Bank", JSFB: "Jana Small Finance Bank", PYTM: "Paytm Payments Bank", AIRP: "Airtel Payments Bank",
  IPOS: "India Post Payments Bank", FINO: "Fino Payments Bank", JAKA: "Jammu & Kashmir Bank", DLXB: "Dhanlaxmi Bank", CSBK: "CSB Bank",
  NTBL: "Nainital Bank", IBKL: "IDBI Bank", HSBC: "HSBC", SCBL: "Standard Chartered Bank", CITI: "Citibank", DBSS: "DBS Bank India",
  DEUT: "Deutsche Bank", SVCB: "SVC Co-operative Bank", COSB: "Cosmos Co-operative Bank", SRCB: "Saraswat Co-operative Bank",
  ABHY: "Abhyudaya Co-operative Bank", TJSB: "TJSB Sahakari Bank", JSBP: "Janata Sahakari Bank", NKGS: "NKGSB Co-operative Bank",
  BACB: "Bassein Catholic Co-operative Bank", KCCB: "Kalupur Commercial Co-operative Bank", APGB: "Andhra Pragathi Grameena Bank",
};

export type IfscAnswer = { ifsc: string; valid: boolean; known: boolean | null; bank: string | null; branch: string | null; city: string | null; state: string | null; source: "directory" | "bank code" | "none" };
const cache = new Map<string, { at: number; answer: IfscAnswer }>();
const WEEK = 7 * 86400000;

/** What Pulse can say about an IFSC. `known` is null when the directory could not be asked. */
export async function lookupIfsc(raw: string, fetcher: typeof fetch = fetch): Promise<IfscAnswer> {
  const ifsc = String(raw ?? "").replace(/\s/g, "").toUpperCase();
  const offline: IfscAnswer = { ifsc, valid: IFSC.test(ifsc), known: null, bank: BANKS[ifsc.slice(0, 4)] ?? null, branch: null, city: null, state: null, source: BANKS[ifsc.slice(0, 4)] ? "bank code" : "none" };
  if (!offline.valid || process.env.PULSE_IFSC_LOOKUP === "off") return offline;
  const hit = cache.get(ifsc); if (hit && Date.now() - hit.at < WEEK) return hit.answer;
  try {
    const base = process.env.PULSE_IFSC_URL || "https://ifsc.razorpay.com/";
    const r = await fetcher(new URL(encodeURIComponent(ifsc), base.endsWith("/") ? base : `${base}/`), { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
    let answer: IfscAnswer;
    if (r.status === 404) answer = { ...offline, known: false };
    else if (!r.ok) return offline;
    else {
      const d = await r.json() as Record<string, unknown>;
      const text = (k: string) => typeof d[k] === "string" && String(d[k]).trim() ? String(d[k]).replace(/\s+/g, " ").trim().slice(0, 120) : null;
      answer = { ifsc, valid: true, known: true, bank: text("BANK") ?? offline.bank, branch: text("BRANCH"), city: text("CITY"), state: text("STATE"), source: "directory" };
    }
    cache.set(ifsc, { at: Date.now(), answer });
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    return answer;
  } catch { return offline; }
}
