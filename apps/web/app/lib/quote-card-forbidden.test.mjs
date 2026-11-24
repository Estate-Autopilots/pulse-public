// USER-INSIGHT (23 Nov 2026): a quotation card in Chats that is not open to the reader stops asking. Production, Wise
// Life, 18 Nov 11:19-11:34 IST: Adunor's Chats asked GET /api/v0/erp/documents/:id 106 times in one session (403
// every 5 s for the card's whole 15-minute watch; 169 refusals on the server that day). A 404 already stopped the watch
// and showed the card's own words; a 403 was taken as "try again".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../chats/quote-card.tsx", import.meta.url), "utf8");
const load = src.slice(src.indexOf("const load = () => {"), src.indexOf("load();", src.indexOf("const load = () => {")));

test("a 403 ends the watch and shows 'This quotation is not open to you'", () => {
  assert.match(load, /r\.status === 403 \? "forbidden"/);
  assert.match(load, /if \(x === "forbidden"\) \{ stop = true; setMoved\(\{ id: null, state: "unavailable", number: null \}\); return; \}/);
  assert.match(src, /This quotation is not open to you/);
});

test("other failures still try again within the watch; a 404 still looks for the newer quotation", () => {
  assert.match(load, /r\.status === 404 && id === linked \? "gone" : null/);
  assert.match(load, /if \(on && !stop && fresh && Date\.now\(\) < until\) timer = setTimeout\(load, EVERY_MS\)/);
});
