// FIN-AGENT: the sandbox holds (no network, nothing of the home folder, inputs read only, memory and time limits) and
// the Finance AI employee's statement analysis reads every synthetic bank layout inside it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSandbox, sandboxArgs, sandboxPython, sandboxReady, LIB } from "./sandbox.mjs";

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
