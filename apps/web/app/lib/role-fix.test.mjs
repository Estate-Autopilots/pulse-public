// ROLE-FIX (QA-2 role walk on dev, 18 Nov 2026): no role's menu offers a page that then refuses it, and an AI employee's
// MCP tools/list offers no tool that refuses it. The rules a rebase could quietly undo, read from the sources (as
// visual-qa.test.mjs reads the menu) and, for the removal rule, run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { removedOf, removedUnder } from "../../../../packages/ui-shell/src/removed.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const shell = read("../../../../packages/ui-shell/src/shell.tsx");
const nav = read("./nav.ts");

test("a removed entry with a query removes only itself; one without takes everything under it", () => {
  const removed = removedOf({ "/tasks?view=projects": null, "/finance": null, "/clients": "Customers" });
  assert.deepEqual(removed, ["/tasks?view=projects", "/finance"]);
  assert.equal(removedUnder("/tasks?view=projects", removed), true, "HR's Work → Projects leaves the menu");
  assert.equal(removedUnder("/tasks", removed), false);
  assert.equal(removedUnder("/tasks?view=people", removed), false);
  assert.equal(removedUnder("/finance?tab=ledger", removed), true, "Import statement leaves with Finance");
  assert.equal(removedUnder("/finance/desk", removed), true);
  assert.equal(removedUnder("/financed", removed), false);
  assert.equal(removedUnder("/clients", removed), false, "a rename is not a removal");
  // The shell's sub-places and recents use the rule (it used to skip every removal with a query).
  assert.doesNotMatch(shell, /!href\.includes\("\?"\)\)\.map\(\(\[href\]\) => href\)/);
  assert.match(shell, /!removedUnder\(sub\.href, removed\)/);
  assert.match(nav, /"\/tasks\?view=projects": null/, "lib/nav.ts still removes Projects for an HR-only account");
});

test("Team → Hiring and Skills are only on the menus of HR and admins (the API's viewer_is('hr','admin'))", () => {
  assert.match(shell, /\{ label: "Hiring", href: "\/people\/jobs", lead: "people" \}/);
  assert.match(shell, /\{ label: "Skills", href: "\/people\/skills", lead: "people" \}/);
  assert.match(shell, /const PEOPLE_DESK = new Set\(\["Organisation owner\/admin", "HR", "HR and leadership"\]\)/);
  assert.match(read("../../../../services/api/src/ats.ts"), /viewer_is\('hr','admin'\)/);
  assert.match(read("../../../../services/api/src/skills.ts"), /viewer_is\('hr','admin'\)/);
});

test("Billing's Import statement opens Finance's Data sources and leaves with Finance; the Finance role has Finance", () => {
  assert.match(shell, /\{ label: "Import statement", href: "\/finance\?tab=ledger" \}/);
  assert.match(nav, /financeAccess !== false \? \{\} : \{ "\/finance": null \}/);
  assert.match(shell, /roleLabel === "Finance"\) return allPages\.filter\(\(page\) => page\.href === "\/erp" \|\| page\.href === "\/finance"/);
  const migration = read("../../../../db/migrations/2400_finance_role_money.sql");
  assert.match(migration, /viewer_is\('leadership','finance'\)/);
  assert.match(migration, /or agent_finance\(\)/, "the AI employee's Finance role keeps its grants");
});

test("Connect your AI reads the company's AI only for admins and leadership (no refused call for anyone else)", () => {
  const page = read("../settings/page.tsx"), ai = read("../settings/connect-ai.tsx");
  assert.match(page, /const companyAi = admin \|\| role === "leadership" \|\| !!me\.data\.lead;/);
  assert.match(page, /<ConnectAi [^>]*companyAi=\{companyAi\}/);
  assert.match(ai, /useState<Company>\(companyAi \? null : "not-yours"\)/);
  assert.match(ai, /if \(!companyAi\) return;\s*send<AiData>\("ai"\)/);
  assert.match(read("../../../../services/api/src/connect-ai.ts"), /const leaders = \(v: Viewer\) => \{ if \(!leadership\(v\)\)/);
});

test("MCP tools/list offers an AI employee only the tools that let it in", () => {
  const block = (file, name) => {
    const src = read(`../../../../services/api/src/${file}`), at = src.indexOf(`name: '${name}'`);
    assert.ok(at > 0, `${name} in ${file}`);
    return src.slice(src.lastIndexOf("defineV1Operation(", at), at);
  };
  for (const [file, name, rule] of [
    ["v1-people.ts", "list_my_changes", /available: async ctx => ctx\.principal\.kind === 'person'/],
    ["v1-people.ts", "undo_change", /available: async ctx => ctx\.principal\.kind === 'person'/],
    ["v1-events.ts", "list_webhooks", /available: admins/],
    ["v1-events.ts", "create_webhook", /available: admins/],
    ["v1-events.ts", "list_webhook_deliveries", /available: admins/],
    ["v1-finance.ts", "list_finance_entries", /available: ledgerReader/],
    ["v1-finance.ts", "list_expenses", /available: ledgerReader/],
    ["v1-finance.ts", "get_finance_entry", /available: ledgerReader/],
    ["v1-finance.ts", "get_finance_numbers", /available: ledgerReader/],
    ["v1-finance.ts", "record_expense", /available: ledgerWriter/],
    ["v1-finance.ts", "list_money_records", /available: moneyReader/],
    ["v1-finance.ts", "import_bank_statement", /available: statementImporter/],
    ["v1-hr.ts", "list_leave_types", /available: staffSee/],
    ["v1-hr.ts", "request_leave", /available: staffSee/],
  ]) assert.match(block(file, name), rule, name);
  assert.match(read("../../../../services/api/src/v1.ts"), /if \(!op\.available \|\| await op\.available\(ctx\)\) visible\.push\(op\)/);
});
