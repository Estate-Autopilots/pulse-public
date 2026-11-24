// FIN-AGENT: the sandbox holds (no network, nothing of the home folder, inputs read only, memory and time limits) and
// the Finance AI employee's statement analysis reads every synthetic bank layout inside it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gstFixtures, GST_OWN, GST_SUPPLIER } from "./gst-fixtures.mjs";
import { busy, pythonBinds, remoteCommand, remoteReady, runRemote, runSandbox, sandboxArgs, sandboxPython, sandboxReady, LIB } from "./sandbox.mjs";

const ready = sandboxReady();
const dirs = async () => { const d = await mkdtemp(join(tmpdir(), "sbx-test-")); const i = join(d, "in"), o = join(d, "out"); execFileSync("mkdir", ["-p", i, o]); return { i, o }; };

test("the command line cuts the network and mounts only the job", () => {
  const a = sandboxArgs({ python: "/usr/bin/python3", inDir: "/x/in", outDir: "/x/out", entry: "/job/lib/a.py" });
  assert.ok(a.includes("--unshare-all") && a.includes("--clearenv") && a.includes("--die-with-parent"));
  assert.ok(a.some((x) => x.startsWith("--as=")) && a.some((x) => x.startsWith("--cpu=")));
  assert.ok(!a.some((x) => /\/home\/[^/]+\/?$/.test(x)), "no home folder is bound");
  assert.equal(a[a.indexOf("/x/in") - 1], "--ro-bind", "inputs are read only");
});

test("inside: no network, no home folder, inputs read only, output kept", { skip: !ready && "bwrap cannot make namespaces here" }, async () => {
  const { i, o } = await dirs();
  await writeFile(join(i, "a.txt"), "hello");
  const code = `
import json, os, socket
r = {}
try:
    socket.create_connection(("1.1.1.1", 443), timeout=2); r["net"] = "open"
except OSError: r["net"] = "blocked"
# bwrap makes the parent folders of the Python binds, so the home folder may exist, but empty of anything real.
r["home"] = any(os.path.exists("${process.env.HOME}/" + p) for p in (".config", ".ssh", ".local/state", "work/pulse/strike/services", ".claude"))
try:
    open("/in/a.txt", "a").write("x"); r["in_write"] = True
except OSError: r["in_write"] = False
r["read"] = open("/in/a.txt").read()
r["env"] = sorted(k for k in os.environ if "KEY" in k or "TOKEN" in k or "PULSE_DATABASE" in k)
open("/out/r.json", "w").write(json.dumps(r))
`;
  const res = await runSandbox({ code, inDir: i, outDir: o, limits: { wallSec: 30 } });
  assert.equal(res.code, 0, res.stderr);
  const r = JSON.parse(await readFile(join(o, "r.json"), "utf8"));
  assert.deepEqual(r, { net: "blocked", home: false, in_write: false, read: "hello", env: [] });
});

test("inside: the memory and time limits stop a runaway script", { skip: !ready && "bwrap cannot make namespaces here" }, async () => {
  const { i, o } = await dirs();
  const mem = await runSandbox({ code: "x = bytearray(900 * 1024 * 1024)\nprint('allocated')", inDir: i, outDir: o, limits: { memMb: 400, wallSec: 30 } });
  assert.notEqual(mem.code, 0, "900 MB under a 400 MB limit fails");
  const slow = await runSandbox({ code: "import time\ntime.sleep(30)", inDir: i, outDir: o, limits: { wallSec: 2 } });
  assert.equal(slow.killed, "time");
});

test("the statement analysis reads every synthetic layout, drops overlaps, and proposes parser skills", { skip: !ready && "bwrap cannot make namespaces here" }, async () => {
  const { i, o } = await dirs();
  execFileSync(sandboxPython(), ["-I", join(LIB, "synth.py"), i]);
  const files = (await readdir(i)).filter((f) => f !== "job.json").sort();
  await writeFile(join(i, "job.json"), JSON.stringify({ files: files.map((f) => ({ path: f, name: f })), invoices: [{ no: "INV-0101", amount: 5900000, date: "2026-04-01", client: "Northwind", gst: 900000 }] }));
  const steps = [];
  const res = await runSandbox({ script: "fin_ingest.py", inDir: i, outDir: o, limits: { wallSec: 120 } }, (j) => steps.push(j));
  assert.equal(res.code, 0, res.stderr);
  const r = JSON.parse(await readFile(join(o, "result.json"), "utf8"));
  assert.equal(r.files.length, 8);
  assert.ok(r.files.every((f) => f.ok), JSON.stringify(r.files.filter((f) => !f.ok)));
  const by = Object.fromEntries(r.files.map((f) => [f.name.split("-")[0], f]));
  assert.equal(by.sbi.parser, "standard", "the standard importer takes what it can");
  assert.equal(by.broken.parser, "fallback", "the export the standard import refused is read by the fallback");
  assert.equal(by.broken.rows, 80);
  assert.equal(by.kotak.rows, 60);
  assert.ok(by.synthetic.rows >= 29, "the text PDF");
  assert.ok(r.files.filter((f) => f.balance).every((f) => f.balance.ok), "running balances add up");
  assert.equal(r.totals.duplicates, 80, "the overlapping HDFC months are counted once");
  assert.ok(r.proposedSkills.some((s) => s.kind === "parser" && s.body.bank === "HDFC" && s.tests[0].expect.length === 3));
  assert.ok(steps.some((s) => s.t === "progress" && s.p === 100));
  const items = gunzipSync(await readFile(join(o, "items-00000.jsonl.gz"))).toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(items.length, r.totals.rows);
  assert.ok(items.every((x) => !/(?<![A-Za-z0-9])\d{6,}(?![A-Za-z0-9])/.test(x.narration)), "no account or reference numbers in narrations");
  const ads = items.filter((x) => /facebook/i.test(x.narration));
  assert.ok(ads.length > 10 && ads.every((x) => x.category === "Ad spend"));
  assert.ok(items.some((x) => x.match?.invoices?.includes("INV-0101")), "a credit matched to the open invoice");
  assert.ok(items.some((x) => x.flags.includes("unclear_category")) && items.some((x) => x.flags.includes("missing_document")));
});

// FIN-AGENT-2: the GST check, on synthetic portal returns (gst-fixtures.mjs) with one of each problem.
test("the GST check finds each difference between the returns and Pulse", { skip: !ready && "bwrap cannot make namespaces here" }, async () => {
  const { i, o } = await dirs();
  const g = gstFixtures();
  await writeFile(join(i, "a.json"), JSON.stringify(g.gstr1)); await writeFile(join(i, "b.json"), JSON.stringify(g.gstr3b)); await writeFile(join(i, "c.json"), JSON.stringify(g.gstr2b));
  await writeFile(join(i, "d.json"), "not json at all");
  await writeFile(join(i, "job.json"), JSON.stringify({ files: [{ path: "a.json", name: "GSTR1_102026.json" }, { path: "b.json", name: "GSTR3B_102026.json" },
    { path: "c.json", name: "R2B_102026.json" }, { path: "d.json", name: "notes.json" }], invoices: g.invoices, payments: g.payments, gstin: GST_OWN }));
  const r = await runSandbox({ script: "gst_recon.py", inDir: i, outDir: o, args: ["/in", "/out"], limits: { wallSec: 60, memMb: 512 } });
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(await readFile(join(o, "result.json"), "utf8"));
  assert.deepEqual(res.files.map((f) => [f.return ?? null, f.period ?? null, f.ok]), [["GSTR-1", "2026-10", true], ["GSTR-3B", "2026-10", true], ["GSTR-2B", "2026-10", true], [null, null, false]]);
  assert.deepEqual(res.counts, { gstr1_vs_3b: 1, itc_over_2b: 1, invoice_mismatch: 1, invoice_not_in_gstr1: 1, gstr1_not_in_pulse: 1, itc_no_payment: 1 });
  const by = Object.fromEntries(res.findings.map((f) => [f.kind, f]));
  assert.equal(by.gstr1_vs_3b.amountMinor, 1880000, "GSTR-1 ₹64,800 against GSTR-3B ₹46,000");
  assert.match(by.gstr1_vs_3b.what, /DRC-01B/);
  assert.equal(by.itc_over_2b.amountMinor, 180000, "3B credit ₹10,800 against 2B ₹9,000");
  assert.equal(by.invoice_not_in_gstr1.doc, "EA/26-27/043");
  assert.equal(by.invoice_mismatch.doc, "EA-26-27-42", "the same invoice under another way of writing its number");
  assert.equal(by.gstr1_not_in_pulse.doc, "EA/26-27/044");
  assert.equal(by.itc_no_payment.doc, "SLR-902", "SLR-881 is paid less 2% TDS");
  assert.equal(res.months[0].gstr1.tax, 6480000);
  assert.equal(res.findings[0].severity, "high", "the notices' questions come first");
});

test("the GST check reads a GSTR-2B B2B sheet downloaded as CSV", { skip: !ready && "bwrap cannot make namespaces here" }, async () => {
  const { i, o } = await dirs();
  await writeFile(join(i, "s.csv"), ["Goods and Services Tax - GSTR 2B", "",
    "GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value(₹),Place of supply,Supply Attract Reverse Charge,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),Cess(₹),ITC Availability",
    `${GST_SUPPLIER},Synthetic Lens Rentals,SLR-881,Regular,03/10/2026,35400.00,Maharashtra,N,30000.00,0,2700.00,2700.00,0,Yes`,
    `${GST_SUPPLIER},Synthetic Lens Rentals,SLR-903,Regular,21/10/2026,"11,800.00",Maharashtra,N,"10,000.00",0,900.00,900.00,0,No`].join("\n"));
  await writeFile(join(i, "job.json"), JSON.stringify({ files: [{ path: "s.csv", name: "gstr2b-10-2026.csv" }], invoices: [], payments: [], gstin: GST_OWN }));
  const r = await runSandbox({ script: "gst_recon.py", inDir: i, outDir: o, args: ["/in", "/out"], limits: { wallSec: 60, memMb: 512 } });
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(await readFile(join(o, "result.json"), "utf8"));
  assert.deepEqual(res.files.map((f) => [f.return, f.period]), [["GSTR-2B", "2026-10"]]);
  assert.equal(res.months[0].gstr2b.bills, 2);
  assert.equal(res.months[0].gstr2b.itc, 540000, "only the bill whose credit is available counts");
  assert.ok(res.notes.some((n) => /bank statements/.test(n)), "says what is missing to check payments");
});

// FIN-AGENT-2: jobs on another server when this one is busy. The remote side is this machine through a stand-in for ssh
// (it drops the host and runs the command here), so the whole path runs: the job packed over stdin, the same sandbox,
// progress streamed back, the output folder returned, the private folder removed.
test("a remote run keeps the sandbox and its limits, and only runs where the probe passes", () => {
  const cmd = remoteCommand({ entry: "/job/lib/gst_recon.py", args: ["/in", "/out"], limits: { wallSec: 60 } });
  assert.match(cmd, /--unshare-all/); assert.match(cmd, /--clearenv/); assert.match(cmd, /prlimit/); assert.match(cmd, /systemd-run/);
  assert.match(cmd, /chmod 700 "\$d"/); assert.match(cmd, /trap 'rm -rf "\$d"' EXIT HUP INT TERM/); assert.match(cmd, /timeout -s KILL 65 /);
  assert.ok(!/\/home\/[a-z]+\/(?!\.local)/.test(cmd.replace(/'[^']*'/g, (q) => q.includes("@D@") ? "" : q)), "nothing of this server's home folder");
  assert.equal(busy(9, 4, {}), true); assert.equal(busy(5, 4, {}), false); assert.equal(busy(5, 4, { PULSE_SANDBOX_BUSY: "1" }), true);
});

test("a remote run: packed, sandboxed, streamed and returned", { skip: !ready && "bwrap cannot make namespaces here" }, async () => {
  const { i, o } = await dirs();
  const fake = join(i, "..", "fake-ssh");
  await writeFile(fake, '#!/bin/bash\nwhile [ "$1" = "-o" ]; do shift 2; done\nshift\nexec bash -c "$1"\n', { mode: 0o755 });
  const g = gstFixtures();
  await writeFile(join(i, "a.json"), JSON.stringify(g.gstr1)); await writeFile(join(i, "b.json"), JSON.stringify(g.gstr3b));
  await writeFile(join(i, "job.json"), JSON.stringify({ files: [{ path: "a.json", name: "GSTR1_102026.json" }, { path: "b.json", name: "GSTR3B_102026.json" }], invoices: g.invoices, payments: [], gstin: "27AAAAA0000A1Z5" }));
  const py = sandboxPython();
  const env = { PULSE_SANDBOX_REMOTE: "stand-in", PULSE_SANDBOX_SSH: fake, PULSE_SANDBOX_REMOTE_PYTHON: py, PULSE_SANDBOX_REMOTE_BINDS: (await pythonBinds(py)).join(":") };
  assert.equal(await remoteReady(env), true, "the probe passes where bwrap and a user scope work");
  const seen = [];
  const r = await runRemote({ script: "gst_recon.py", inDir: i, outDir: o, args: ["/in", "/out"], limits: { wallSec: 60, memMb: 512 } }, (j) => seen.push(j), env);
  assert.equal(r.code, 0, r.stderr); assert.equal(r.remote, "stand-in");
  assert.ok(seen.some((j) => j?.t === "progress" && /Reading GSTR1/.test(j.line)), "progress streamed back");
  const res = JSON.parse(await readFile(join(o, "result.json"), "utf8"));
  assert.equal(res.counts.gstr1_vs_3b, 1, "the same answer as here");
  const left = execFileSync("bash", ["-c", "ls -d ${TMPDIR:-/tmp}/pulse-sbx-* 2>/dev/null | wc -l"]).toString().trim();
  assert.equal(left, "0", "the private folder is gone");
  const said = [];
  const net = await runRemote({ code: "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 443), timeout=2); print('open')\nexcept OSError: print('blocked')\n", inDir: i, outDir: o, limits: { wallSec: 30, memMb: 256 } }, (j) => said.push(j?.line), env);
  assert.equal(net.code, 0); assert.deepEqual(said, ["blocked"], "no network there either");
});
