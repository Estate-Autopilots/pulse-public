// SETTINGS-APPLE (owner, 13 Nov 2026; OWNER-FEEDBACK-1113 P1.3, P1.4): the fixes a rebase could quietly undo, read from
// the sources as text (as visual-qa.test.mjs does). The database side of the admin console hand-off and of Focus in
// another company is tests/core/test_admin_console_handoff.py and tests/core/test_focus_here.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("T1.3.1: Settings is two panes, the list in the layout (kept between sections), with breadcrumbs and a phone stack", () => {
  const layout = read("../settings/layout.tsx"), frame = read("../settings/frame.tsx"), css = read("../settings/frame.module.css");
  assert.match(layout, /<SettingsFrame areas=\{areas\}/);
  assert.match(frame, /data-open=\{current \|\| path !== "\/settings" \? "detail" : "list"\}/);
  assert.match(frame, /touchstart/, "swipe from the left edge goes back on a phone");
  assert.match(css, /\.frame\[data-open="detail"\] \.list \{ display: none; \}/);
  const nav = read("../settings/nav.tsx"), crumbs = read("../settings/crumbs.tsx");
  assert.match(nav, /<Crumbs trail=\{trail\} \/>/);
  assert.match(crumbs, /router\.back\(\)/); assert.match(crumbs, /router\.forward\(\)/);
  assert.doesNotMatch(nav, /sectionTabs/, "no row of section chips repeating the list");
});

test("T1.3.2: no Change password on the Settings home; Your account is a short list; the password is under Password & security", () => {
  const home = read("../settings/home.tsx"), page = read("../settings/page.tsx"), list = read("../settings/account-list.tsx");
  assert.doesNotMatch(home, />Change password</);
  assert.doesNotMatch(page, />Change password</);
  assert.match(list, /tab=account&part=security/);
  assert.match(page, /<Security google=\{query\.google\}/);
  assert.match(read("../settings/settings.module.css"), /\.homeStart ol \{ display: grid; grid-template-columns: repeat\(auto-fit/, "Start with fills the pane's width");
  const look = read("../settings/appearance.tsx");
  assert.match(look, /<Segmented label="Theme"/); assert.doesNotMatch(look, /<fieldset/);
});

test("T1.3.4: Admin console hands the session over (no second sign-in) and never shows a refusal", () => {
  const admin = read("../admin/page.tsx");
  // The hand-off is made in the browser once the page is open (open-console.tsx), never while the server renders or a
  // link prefetches /admin; a failure offers Try again, not a second sign-in.
  assert.match(admin, /return <OpenConsole site=\{site\} \/>;/);
  assert.doesNotMatch(admin, /apiPost|fetch\(/);
  const open = read("../admin/open-console.tsx");
  assert.match(open, /^"use client";/);
  assert.match(open, /fetch\("\/api\/v0\/auth\/admin-handoff", \{ method: "POST"/);
  assert.match(open, /window\.location\.replace\(`\$\{site\}\/handoff#\$\{d\.token\}`\)/);
  assert.match(open, /label: "Try again"/);
  assert.doesNotMatch(admin, /is for Pulse’s platform admins/);
  assert.match(read("./nav.ts"), /\(me\?\.platformAdmin \|\| me\?\.platformConsole\) && !me\.mustChange/);
  const site = read("../../../admin/app/auth/handoff/route.ts");
  assert.match(site, /\/api\/v0\/auth\/admin-handoff\/redeem/);
  assert.match(site, /sameOrigin\(request\)/);
});

test("T1.4.2: Focus opens in place in another company (no company switch, no 'This page is in …')", () => {
  const shell = read("../../../../packages/ui-shell/src/shell.tsx");
  assert.ok(shell.includes('if (there && key === "focus") return [{ ...page, blurb: "Your AI work for this company" }];'));
  assert.match(read("../focus/layout.tsx"), /moduleElsewhere\(me, "focus"\)\) return children;/);
  assert.match(read("../focus/page.tsx"), /"account\/focus" : "focus"/);
  const board = read("../focus/board.tsx");
  assert.match(board, /label: "All my companies"/);
  // PULSE-POLISH (owner, 14 Nov 2026): the header names the company Focus is open in (one subtitle: what to run next, and why).
  assert.match(board, /eyebrow=\{here && scope === "company" \? here\.name : "All my companies"\}/);
});

test("T1.4.1: Listen is one button; telling everyone is a question when it is pressed, not a box to tick first", () => {
  const room = read("../listen/room.tsx");
  assert.match(room, /title: "Did you tell everyone\?"/);
  assert.doesNotMatch(room, /type="checkbox"/);
  assert.match(room, /"Start listening"/);
  assert.match(room, /consent: true/);
});

test("T1.3.3: Review data is one queue; WhatsApp names are a type in it, not a page of their own; sure ones together, with Undo", () => {
  const shell = read("../../../../packages/ui-shell/src/shell.tsx");
  assert.ok(!/"\/review-data": \[/.test(shell), "no menu sub-item under Review data");
  assert.match(read("../review-data/whatsapp-names/page.tsx"), /if \(r\.data\) redirect\("\/review-data\?type=whatsapp-names"\);/);
  const page = read("../review-data/page.tsx");
  assert.match(page, /<ChipFilter label="Types" current=\{type\} items=\{chips\} \/>/);
  assert.match(page, /<Matcher key=\{names\.data\.source\} initial=\{names\.data\} embedded \/>/);
  const sure = read("../review-data/sure.tsx");
  assert.match(sure, /function undo\(\)/); assert.match(sure, /review-data\/decide/);
  assert.match(read("../review-data/attention.tsx"), /Your AI:/);
});
