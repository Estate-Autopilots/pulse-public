// BUG-ONBOARD: a synthetic first run for /welcome. The address's local part picks the case:
//   held@welcome-footer.example   Pulse is held until the profile is complete (no skipping)
//   owner@welcome-footer.example  held, but allowed to finish later (the platform owner)
//   open@welcome-footer.example   not held: the full first run, every step skippable
// Everything else goes to the shared shell fixture (mock-editors-api.mjs). Synthetic values only.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";

const mockPort = await new Promise((resolve) => {
  const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const mock = spawn(process.execPath, ["tests/e2e/mock-editors-api.mjs"], { stdio: "inherit", env: { ...process.env, PORT: String(mockPort) } });
process.on("exit", () => mock.kill());
process.on("SIGTERM", () => process.exit());
process.on("SIGINT", () => process.exit());
for (let i = 0; i < 100; i++) {
  try { await fetch(`http://127.0.0.1:${mockPort}/api/v0/me`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const person = "synthetic-joiner";
const missing = ["dob", "phone", "address", "emergency", "bank", "skills", "doc:aadhaar", "doc:pan", "photo"];
const state = (self) => ({
  person: { id: person, name: "Synthetic Joiner", firstName: "Joiner", role: "Synthetic designer", pod: "Synthetic pod", joinedOn: "2026-11-02", workPhone: null, photo: false, skills: [] },
  self, canSeeDetails: true, canSeeIds: true, details: { legalName: "Synthetic Joiner" }, bank: null,
  documents: [
    { kind: "aadhaar", label: "Aadhaar (masked)", required: true, idNumber: "aadhaar", document: null },
    { kind: "pan", label: "PAN card", required: true, idNumber: "pan", document: null },
    { kind: "degree", label: "Degree certificate", required: false, idNumber: null, document: null },
  ],
  steps: {}, consent: {}, notice: null, apps: null, missing, percent: 10, completedAt: null, proposals: [], filesReady: true,
});
const gateFor = (who) => who === "held" ? { blocked: true, canSkip: false, missing, later: [] } : who === "owner" ? { blocked: true, canSkip: true, missing, later: [] } : null;
const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture");
    const email = String(req.headers["cf-access-authenticated-user-email"] ?? "").toLowerCase();
    const who = email.endsWith("@welcome-footer.example") ? email.split("@")[0] : null;
    if (who && url.pathname === "/api/v0/me") {
      const up = await fetch(`http://127.0.0.1:${mockPort}${req.url}`, { headers: { "cf-access-authenticated-user-email": "staff@estateautopilots.com" } });
      const me = await up.json();
      return json(res, { ...me, person, mustChange: false, profileGate: gateFor(who) });
    }
    if (who && url.pathname.startsWith("/api/v0/onboarding")) {
      if (req.method === "POST") { for await (const _ of req) { /* drain */ } return json(res, { ok: true }); }
      return json(res, state(true));
    }
    if (who && url.pathname === "/api/v0/companion") return json(res, { attendanceEnabled: true, entry: null, presence: { offices: [], autoCheckIn: false } });
    const up = await fetch(`http://127.0.0.1:${mockPort}${req.url}`, { method: req.method, headers: req.headers, ...(["GET", "HEAD"].includes(req.method ?? "GET") ? {} : { body: req, duplex: "half" }) });
    res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch (e) { json(res, { error: String(e) }, 500); }
}).listen(Number(process.env.PORT), "127.0.0.1");
