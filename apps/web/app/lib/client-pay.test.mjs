import { test } from "node:test";
import assert from "node:assert/strict";
import { embedUrl, inr, moment, rupeesToPaise, size, upiLink } from "./client-pay.mjs";

test("amounts: paise on the wire, rupees in Indian grouping on screen", () => {
  assert.equal(inr(15000000), "₹1,50,000");
  assert.equal(inr(250050), "₹2,500.5");
  assert.equal(rupeesToPaise("1,50,000"), 15000000);
  assert.equal(rupeesToPaise("₹ 2500.5"), 250050);
  assert.equal(rupeesToPaise("12.345"), null);
  assert.equal(rupeesToPaise("abc"), null);
  assert.equal(rupeesToPaise(""), null);
});

test("a UPI link carries the payee, amount and note; a bad UPI ID gives none", () => {
  const link = upiLink({ upi: "fakeagency@okhdfc", payee: "Fake Agency", paise: 1180000, note: "Invoice EA/25-26/014" });
  assert.ok(link.startsWith("upi://pay?"));
  const q = new URLSearchParams(link.slice("upi://pay?".length));
  assert.equal(q.get("pa"), "fakeagency@okhdfc");
  assert.equal(q.get("am"), "11800.00");
  assert.equal(q.get("pn"), "Fake Agency");
  assert.equal(q.get("tn"), "Invoice EA/25-26/014");
  assert.ok(!link.includes("+"), "spaces are %20 for UPI apps");
  assert.equal(upiLink({ upi: "not a upi", payee: "x", paise: 100 }), null);
});

test("moments and sizes read the way people say them", () => {
  assert.equal(moment(75.4), "1:15");
  assert.equal(moment(3725), "1:02:05");
  assert.equal(moment(-3), "0:00");
  assert.equal(size(2048), "2 KB");
  assert.equal(size(14.2 * 1048576), "14 MB");
  assert.equal(size(3.25 * 1048576), "3.3 MB");
});

test("only known players are framed", () => {
  assert.equal(embedUrl("https://youtu.be/abcdEFG1234"), "https://www.youtube-nocookie.com/embed/abcdEFG1234");
  assert.equal(embedUrl("https://www.youtube.com/watch?v=abcdEFG1234"), "https://www.youtube-nocookie.com/embed/abcdEFG1234");
  assert.equal(embedUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing"), "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/preview");
  assert.equal(embedUrl("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/edit"), "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/preview");
  assert.equal(embedUrl("https://example.test/creative.png"), null);
  assert.equal(embedUrl("http://youtu.be/abcdEFG1234"), null);
  assert.equal(embedUrl("javascript:alert(1)"), null);
});
