// R41 screenshots: HR desk → Policies with Word (.docx) editing off (the default), and on as a trial with the leave
// policy's draft carrying a synthetic Word file. Synthetic data only; the editor service itself is not involved.
//   ea-heavy node tests/e2e/hr-polish-shots.mjs --fixtures r41-word --out <dir> --widths 1440,390 --themes light,dark
export * from "./hr-polish.mjs";
export const VARIANTS = { "word-off@r41.test": "admin", "word-on@r41.test": "admin" };
const DOC = "/hr?tab=policies&view=documents&doc=leave";
export const SHOTS = [["policies-word-off", DOC, "word-off@r41.test"], ["policies-word-on", DOC, "word-on@r41.test"]];
const LIMIT = 5 * 1024 * 1024;
const OFF = { enabled: false, provider: "onlyoffice", reason: "off", label: "Word (.docx) editing is off until an editor service is approved and connected.", fidelitySignedOff: false, maxBytes: LIMIT };
const TRIAL = { enabled: true, provider: "onlyoffice", reason: null, label: "Word editing is a trial: the Word round-trip check is not signed off yet, so check the layout in Word before publishing.", fidelitySignedOff: false, maxBytes: LIMIT };

export async function routeAny(url, who, { mockPort, headers }) {
  if (!(who in VARIANTS) || url.pathname !== "/api/v0/hr/policies") return null;
  const r = await fetch(`http://127.0.0.1:${mockPort}${url.pathname}${url.search}`, { headers: { ...headers, "cf-access-authenticated-user-email": "admin@estateautopilots.com" } });
  const list = await r.json(), on = who === "word-on@r41.test";
  if (on) list.rows = list.rows.map((d) => d.kind === "leave" ? { ...d, docx_name: "Synthetic leave policy.docx", docx_sha256: "a".repeat(64), docx_source: "upload" } : d);
  return [r.status, { ...list, word: on ? TRIAL : OFF }];
}
