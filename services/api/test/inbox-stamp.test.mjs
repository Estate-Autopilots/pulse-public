// SPEED-NET: the call stream's word on the bell's notifications (calls.ts inboxStamp). A failure must never end the stream
// that rings calls: it is read behind a savepoint and says nothing (null) when it fails.
import assert from "node:assert/strict";
import test from "node:test";
import { INBOX_STAMP, inboxStamp } from "../dist/calls.js";

const PERSON = "00000000-0000-4000-8000-0000000000b1";

test("the stamp is read behind a savepoint, for this person in this company, and is a short hash", async () => {
  const seen = [];
  const c = { query: async (sql, params) => { seen.push([sql, params]); return sql === INBOX_STAMP ? { rows: [{ s: "0123456789abcdef" }] } : { rows: [] }; } };
  assert.equal(await inboxStamp(c, PERSON), "0123456789abcdef");
  assert.deepEqual(seen.map(([sql]) => sql === INBOX_STAMP ? "stamp" : sql), ["savepoint inbox_stamp", "stamp", "release savepoint inbox_stamp"]);
  assert.deepEqual(seen[1][1], [PERSON]);
  assert.match(INBOX_STAMP, /n\.org_id = pulse\.current_org\(\) and n\.person_id = \$1/);
  assert.match(INBOX_STAMP, /left\(md5\(/, "a hash, never the notifications themselves");
});

test("a failing read says nothing and leaves the transaction usable (rolled back to the savepoint), never throwing", async () => {
  const seen = [];
  const c = { query: async (sql) => { seen.push(sql); if (sql === INBOX_STAMP) throw new Error("relation does not exist"); return { rows: [] }; } };
  assert.equal(await inboxStamp(c, PERSON), null);
  assert.deepEqual(seen.map((s) => s === INBOX_STAMP ? "stamp" : s), ["savepoint inbox_stamp", "stamp", "rollback to savepoint inbox_stamp"]);
  // Even the rollback failing (the connection gone) only says nothing.
  const gone = { query: async (sql) => { if (sql !== "savepoint inbox_stamp") throw new Error("connection terminated"); return { rows: [] }; } };
  assert.equal(await inboxStamp(gone, PERSON), null);
  assert.equal(await inboxStamp({ query: async () => ({ rows: [] }) }, PERSON), null, "no row: nothing");
});
