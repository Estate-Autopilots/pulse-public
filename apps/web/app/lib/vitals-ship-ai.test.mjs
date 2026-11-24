// VITALS-SHIP (owner, 24 Nov 2026): the AI-employee bugs from the tutorials lane (bhrātā in a seller's chat).
// Source-level, like the other app/lib tests; the API's own tests and the land gate run the code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const repo = (rel) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");

test("create_task: a time the person names (\"tomorrow at 11 am\") becomes the due moment, not only words in the title", () => {
  const src = repo("services/api/src/v1-work.ts");
  const op = src.slice(src.indexOf("operationId: 'createTask'"), src.indexOf("operationId: 'assignTask'"));
  assert.match(op, /dueTime: \{ type: 'string', pattern: '\^\(\[01\]\\\\d\|2\[0-3\]\):\[0-5\]\\\\d\$'/, "dueTime is HH:MM, 24-hour");
  assert.match(op, /when the person names a time \("remind me tomorrow at 11 am"\), also give dueTime/, "the tool tells the model to use it");
  // On the company's clock: the date (or today there) plus the time, turned into the exact moment.
  assert.match(op, /coalesce\(\$1::date, \(now\(\) at time zone \$\{ORG_TZ\}\)::date\) \+ \$2::time\)\s+at time zone \$\{ORG_TZ\}\) at time zone 'UTC'/);
  assert.match(op, /!b\.dueAt && b\.dueTime \?/, "an exact dueAt the caller gave still wins");
  assert.match(op, /createWorkTask\(ctx\.client, v, \{ \.\.\.b, \.\.\.\(dueAt \? \{ dueAt \} : \{\}\)/);
});

test("Chats: only leaders see an AI answer's model, tokens and time; everyone sees stuck, error and answering", () => {
  const src = read("chats/conversation.tsx");
  const meter = src.match(/const meter = run \? \[([\s\S]*?)\]\.filter\(Boolean\)/);
  assert.ok(meter, "the meter is still built in one place");
  assert.match(meter[1], /lead && run\.model \? modelName\(run\.model\)/);
  assert.match(meter[1], /!lead \|\| run\.tokens === null \? null : tokenWords\(run\.tokens\)/);
  assert.match(meter[1], /!lead \|\| run\.seconds === null \? null : secondsWords/);
  assert.match(meter[1], /run\.state === "uncertain" \? "stuck" : run\.state === "error" \? "error" : run\.state === "dispatching" \? "answering" : null/);
  assert.ok(src.indexOf("const lead = !!cachedList()?.canLead") < src.indexOf("const meter = run ?"), "lead is known before the meter");
});
