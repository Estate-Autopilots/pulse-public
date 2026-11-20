// SPEED-4 (owner, 18 Nov 2026): Ctrl+K search (GET /api/v0/search) took 1.7-28 s on production for real people. Its chat
// messages read ran chat_message's row policies on every message of every conversation (9.5-12.8 s for a person in 302
// conversations); pulse.chat_message_find (2381) applies the same rules once per conversation (0.35 s on the same data).
// The query's meaning (the embedder, up to 0.7 s) is asked beside the reads instead of before them.
// The database half (same messages as the row-secured query) is tests/core/test_search_speed.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const search = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../db/migrations/2381_search_messages_speed.sql", import.meta.url), "utf8");

test("search reads chat messages through chat_message_find, never chat_message row by row", () => {
  assert.match(search, /pulse\.chat_message_find\(\$1::text\[\], 8\)/);
  assert.doesNotMatch(search, /from pulse\.chat_message msg/);
});

test("the embedder is not awaited before the reads", () => {
  const route = search.slice(search.indexOf("app.get('/api/v0/search'"));
  assert.doesNotMatch(route, /await embedQuery/);
  assert.match(route, /const vector = q\.length >= 3 && terms\.length \? embedQuery\(q, 700\) : null;/);
  const body = search.slice(search.indexOf("export async function search("), search.indexOf("export function registerSearchRoutes"));
  // awaited only right before the history search, after tasks, projects and chats were read
  assert.ok(body.indexOf("const vec = await vector;") > body.indexOf("chat_message_find"));
  assert.ok(body.indexOf("const vec = await vector;") < body.indexOf("wa_history_search"));
});

test("chat_message_find keeps the message policies: membership (chat_has), removed, imported readers, the API role only", () => {
  assert.match(migration, /security definer set search_path = pulse, pg_temp/);
  assert.match(migration, /m\.person_id = current_viewer\(\)/);
  assert.match(migration, /chat_has\(ch\.id\)/);
  assert.match(migration, /msg\.removed_at is null and \(msg\.import_ref is null or \(select ok from reads\)\)/);
  assert.match(migration, /chat_import_reads\(\) ok/);
  assert.match(migration, /revoke all on function pulse\.chat_message_find\(text\[\], int\) from public;/);
  assert.match(migration, /grant execute on function pulse\.chat_message_find\(text\[\], int\) to pulse_api;/);
});
