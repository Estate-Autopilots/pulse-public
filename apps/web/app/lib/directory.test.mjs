import test from "node:test";
import assert from "node:assert/strict";
import { cinProblem, cinValid, contactKind, gstinProblem, gstinValid, initials, makeInvite, matchWords, nextIndex, searchable,
  searchCompanies, searchUrl, whatsappInvite, browseDirectory } from "./directory.mjs";

// COMPANY-SEARCH. Only the leak gate's reviewed synthetic GSTINs (the first three have a right check letter) and a
// synthetic CIN, phone (90000 range) and example.com addresses.
test("GSTIN: state code, shape and the mod-36 check letter, as the database checks it", () => {
  for (const g of ["27AABCS5678K1ZS", "29AAACN1234F1ZT", "27AAXFV2138F1ZR", " 27aabcs5678k1zs "]) assert.equal(gstinValid(g), true, g);
  for (const g of ["27AAXFV2138F1ZS", "99AAXFV2138F1ZR", "27AABCS5678K1Z", "", null]) assert.equal(gstinValid(g), false, String(g));
  assert.equal(gstinProblem("27AAXFV2138F1ZS"), "The last letter does not match the rest. Check it for typos.");
  assert.match(gstinProblem("27AABCS5678"), /15 letters and numbers. This has 11/);
  assert.equal(gstinProblem("27AABCS5678K1ZS"), null);
  assert.equal(gstinProblem(""), null);
});

test("CIN: its parts are checked (it has no check digit)", () => {
  const cin = "U72900MH2020PTC" + "000001";
  assert.equal(cinValid(cin), true);
  assert.equal(cinValid(cin.replace("MH", "QQ")), false);
  assert.equal(cinValid(cin.replace("PTC", "XYZ")), false);
  assert.equal(cinProblem(cin), null);
  assert.match(cinProblem("U7290"), /21 letters and numbers/);
});

test("plain words, initials and the search address", () => {
  assert.equal(matchWords("id"), "Same ID");
  assert.equal(matchWords("fuzzy"), "Close spelling");
  assert.equal(matchWords("prefix"), "");
  assert.equal(initials("Vitals Technologies Pvt. Ltd."), "VT");
  assert.equal(initials("estateautopilots"), "E");
  assert.equal(initials(""), "?");
  assert.equal(searchUrl("companies", " vitals ", { excludeOwn: true }), "/api/v1/directory/companies?q=vitals&limit=8&exclude_own=1");
  assert.equal(searchUrl("people", "@savuzo", { limit: 5 }), "/api/v1/directory/people?q=%40savuzo&limit=5");
  assert.equal(searchable("a"), false);
  assert.equal(searchable(" a b "), true);
});

test("arrow keys wrap around the results", () => {
  assert.equal(nextIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextIndex(1, 3, "End"), 2);
  assert.equal(nextIndex(1, 0, "ArrowDown"), -1);
});

test("search asks the API only for 2 letters or more, and says 429 in plain words", async () => {
  let calls = 0;
  const ok = async (url) => { calls++; assert.match(url, /^\/api\/v1\/directory\/companies\?q=vi/); return new Response(JSON.stringify({ companies: [{ handle: "x" }] }), { status: 200 }); };
  assert.deepEqual(await searchCompanies("v", { fetchImpl: ok }), []);
  assert.equal(calls, 0);
  assert.equal((await searchCompanies("vi", { fetchImpl: ok })).length, 1);
  const limited = async () => new Response(JSON.stringify({ error: "x" }), { status: 429 });
  await assert.rejects(searchCompanies("vitals", { fetchImpl: limited }), /Too many searches/);
});

test("an invite takes an e-mail or a phone; the WhatsApp link opens on the person's own phone", async () => {
  assert.equal(contactKind("owner@lotus.example"), "email");
  assert.equal(contactKind("90000 12345"), "phone");
  assert.equal(contactKind("hello"), null);
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ invite: { id: "1", link: "https://app.example/signup" } }), { status: 201 }); };
  const invite = await makeInvite({ companyName: " Lotus Interiors ", contact: "90000 12345", purpose: "contract" }, { fetchImpl });
  assert.deepEqual(sent, { url: "/api/v0/directory/invites", body: { companyName: "Lotus Interiors", purpose: "contract", phone: "9000012345" } });
  assert.equal(invite.link, "https://app.example/signup");
  await assert.rejects(makeInvite({ companyName: "Lotus", contact: "nope" }, { fetchImpl }), /e-mail, or a phone/);
  const wa = whatsappInvite({ link: "https://app.example/j", phone: "9000012345", purpose: "contract" }, "Synthetic Studio");
  assert.match(wa, /^https:\/\/wa\.me\/919000012345\?text=/);
  assert.match(decodeURIComponent(wa), /Synthetic Studio invites you to Vitals to sign an agreement\. Join here: https:\/\/app\.example\/j/);
});

test("browse reads the three lists and never invents one the answer lacks (UI-SWEEP)", async () => {
  const ok = async (url) => { assert.equal(url, "/api/v0/directory/browse"); return new Response(JSON.stringify({ verified: [{ handle: "lotus" }], recent: null }), { status: 200 }); };
  assert.deepEqual(await browseDirectory({ fetchImpl: ok }), { verified: [{ handle: "lotus" }], recent: [], colleagues: [] });
  const down = async () => new Response(JSON.stringify({ error: "x" }), { status: 401 });
  await assert.rejects(browseDirectory({ fetchImpl: down }), /Sign in again/);
});
