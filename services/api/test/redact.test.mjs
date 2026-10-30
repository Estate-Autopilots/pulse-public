// GROUPS-2: the redactor that stands between a group's text and an outside AI engine (made-up people, companies,
// numbers and addresses only).
import test from "node:test";
import assert from "node:assert/strict";
import { Redactor, finishAll, localIds, rehydrate, wordsOf } from "../dist/redact.js";

const people = [
  { kind: "person", ref: "p-asha", name: "Asha Kireteso", local: true },
  { kind: "person", ref: "p-rifob", name: "Rifob Mifos", local: true },
  { kind: "person", ref: "p-will", name: "Will Fernandes" },
  { kind: "person", ref: "p-tara", name: "Tara (AI)", local: true },
  { kind: "client", ref: "c-vihaan", name: "Vihaan Realtors" },
  { kind: "project", ref: "j-lotus", name: "Lotus Crest", local: true },
  { kind: "project", ref: "j-green", name: "Green Park" },
  { kind: "participant", ref: "w-1", name: "~ Kabir Dorugohum", local: true },
  { kind: "label", ref: null, name: "Meera Jivop Site" },
];
const places = ["Baner", "Pimple Saudagar", "Pune"];
function run(texts, opts = {}) {
  const r = new Redactor(opts.entities ?? people, { places, vocab: opts.vocab });
  const out = texts.map((t) => r.text(t));
  const ids = localIds(r.pending());
  return { r, out: finishAll(r, out, ids), ids, tokens: r.tokens(ids) };
}
const leaks = (s, words) => words.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(s));

test("people, clients and projects become stable ids, the same id every time", () => {
  const { out } = run(["Asha Kireteso shared the Lotus Crest brochure with Vihaan Realtors", "asha please check with rifob", "Ask Kireteso ji and Mifos"]);
  for (const s of out) assert.deepEqual(leaks(s, ["asha", "kireteso", "rifob", "mifos", "lotus", "crest", "vihaan"]), [], s);
  const asha = out[0].match(/^\[(P\d+)\]/)[1];
  assert.ok(out[1].includes(`[${asha}]`), "the first name alone is the same person when she is in the group");
  assert.match(out[0], /\[PRJ\d+\] brochure with \[C\d+\]/);
});

test("a name that is a common word only counts when it is written as a name", () => {
  const { out } = run(["Will you send it today?", "I will send it. Ask Will for the file", "the green park nearby"]);
  assert.equal(out[0], "Will you send it today?");
  assert.match(out[1], /^I will send it\. Ask \[P\d+\] for the file$/);
  assert.equal(out[2], "the green park nearby", "a project's ordinary words are not a name on their own");
});

test("phone numbers in any form get one id per number; other long numbers and ids are masked", () => {
  const { out } = run(["Call +91 90000 12345 or 090000-12345", "office 020 2567 8901", "a/c 123456789012 IFSC HDFC0001234 PAN ABCDE1234F",
    "@919000012345 please confirm", "budget 50000 - 60000, meet on 2026-10-25 10:30 or 25.10.2026", "UTR AXIS0123456789012 and booking BK20261025001"]);
  const ph = [...out[0].matchAll(/\[PH(\d+)\]/g)].map((m) => m[1]);
  assert.equal(ph.length, 2); assert.equal(ph[0], ph[1], "the same number is the same id");
  assert.match(out[1], /^office \[PH\d+\]$/);
  assert.doesNotMatch(out[2], /\d{6,}|HDFC|ABCDE/);
  assert.ok(out[3].startsWith(`@[PH${ph[0]}]`));
  assert.equal(out[4], "budget 50000 - 60000, meet on 2026-10-25 10:30 or 25.10.2026", "amounts, ranges, dates and times stay");
  assert.doesNotMatch(out[5], /\d{6,}/, "ids with letters and long numbers glued together are masked");
});

test("e-mail addresses, UPI ids and links", () => {
  const { out } = run(["mail user-ef9d7c4e@org-2aafeb.example or pay to synthetic.person@okhdfcbank", "see https://drive.google.com/file/d/abc and https://vihaan-homes.example/offer", "pin https://maps.app.goo.gl/xyz"]);
  assert.match(out[0], /^mail \[E\d+\] or pay to \[UPI id\]$/);
  assert.equal(out[1], "see [link drive.google.com] and [link]");
  assert.equal(out[2], "pin [map link]");
});

test("postal addresses become an id; areas and cities stay", () => {
  const { out } = run(["Deliver to Flat 302, B Wing, Sai Residency, Baner Road, Pune 411045 by Monday",
    "Site is in Baner, near the highway", "Office no 14, Shivneri Complex, Wakad", "Sai Residency, Baner Road, Pune"]);
  assert.match(out[0], /^Deliver to \[A\d+\] by Monday$/);
  assert.equal(out[1], "Site is in Baner, near the highway");
  assert.match(out[2], /^\[A\d+\]$/);
  assert.match(out[3], /\[A\d+\]/);
  for (const s of out) assert.deepEqual(leaks(s, ["411045", "Sai Residency", "Shivneri"]), [], s);
});

test("names nobody told Pulse: after an honorific, before sir or ji, capitalised, rare in the company's messages", () => {
  const vocab = { send: [900, 40, 800, 20], please: [700, 45, 400, 30], ishaan: [3, 1, 3, 3], nedeho: [2, 1, 1, 1], soniba: [6, 2, 6, 6], apologies: [50, 12, 1, 0] };
  const { out } = run(["Mr. Iyer will come at 5", "nedeho sir please send", "Ishaan will share the deck", "thanks Soniba", "hi team, Reels are ready", "Apologies for the delay"], { vocab });
  assert.match(out[0], /^Mr\. \[N\d+\] will come at 5$/);
  assert.match(out[1], /^\[N\d+\] sir please send$/);
  assert.match(out[2], /^\[N\d+\] will share the deck$/);
  assert.match(out[3], /^thanks \[N\d+\]$/);
  assert.equal(out[4], "hi team, Reels are ready");
  assert.equal(out[5], "Apologies for the delay", "a word that mostly opens sentences in many chats is ordinary");
});

test("a rare word in another script is taken for a name; a common one stays", () => {
  const vocab = { "काम": [400, 30, 380, 0] };
  const { out } = run(["राहुल काम झाले का"], { vocab });
  assert.match(out[0], /^\[N\d+\] काम \[N\d+\] \[N\d+\]$/, "only words the company uses in three chats or more stay");
});

test("an imported sender keeps its own id; a label that is a person is that person", () => {
  const { out } = run(["Kabir Dorugohum sent the plan", "Meera Jivop Site visit done", "Kabir will call"]);
  assert.match(out[0], /^\[P\d+\] sent the plan$/);
  assert.match(out[1], /^\[P\d+\] visit done$/);
  assert.equal(out[2].match(/\[P\d+\]/)[0], out[0].match(/\[P\d+\]/)[0], "the first name alone is the same sender (in this group)");
  const { out: at } = run(["@Asha please check", "@Kireteso ji"]);
  assert.match(at[0], /^@\[P\d+\] please check$/, "an @mention of a first name is that person");
  assert.equal(at[0].match(/\[P\d+\]/)[0], at[1].match(/\[P\d+\]/)[0]);
});

test("names go back into the answer; unknown ids stay as written", () => {
  const { r, ids } = run(["Asha Kireteso asked Rifob Mifos"]);
  const back = Object.fromEntries(r.pending().map((a) => [ids[a.digest], a.ref === "p-asha" ? "Asha Kireteso" : a.ref === "p-rifob" ? "Rifob Mifos" : a.value]));
  const tokens = Object.keys(back);
  const answer = { happening: `[${tokens[0]}] is waiting on [${tokens[1]}]`, pending: [`[${tokens[1]}] to send the brochure`, "[P999] unknown"] };
  assert.deepEqual(rehydrate(answer, back), { happening: "Asha Kireteso is waiting on Rifob Mifos", pending: ["Rifob Mifos to send the brochure", "[P999] unknown"] });
});

test("counts say what was replaced, and the words to look up are the text's own", () => {
  const { r } = run(["Asha Kireteso: call 9000012345, mail a@b.co"]);
  assert.equal(r.counts.person, 1); assert.equal(r.counts.phone, 1); assert.equal(r.counts.email, 1);
  assert.deepEqual(wordsOf(["Asha's brochure"]).sort(), ["asha", "brochure"]);
});

test("ids are written only through finish: no placeholder or raw value survives", () => {
  const { out } = run(["Rifob Mifos 9000012345 user-db20e64d@org-2aafeb.example Flat 7, Lotus Crest, Baner, Pune 411045"]);
  assert.doesNotMatch(out[0], /[-]/);
  assert.doesNotMatch(out[0], /Rifob|Mifos|9000012345|example\.in|411045/i);
});
