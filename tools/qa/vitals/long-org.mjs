#!/usr/bin/env node
// QA-1D (QA system stage 1, step 4b; QA-SYSTEM-RESEARCH §4.4 R14 and §6 step 4): fills the "long" QA company on DEV
// with the data real companies have and fixtures never do, through the app's own API (as its synthetic people, the way
// they would type it): names of 40 characters and more, unbroken long words, Hindi and Marathi (Devanagari), long titles
// and task names, "100%", crore amounts, and quotations in all nine stages (draft, awaiting approval, approved, sent,
// negotiating, accepted, declined, lost, cancelled).
//
//   1. python3 tools/admin/qa-org.py --profile long --dsn-env /etc/estate-autopilots/db/pulse_dev.env:MIGRATE_DATABASE_URL \
//        --approver "…" --words "…" --apply                      (the company @vitalsqalong and its qal.* logins)
//   2. node tools/qa/vitals/long-org.mjs [--credentials ~/.config/vitals-qa/dev-long.json] [--dry-run]
//   3. role-walk.mjs / night-matrix.mjs --credentials ~/.config/vitals-qa/dev-long.json: the Readability Gate on it (R14).
//
// Dev only (refused for any other address). A run again adds only what is missing (records are found by their names, a
// quotation by its "[QAL-nn]" note). Prints counts only: never a password, a cookie or a key.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, vitalsEnv } from "./vitals-env.mjs";

export const DEVANAGARI = /[ऀ-ॿ]/;
const pick = (list, i) => list[i % list.length];
const CRORE = 1e7 * 100; // ₹1 crore in paise (the API's amounts are paise)

// People: given names, middle names and surnames as they are written, in English, Hindi and Marathi.
const EN = {
  first: ["Venkataramanan", "Subrahmanyeswara", "Lakshminarayanan", "Aishwaryalakshmi", "Rajarajeswari", "Visweswaraiah", "Parthasarathy",
    "Satyanarayana", "Purushothaman", "Muthukumaraswamy", "Bhagyalakshmi", "Ramalingeswara", "Dhanalakshmi", "Krishnamoorthy", "Chandrasekharan", "Jayalakshmi"],
  middle: ["Ramachandra", "Gopalakrishna", "Balasubramanian", "Narasimhamurthy", "Venkateswarlu", "Srinivasaraghavan", "Annapoorneswari", "Thiruvengadam"],
  last: ["Krishnamurthy-Iyengar", "Bhattacharjee-Chatterjee", "Raghunathan-Pillai", "Mukhopadhyay-Banerjee", "Venkataraman-Sastry",
    "Chakraborty-Sengupta", "Vaidyanathan-Iyer", "Ramasubramanian", "Gangopadhyay-Roychowdhury", "Narayanaswamy-Reddy"],
};
const HI = {
  first: ["राजेश्वरी", "विश्वनाथ", "सत्यनारायण", "लक्ष्मीनारायण", "धर्मेन्द्र", "ज्ञानेश्वर", "हरिप्रसाद", "चंद्रप्रकाश", "शिवशंकर", "रामेश्वरी"],
  middle: ["प्रसाद", "कुमार", "नारायण", "शंकर", "मोहन", "किशोर"],
  last: ["श्रीवास्तव-चतुर्वेदी", "त्रिपाठी-उपाध्याय", "बंद्योपाध्याय", "अग्निहोत्री-शुक्ला", "मिश्रा-द्विवेदी", "भारद्वाज-शर्मा"],
};
const MR = {
  first: ["ज्ञानेश्वरी", "श्रीनिवास", "विठ्ठलराव", "पांडुरंग", "सावित्रीबाई", "ऋतुजा", "अहिल्याबाई", "दत्तात्रय"],
  middle: ["गोपाळराव", "बाळकृष्ण", "रघुनाथ", "सदाशिव", "नारायणराव", "विष्णुपंत"],
  last: ["देशमुख-पाटील", "कुलकर्णी-जोशी", "गायकवाड-शिंदे", "निंबाळकर-भोसले", "पुरंदरे-देशपांडे", "जाधव-मोहिते"],
};
const TITLES = ["Senior Executive – Customer Onboarding, Documentation & Registrations", "Assistant Manager – Accounts Receivable & GST Reconciliation",
  "Site Engineer – Structural Works, Quality Control & Safety Compliance", "वरिष्ठ विक्री अधिकारी – निवासी व व्यावसायिक प्रकल्प (पुणे विभाग)",
  "Relationship Manager – Channel Partners, Brokers & Corporate Tie-ups", "वरिष्ठ लेखा अधिकारी – कर, लेखा परीक्षा एवं अनुपालन विभाग",
  "Graphic Designer – Brochures, Hoardings, Daruhis Campaigns & Walkthroughs", "Customer Relationship Executive – Possession & After-Sales Service",
  "Procurement Officer – Cement, Steel, Electricals & Plumbing Materials", "मनुष्यबळ विकास अधिकारी – भरती, प्रशिक्षण व वेतनपट",
  "Liaison Officer – Municipal Approvals, RERA Filings & Land Records", "Junior Architect – Working Drawings, BOQ Preparation & Site Coordination"];

function personName(i) {
  const set = [EN, HI, MR][i % 3];
  const k = Math.floor(i / 3);
  // Every name at least 40 characters: more middle names where the parts are short (as many people's are).
  const middles = [pick(set.middle, k + 1)];
  const name = () => `${pick(set.first, k)} ${middles.join(" ")} ${pick(set.last, k + 2)}`;
  for (let n = 3; [...name()].length < 40; n += 2) middles.push(pick(set.middle, k + n));
  return name();
}

const CLIENTS = ["Shree Siddhivinayak Infrastructure & Realty Developers Private Limited", "Bhagyalakshmi Agro-Industries & Cold Storage Co-operative Society Ltd",
  "श्री स्वामी समर्थ बांधकाम व विकास प्रायव्हेट लिमिटेड, पिंपरी-चिंचवड", "गंगा-यमुना इन्फ्रास्ट्रक्चर एवं रियल एस्टेट प्राइवेट लिमिटेड, लखनऊ",
  "Venkateswara Hospitality, Resorts & Convention Centres (India) LLP", "महालक्ष्मी कृषी उत्पादक सहकारी संस्था मर्यादित, बारामती",
  "Kanchenjunga Pharmaceuticals, Nutraceuticals & Life Sciences Limited", "Dakshin Bharat Educational & Charitable Trust – Engineering Campus",
  "राष्ट्रीय ग्रामीण आवास एवं शहरी विकास सहकारी समिति लिमिटेड", "Sahyadri Logistics, Warehousing & Cold Chain Solutions Private Limited",
  "पुणे जिल्हा नागरी सहकारी गृहनिर्माण महासंघ मर्यादित (संघटित)", "Thiruvananthapuram Software Technology Park Tenants' Welfare Association",
  "Brahmaputra Valley Tea Estates, Exports & Plantation Holdings Ltd", "श्री गुरुकृपा हॉस्पिटल्स अँड मल्टीस्पेशालिटी रिसर्च सेंटर",
  "Konkan Railway Station-Area Commercial Complex Redevelopment Authority", "हिमालयन ऑर्गेनिक फ़ूड्स एंड बेवरेजेज़ प्राइवेट लिमिटेड, देहरादून",
  "Narmada Valley Renewable Energy, Solar Parks & Power Transmission Ltd", "सह्याद्री डोंगररांग पर्यटन विकास व निसर्ग संवर्धन संस्था",
  "Rajasthan Marble, Granite & Natural Stone Exporters Consortium Pvt Ltd", "विदर्भ कापूस उत्पादक व वस्त्रोद्योग सहकारी संघ मर्यादित, नागपूर",
  "Coromandel Coast Fisheries, Seafood Processing & Export House Pvt Ltd", "काशी विश्वनाथ धर्मशाला एवं तीर्थयात्री सेवा न्यास, वाराणसी",
  "Western Ghats Biodiversity Research & Eco-Tourism Foundation (Section 8)", "मराठवाडा जलसंधारण व सूक्ष्म सिंचन उपकरण उत्पादक कंपनी लिमिटेड"];

const PROJECTS = ["Sahyadri Heights Phase III – 42-Storey Twin Towers with Podium Parking, Kharghar Node 35",
  "पुणे–नाशिक औद्योगिक कॉरिडॉर गोदाम संकुल (टप्पा २) – ३,२०,००० चौरस फूट",
  "Venkateswara Convention Centre Interiors, Acoustics, Lighting & Audio-Visual Integration",
  "गंगा-यमुना आवासीय परियोजना – 1,248 फ्लैट, क्लब हाउस एवं 100% सौर ऊर्जा आपूर्ति",
  "Brahmaputra Valley Tea Estate Factory Modernisation, Withering Troughs & Effluent Treatment",
  "Thiruvananthapuram Technopark Tower C – Fit-out of Floors 9 to 17 for 3,600 Seats",
  "महालक्ष्मी शीतगृह व कांदा चाळ प्रकल्प – बारामती, इंदापूर व दौंड तालुका",
  "Narmada Solar Park Block 7 – 125 MW Ground-Mounted Plant with 33/220 kV Pooling Substation",
  "Konkan Railway Station-Area Redevelopment – Multi-Level Car Park & Retail Arcade",
  "हिमालयन ऑर्गेनिक फ़ूड्स – नई बॉटलिंग लाइन, कोल्ड रूम एवं गुणवत्ता प्रयोगशाला",
  "Dakshin Bharat Engineering Campus – Hostel Blocks D, E & F with 1,800 Beds and Mess Hall",
  "Coromandel Seafood Export House – IQF Freezing Tunnel, Ice Plant & Packaging Hall"];

const TASK_VERBS = ["share the revised bill of quantities with GST and labour-cess lines",
  "collect the signed agreement, stamp-duty receipt and 100% advance",
  "joint site inspection with structural consultant and fire officer",
  "अंतिम ड्रॉइंग्स, सामग्री सूची और भुगतान अनुसूची भेजकर पुष्टि लें",
  "करारनामा व मुद्रांक शुल्काची पावती मिळवून फाईल पूर्ण करा",
  "reconcile 18% GST input credit, TDS and retention money",
  "upload as-built drawings, test certificates and warranty cards",
  "buyer walkthrough and confirm 100% snag-list closure",
  "ग्राहक भुगतान का 100% मिलान करें और बकाया राशि की सूची बनाएं",
  "साइटवरील सुरक्षा तपासणी अहवाल व अग्निशमन ना-हरकत प्रमाणपत्र मिळवा",
  "renew contractor all-risk insurance and labour licence before expiry",
  "follow up HT load sanction MSEDCL/PUNE/HTC/2026-27/000012345678"];

const LINES = [
  ["Civil and structural works including RCC frame, masonry, plastering and waterproofing as per approved drawings", "Lumpsum"],
  ["संपूर्ण विद्युत कार्य – वायरिंग, स्विचगियर, डीजी सेट, लिफ्ट पॉवर व आपत्कालीन प्रकाश व्यवस्था", "Lumpsum"],
  ["Premium Italian marble flooring with skirting, polishing and 10-year workmanship warranty", "Sq.ft"],
  ["Façade glazing – double-glazed unitised curtain wall with low-E coating and structural silicone", "Sq.m"],
  ["प्लंबिंग, अग्निशमन, स्प्रिंकलर एवं वर्षा जल संचयन प्रणाली – सम्पूर्ण आपूर्ति, स्थापना एवं परीक्षण", "Lumpsum"],
  ["Rooftop solar photovoltaic plant with net metering, monitoring and five-year comprehensive maintenance", "kWp"],
  ["Landscaping, hardscape, children's play area, jogging track and 100% drip irrigation", "Lumpsum"],
  ["Complimentary site survey, soil investigation and 3D walkthrough (100% discount for repeat clients)", "Nos"],
];
export const STAGES = ["draft", "approval", "issued", "sent", "negotiating", "accepted", "declined", "lost", "cancelled"];

/** The whole fixture, the same on every run (so a run again finds what the last one made). */
export function longFixture() {
  const people = Array.from({ length: 48 }, (_, i) => ({ name: personName(i), role: pick(TITLES, i) }));
  const clients = CLIENTS.map((name, i) => ({ name, contact: personName(i + 7) }));
  const projects = PROJECTS.map((title, i) => ({ title, client: pick(CLIENTS, i) }));
  // 120 different tasks (12 kinds × 12 projects, the project first), titles up to the 120 characters a task takes.
  const tasks = Array.from({ length: 120 }, (_, i) => {
    const project = pick(PROJECTS, Math.floor(i / TASK_VERBS.length));
    const title = `${project.split(" – ")[0]}: ${pick(TASK_VERBS, i)}`;
    return { title: [...title].length > 120 ? `${[...title].slice(0, 119).join("").trimEnd()}…` : title, project: i % 3 === 2 ? null : project,
      priority: pick(["normal", "high", "urgent", "low"], i), dueIn: (i % 50) - 10, assignee: i % 4 };
  });
  const quotes = Array.from({ length: STAGES.length * 2 }, (_, i) => {
    const stage = STAGES[i % STAGES.length];
    const lines = Array.from({ length: 3 + (i % 4) }, (_, j) => {
      const [description, unit] = pick(LINES, i + j);
      const free = description.includes("100% discount");
      // Crore amounts: ₹1.25 crore to about ₹98.7 crore a line before GST (the API takes paise).
      return { description, details: `${pick(PROJECTS, i)}. Includes: ${pick(TASK_VERBS, j)}.`.slice(0, 1000), unit, qty: free ? 1 : 1 + ((i + j) % 3),
        rate: free ? 25_00_000 * 100 : Math.round((1.25 + ((i * 7 + j * 13) % 97)) * CRORE / 10_000) * 10_000, gstRate: pick([18, 12, 5, 28], i + j),
        ...(free ? { discountPercent: 100 } : {}) };
    });
    return { key: `QAL-${String(i + 1).padStart(2, "0")}`, stage, client: pick(CLIENTS, i), lines,
      note: `[QAL-${String(i + 1).padStart(2, "0")}] ${pick(["Payment: 10% booking amount, 40% on plinth, 40% on slab, 10% on possession.", "भुगतान: 30% अग्रिम, 60% कार्य प्रगति अनुसार, 10% हस्तांतरण पर।", "देयक: 25% आगाऊ, 65% कामाच्या प्रगतीनुसार, 10% ताबा देताना."], i)}` };
  });
  const settings = { legalName: "Sahyadri Long-Name Stress Testing & Quality Assurance Company Private Limited (TEST)",
    tradeName: "Vitals QA लंबे नाम (TEST)", stateCode: "27",
    address: ["Unit 1204, 12th Floor, Tower B, Bhaveshwar Arcade Annexe, Lal Bahadur Shastri Marg", "घाटकोपर (पश्चिम), मुंबई – 400086, महाराष्ट्र"] };
  return { people, clients, projects, tasks, quotes, settings };
}

const listOf = (j, ...keys) => (Array.isArray(j) ? j : keys.map((k) => j?.[k]).find(Array.isArray) || []);
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = args.credentials || path.join(os.homedir(), ".config/vitals-qa/dev-long.json");
  const fx = longFixture();
  if (args["dry-run"]) {
    console.log(JSON.stringify({ dryRun: true, people: fx.people.length, clients: fx.clients.length, projects: fx.projects.length, tasks: fx.tasks.length,
      quotes: fx.quotes.length, stages: STAGES }));
    return 0;
  }
  const V = vitalsEnv("dev", { credentials });
  if (!V.DEV || new URL(V.ORIGIN).host === "app.vitalsos.ai") throw new Error("long-org.mjs fills dev only");
  if (V.creds.profile !== "long") throw new Error(`${credentials} is not the long QA company's (qa-org.py --profile long)`);
  const out = { org: V.creds.org.handle, made: {}, existed: {}, failed: [] };
  const count = (k, made) => { const o = made ? out.made : out.existed; o[k] = (o[k] || 0) + 1; };
  const fail = (what, r) => out.failed.push(`${what}: ${r.status} ${String(r.json?.error || r.json?.message || r.text || "").replace(/\s+/g, " ").slice(0, 140)}`);
  const sessions = [];
  const as = async (role) => {
    const s = await V.signIn(role);
    if (s.error) throw new Error(`${role} signs in: ${s.error}`);
    sessions.push(s.jar);
    const call = (p, o = {}) => V.call(p, { ...o, cookies: { pulse_session: s.jar.pulse_session } });
    const me = await call("/api/v0/me");
    return { call, id: me.json?.person?.id || me.json?.personId || me.json?.person };
  };
  try {
    const owner = await as("owner");
    const seller = await as("seller");
    const ok = (r) => r.status === 200 || r.status === 201;

    // ERP settings: the company's long legal name and its state (a quotation needs the state).
    const st = await owner.call("/api/v0/erp/settings");
    if (st.json?.company?.legalName !== fx.settings.legalName || st.json?.company?.stateCode !== "27") {
      const r = await owner.call("/api/v0/erp/settings", { body: { company: { ...(st.json?.company || {}), ...fx.settings }, dueDays: 15, roundTotal: true } });
      ok(r) ? count("settings", true) : fail("ERP settings", r);
    } else count("settings", false);

    // People (HR's "Add person", as the owner, an admin).
    const havePeople = new Map(listOf((await owner.call("/api/v0/people")).json, "people").map((p) => [p.name || p.displayName, p.id]));
    for (const p of fx.people) {
      if (havePeople.has(p.name)) { count("people", false); continue; }
      const r = await owner.call("/api/v0/people", { body: { name: p.name, role: p.role } });
      if (ok(r)) { havePeople.set(p.name, r.json?.id); count("people", true); } else fail(`person ${p.name}`, r);
    }

    // Clients (a company, with its main contact added in the same step).
    const clientsList = async () => new Map(listOf((await owner.call("/api/v0/clients")).json, "clients").map((c) => [c.displayName || c.name || c.companyName, c.id]));
    const haveClients = await clientsList();
    for (const c of fx.clients) {
      if (haveClients.has(c.name)) { count("clients", false); continue; }
      const r = await owner.call("/api/v0/clients", { body: { kind: "company", companyName: c.name, contact: { name: c.contact } } });
      if (ok(r) && r.json?.id) { haveClients.set(c.name, r.json.id); count("clients", true); } else fail(`client ${c.name}`, r);
    }

    // Projects.
    const haveProjects = new Map(listOf((await owner.call("/api/v0/projects")).json, "projects").map((p) => [p.title || p.name, p.projectId || p.id]));
    for (const p of fx.projects) {
      if (haveProjects.has(p.title)) { count("projects", false); continue; }
      const r = await owner.call("/api/v0/projects", { body: { title: p.title, clientId: haveClients.get(p.client) || null } });
      const pid = r.json?.id;
      if (ok(r) && pid) { haveProjects.set(p.title, pid); count("projects", true); } else fail(`project ${p.title}`, r);
    }

    // Tasks, spread over the long-named people (and the owner and the seller), due from ten days ago to forty days on.
    const assignees = [owner.id, seller.id, ...fx.people.map((p) => havePeople.get(p.name)).filter(Boolean)];
    const haveTasks = new Set();
    for (let page = 0; page < 20; page++) {
      const rows = listOf((await owner.call(`/api/v0/tasks?size=400&page=${page}`)).json, "rows");
      for (const t of rows) haveTasks.add(t.title);
      if (rows.length < 400) break;
    }
    for (const [i, t] of fx.tasks.entries()) {
      if (haveTasks.has(t.title)) { count("tasks", false); continue; }
      const body = { title: t.title, assigneeId: pick(assignees, i * 5 + t.assignee), priority: t.priority, dueOn: day(t.dueIn),
        notes: `${t.title}. ${pick(fx.quotes, i).note.replace(/^\[QAL-\d+\] /, "")}` };
      if (t.project && haveProjects.get(t.project)) body.projectId = haveProjects.get(t.project);
      const r = await owner.call("/api/v0/tasks", { body });
      if (ok(r)) { haveTasks.add(t.title); count("tasks", true); } else fail(`task ${i + 1}`, r);
    }

    // Quotations: the seller drafts each one; the owner approves (issues) and marks what the client did. Two in each stage.
    const docs = listOf((await owner.call("/api/v0/erp/documents?type=quotation")).json, "documents", "items", "docs");
    const haveQuotes = new Set(docs.map((d) => /^\[(QAL-\d+)\]/.exec(d.notes || "")?.[1]).filter(Boolean));
    for (const q of fx.quotes) {
      if (haveQuotes.has(q.key)) { count("quotes", false); continue; }
      const clientId = haveClients.get(q.client);
      const made = await seller.call("/api/v0/erp/documents", { body: { docType: "quotation", clientId } });
      const docId = made.json?.id || made.json?.document?.id;
      if (!ok(made) || !docId) { fail(`quote ${q.key} draft`, made); continue; }
      const draft = { issueDate: day(-3), validUntil: day(27), buyer: { name: q.client, stateCode: "27", address: ["Plot 7, Survey No. 112/3A, Hinjawadi Phase III", "पुणे – 411057, महाराष्ट्र"] },
        lines: q.lines, notes: q.note, terms: "GST extra as applicable. Prices valid for 30 days. Subject to Pune jurisdiction. / सर्व वाद पुणे न्यायक्षेत्राच्या अधीन." };
      const steps = [];
      if (q.stage === "draft") steps.push(["save", seller, `/api/v0/erp/documents/${docId}`, draft]);
      else if (q.stage === "approval") steps.push(["ask", seller, `/api/v0/erp/documents/${docId}/approval`, { to: owner.id, note: "कृपया मंज़ूर करें – please approve (QA long fixture)", draft }]);
      else {
        steps.push(["save", seller, `/api/v0/erp/documents/${docId}`, draft], ["issue", owner, `/api/v0/erp/documents/${docId}/issue`, {}]);
        if (q.stage === "cancelled") steps.push(["cancel", owner, `/api/v0/erp/documents/${docId}/mark`, { action: "cancel", note: "Client merged two towers into one order / दोन्ही टॉवर एकाच ऑर्डरमध्ये" }]);
        else if (q.stage !== "issued") {
          steps.push(["sent", owner, `/api/v0/erp/documents/${docId}/mark`, { action: "sent" }]);
          const last = { negotiating: { action: "negotiating", note: "Client asked for 100% GST break-up and a revised payment schedule" },
            accepted: { action: "accepted", note: "Accepted by the client's board of directors" }, declined: { action: "declined", note: "Budget moved to next financial year" },
            lost: { action: "lost", reason: "competitor", note: "प्रतिस्पर्धी कंपनी ने 4.5% कम दर दी" } }[q.stage];
          if (last) steps.push([q.stage, owner, `/api/v0/erp/documents/${docId}/mark`, last]);
        }
      }
      let good = true;
      for (const [name, who, p, body] of steps) {
        const r = await who.call(p, { body });
        if (!ok(r)) { fail(`quote ${q.key} ${name}`, r); good = false; break; }
      }
      if (good) count("quotes", true);
    }
  } finally {
    for (const jar of sessions) await V.signOut(jar);
  }
  console.log(JSON.stringify(out));
  return out.failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => process.exit(code), (e) => { console.error(String(e?.message || e)); process.exit(2); });
}
