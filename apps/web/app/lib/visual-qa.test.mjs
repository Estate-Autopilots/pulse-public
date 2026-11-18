// VISUAL-QA (owner, 10 Nov 2026: "a lot of new bugs on screens; Settings, and all the new UI/UX pages"): the fixes a
// rebase could quietly undo, read from the sources as text (as nav-coverage.test.mjs reads the menu).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const shell = read("../../../../packages/ui-shell/src/shell.tsx");
const entry = (href) => { const m = new RegExp(`\\{ label: "[^"]+",(?: short: "[^"]*",)? href: "${href.replace(/[?]/g, "\\?")}"[^}]*\\}`).exec(shell); assert.ok(m, `${href} is in the menu`); return m[0]; };

test("the sidebar's Settings group is captioned You / Company / Admin tools", () => {
  assert.match(shell, /\["you", "You"\], \["company", "Company"\], \["admin", "Admin tools"\]/);
  assert.match(entry("/review-data"), /cluster: "company"/);
  for (const href of ["/audit", "/telemetry", "/admin", "/bug-reports"]) assert.match(entry(href), /cluster: "admin"/, href);
  assert.match(shell, /const SETTINGS: Page = \{[^}]*cluster: "you"/);
  // The most-used sections are rows of the group, and its first row is "All settings" (it read Settings › Settings).
  for (const href of ["/settings?tab=account", "/settings?tab=notifications", "/settings?tab=organisation", "/settings?tab=sign-in", "/settings?tab=work-rules"]) assert.ok(shell.includes(`"${href}": [`), href);
  assert.ok(shell.includes('"All settings"'));
});

test("What Pulse can do is a Home page, beside Learn Pulse, not an admin tool", () => {
  assert.match(entry("/features"), /group: "home"/);
});

test("a page outside the menu never lights Home by falling back to the first page", () => {
  assert.ok(shell.includes('"/account": "/settings?tab=account"'), "Account / Security lights Your account");
  assert.match(shell, /const matched = page !== pages\[0\]/);
});

test("a link's own class sets its colour inside a page or a dialog (white words on violet buttons)", () => {
  const ui = read("../ui.module.css"), drawer = read("../kit/drawer.module.css");
  assert.doesNotMatch(ui, /^\.page a \{/m, "'.page a' outranked one-class link buttons");
  assert.match(ui, /^:where\(\.page\) a \{ color: inherit;/m);
  assert.doesNotMatch(drawer, /^\.drawer a \{/m);
  assert.match(drawer, /^:where\(\.drawer\) a \{ color: inherit; \}/m);
});

test("/settings/ai and /work are never 'Page not found'", () => {
  const config = read("../../next.config.ts");
  assert.ok(config.includes('{ source: "/settings/ai", destination: "/settings?tab=connect-ai"'));
  assert.ok(config.includes('{ source: "/settings/:tab([a-z][a-z-]*)", destination: "/settings?tab=:tab"'));
  assert.ok(config.includes('{ source: "/work", destination: "/tasks"'));
});

test("filled violet and red buttons use the theme's button-text colour, never white (2.4:1 on dark mode's light violet)", () => {
  const css = ["../tasks/checkin-card.module.css", "../tasks/map/graph.module.css", "../settings/servers.module.css", "../notify-welcome.module.css", "../tasks/review-chip.module.css"];
  const white = /background(-color)?: ?var\(--theme-(action|danger)(, ?#[0-9a-fA-F]+)?\)[^}\n]*(?<![-\w])color: ?(#fff|#ffffff|white)\b|(?<![-\w])color: ?(#fff|#ffffff|white)\b[^}\n]*background(-color)?: ?var\(--theme-(action|danger)(, ?#[0-9a-fA-F]+)?\)/;
  for (const path of css) assert.doesNotMatch(read(path), white, path);
  assert.match(read("../tasks/checkin-card.module.css"), /color: var\(--theme-action-text, #fff\)/);
});

test("an HR-only account's menu leaves out the Work and Team pages the API refuses it (My week, Projects, Designers)", () => {
  const nav = read("./nav.ts");
  assert.match(nav, /const hrOnlyOff: Record<string, null> = me\?\.role === "hr" && !me\.lead \? \{ "\/my-week": null, "\/tasks\?view=projects": null, "\/designers": null \}/);
  assert.match(nav, /\.\.\.payOff, \.\.\.hrOnlyOff \};/);
});

test("back links and buttons never lead someone into a refusal (Claims, WhatsApp names, Delivery's Client access)", () => {
  assert.match(read("../people/pay/claims/page.tsx"), /back=\{pay \? \{ href: "\/people\/pay", label: "People & pay" \} : \{ href: "\/people", label: "Team" \}\}/);
  assert.match(read("../review-data/whatsapp-names/page.tsx"), /back=\{r\.status === 403 \? \{ href: "\/", label: "Home" \}/);
  assert.match(read("../delivery/page.tsx"), /\{clients&&<Link className=\{styles\.btn\} href="\/delivery\/access">Client access<\/Link>\}/);
});

test("small words reach 4.5:1 (Goals' Next, Processes' Live, Meetings' hint, a selected area's count)", () => {
  assert.doesNotMatch(read("../goals/goals.module.css"), /\.nextLink > span:first-child \{[^}]*opacity: \.85/);
  assert.match(read("../processes/processes.module.css"), /\.status\[data-status="live"\] \{[^}]*color: color-mix\(in srgb, var\(--theme-success\) 70%, var\(--theme-text\)\)/);
  assert.match(read("../meetings/meetings.module.css"), /^\.wayMain small \{ color: #fff; \}/m);
  assert.match(read("../hq/hq.module.css"), /^\.sumBtn\[data-on\] span \{ color: var\(--ink-2\); \}/m);
});

test("Add processes from Google Drive lists documents; their steps show on the document's own page (it was 16,000 px)", () => {
  assert.match(read("../sops/drive-parts.tsx"), /\{detail \? <ol>\{p\.preview\.map\(/);
});

test("filter and chip counts are not faded below 4.5:1 (People & pay's filters, Settings' chips)", () => {
  assert.doesNotMatch(read("../finance/table.module.css"), /\.tools \.filter span \{[^}]*opacity/);
  assert.doesNotMatch(read("../settings/settings.module.css"), /^\.chip small \{[^}]*opacity/m);
});

test("Agreements' Sent · Opened · Signed track reads at full strength (its 70% grey was 2.95:1)", () => {
  const css = read("../contracts/contracts.module.css");
  assert.match(css, /^\.track li:not\(\[data-done\]\) \{ color: var\(--theme-text-muted\); \}/m);
  assert.doesNotMatch(css, /\.track li:not\(\[data-done\]\) \{ color: color-mix/);
});

test("Home says how many clients went quiet once, and its main button is Pulse violet", () => {
  assert.ok(read("../home/brain.ts").includes('if (top?.id === "clients") for (const n of next) if (n.id === "quiet") n.title = "Check in with the quiet clients";'));
  assert.match(read("../home/home.module.css"), /^\.primary \{ background: var\(--theme-action, #5b45d6\); color: var\(--theme-action-text, #fff\); \}/m);
});

test("Leadership never compares a period still running with a whole one (Deliveries said 5 ↓84% on a Friday)", () => {
  assert.ok(read("../leadership/view.tsx").includes("delta={data.period.inProgress ? undefined : <Delta value={data.deliveries} previous={data.deliveriesPrev} />}"));
});

test("a table or list that scrolls in its box fades at the edge while there is more (My week on a phone looked cut off)", () => {
  assert.match(read("../ui.module.css"), /\.tableWrap \{ animation: tabsMore linear both; animation-timeline: scroll\(self inline\); \}/);
  assert.match(read("../delivery-claims.module.css"), /\.list \{ animation: claimsMore linear both; animation-timeline: scroll\(self block\); \}/);
});

test("Goals explains health once (not a '?' on every row) and keeps each next step to two lines", () => {
  assert.ok(read("../goals/page.tsx").includes('help={g.id === goals.find((x) => x.status === "active")?.id}'));
  assert.match(read("../goals/goals.module.css"), /^\.nextText \{[^}]*-webkit-line-clamp: 2;/m);
});

test("Projects lists the first 20 (needs-you-first) with Show all; a search or chip shows every match", () => {
  const o = read("../projects/overview.tsx");
  assert.ok(o.includes('const listed = all === "1" || filter || needle ? shown : shown.slice(0, 20);'));
  assert.ok(o.includes("{listed.map((x) => {"));
  assert.ok(read("../tasks/page.tsx").includes("started={q.started} all={q.all} />"));
});

test("Leadership's one-login risk leads with the address, so 'If' never stands alone above a cut-off e-mail", () => {
  assert.ok(read("../leadership/view.tsx").includes("detail: `${one.account}: if it is lost or locked, delivery stops and its history has no owner` });"));
});

test("My day shows no 0 / 0 / 0 / 0 strip on an empty day", () => {
  assert.ok(read("../my-day/my-day.tsx").includes('{t.overdue + t.today + t.doing + t.planned + t.actual ? <dl className={css.stats} aria-label="Today at a glance">'));
});

test("Settings keeps the developer and data sections together in a last Advanced area", () => {
  const t = read("../settings/types.ts");
  // SETTINGS-APPLE (13 Nov 2026): the AI sections are one AI area before Advanced; the developer and data ones stay last.
  assert.ok(t.includes('{ key: "ai", label: "AI", short: "AI", hue: 300, tabs: ["ai", "connectors", "connect-ai", "servers"] }'));
  assert.ok(t.includes('{ key: "data", label: "Advanced", short: "Advanced", hue: 340, tabs: ["api-keys", "data-health", "desktop-app"] }'));
  assert.ok(t.includes('tabs: ["account", "notifications", "appearance", "connected-apps", "devices", "privacy"]'));
});

test("My work says each measure's line in plain words (no 'independent anchors' or 'eligible EWU')", () => {
  const w = read("../me/work/workspace.tsx");
  assert.ok(w.includes("'Unscored · independent anchors':'Not scored yet · needs an independent reviewer'"));
  assert.ok(w.includes("<small>{detail(m.detail)}</small>"));
});

test("round 3 small fixes: rows wrap to two lines, a short directory placeholder, no empty legend, no chips that repeat one heading", () => {
  assert.match(read("../kit/game/game.module.css"), /^\.rowText small \{[^}]*-webkit-line-clamp: 2;/m);
  assert.ok(read("../directory/search.tsx").includes('"Name, @handle, GSTIN or CIN"'));
  assert.ok(read("../my-day/my-day.tsx").includes("Time today{day.streams.length ? <small>planned · spent</small> : null}</h2>"));
  assert.ok(read("../contracts/agreement-list.tsx").includes("{GROUPS.filter((g) => count(g.key)).length > 1 ? <div className={css.chips}"));
});

test("round 3: no offer-letter link into a refusal; Data review's suggestions scroll in their panel; the Drive list shows 15 then Show all", () => {
  // AGREEMENTS round 14 Nov: the page is a workspace; its links into pay letters and the team view show only to those they open for.
  const ws = read("../people/agreements/workspace.tsx");
  assert.ok(ws.includes('{canOffer ? <Link href="/people/pay/settings">Pay policy → letters</Link> : null}'));
  assert.ok(ws.includes('action: canTeam ? <Link className={gameCss.quiet} href="/agreements?tab=team">'));
  assert.match(read("../review-data/review.module.css"), /\.split \{ grid-template-rows: minmax\(0, 1fr\); \}/);
  assert.ok(read("../sops/drive/page.tsx").includes('const listed = q.all === "1" ? d.sources : d.sources.slice(0, 15);'));
});

test("My week says 'Week 46', never the ISO code '2026-W46'", () => {
  assert.ok(read("../my-week/personal-my-week.tsx").includes('<Panel title="Deliveries by creative type">'));
  assert.ok(read("../delivery-claims.tsx").includes('`Week ${Number(week.split("-W")[1])}`'));
});

test("no white words on accents dark mode lightens (Docs' New, the calendar's today, Goals' done step, the milestone card)", () => {
  assert.doesNotMatch(read("../docs/drive/drive.module.css"), /var\(--dd-accent\)[^}\n]*(?<![-\w])color: #fff\b/);
  assert.doesNotMatch(read("../kit/calendar/calendar.module.css"), /var\(--cal-accent\); color: #fff/);
  assert.doesNotMatch(read("../goals/goals.module.css"), /background: var\(--g-accent\); border-color: var\(--g-accent\); color: #fff/);
  assert.match(read("../kit/game/game.module.css"), /color: var\(--fx-accent-ink, #fff\); box-shadow/);
});

test("My profile's empty values and the Drive list's confidence chips reach 4.5:1", () => {
  assert.doesNotMatch(read("../people/[id]/my-info.module.css"), /\.row dd\[data-empty\] \{[^}]*opacity/);
  assert.match(read("../sops/sops.module.css"), /\.confidence\[data-level="high"\] \{[^}]*color: color-mix\(in srgb, var\(--theme-success\) 70%, var\(--theme-text\)\)/);
});

test("Projects' rows say 'No plan yet' (the words open the template picker), not 'Use a template' on every row", () => {
  const n = read("../projects/new-project.tsx");
  assert.ok(n.includes('title="Use a template">\n    No plan yet</button>'));
});

test("one violet button per view: My day's empty day and the Drive list", () => {
  assert.ok(read("../my-day/my-day.tsx").includes('<Link href="/tasks" className={css.btn}>Plan the week in Work</Link>'));
  assert.ok(read("../sops/drive-parts.tsx").includes('className={`${styles.btn}${detail ? ` ${styles.btnPrimary}` : ""} ${styles.btnSmall}`}'));
});

test("Projects shows no strip of zero stages", () => {
  assert.ok(read("../projects/overview.tsx").includes("{ceo && d.ceo?.stages.some((st) => st.projects) ? <Panel title={`Where the ${lower(words.projects)} are`}"));
});

test("the sidebar's list fades at its edges while there is more to scroll (its last row was cut by the divider)", () => {
  assert.match(read("../../../../packages/ui-shell/src/nav.module.css"), /\.groups \{ animation: navMore linear both; animation-timeline: scroll\(self block\); \}/);
});

test("Finance's state chips and tags reach 4.5:1 (words mixed toward the text colour, not a tone on its own tint)", () => {
  assert.match(read("../kit/game/game.module.css"), /\.chip\[data-tone="warn"\] \{[^}]*color: color-mix\(in srgb, var\(--fx-warn\) 60%, var\(--theme-text\)\)/);
  assert.match(read("../finance/desk/ca.module.css"), /\.kind\[data-kind="sales"\] \{[^}]*color: color-mix\(in srgb, var\(--theme-success\) 70%, var\(--theme-text\)\)/);
  assert.match(read("../ui.module.css"), /^\.badge\[data-tone="danger"\] \{[^}]*; color: color-mix\(in srgb, var\(--theme-danger\) 80%, var\(--theme-text\)\)/m);
});

test("contact and client type badges reach 4.5:1 in light and dark (Channel partner was 4.25:1 in dark)", () => {
  assert.match(read("../record-types.module.css"), /^\s*background: hsl\(var\(--type-h\) var\(--type-s\) 52% \/ 0\.13\); color: color-mix\(in srgb, hsl\(var\(--type-h\) var\(--type-s\) 46%\) 50%, var\(--theme-text\)\);/m);
});

test("Role briefs: a priority is not repeated as Missing input, stamps are in words, chips are as wide as their words", async () => {
  const page = read("../briefs/page.tsx");
  assert.ok(page.includes("missing={id===p.missing_input}") && page.includes('<Badge tone="warning">Missing input</Badge>'));
  assert.ok(page.includes("{once('Missing input',p.missing_input)}") && !page.includes('<Card label="Missing input"'));
  assert.ok(page.includes("Made {stamp(p.as_of)}") && !page.includes("Made {p.as_of}"));
  assert.ok(!read("../briefs/controls.tsx").includes("Observed · {f.observed_at}"));
  assert.match(read("../intelligence/intelligence.module.css"), /^\.card > \[data-tone\] \{ justify-self: start; \}/m);
  const words = read("../briefs/words.ts");
  assert.ok(words.includes("dayTime(v)") && words.includes("longDay(v)") && words.includes("v==='unknown'?'Not known'") && words.includes("'Frozen evidence vintage'?'As first sent'"));
  const { dayTime, longDay } = await import("./format.ts");
  assert.equal(dayTime("2026-11-13T11:39:24.722Z"), "13 Nov, 17:09");
  assert.equal(longDay("2026-11-13"), "Fri 13 Nov");
});

test("Activity's views are tabs that show the open one, and its note is in plain words", () => {
  const page = read("../activity/page.tsx");
  assert.equal((page.match(/<ActivityTabs current=\{q\.tab\}\/>/g) || []).length, 2);
  assert.ok(!page.includes("styles.btn} href=\"/activity"));
  assert.ok(!page.includes("{d.detail}") && page.includes("{CREDIT}"));
  assert.ok(!page.includes("were established for this view"));
  // An empty list is one empty state (no bare table frame, no Previous/Next on page 1); actions read as words.
  assert.ok(page.includes(`!d.rows.length?<Empty first icon={UserRoundCheck} title="No actions to show yet"`));
  assert.ok(page.includes("{d.rows.length||d.page?<Navigation"));
  assert.ok(page.includes("{action(a.operation)}") && !page.includes("{text(a.operation)}"));
  // Who an action counts for, in words and short enough that the table fits the card at 1440 (D129).
  assert.ok(page.includes("<th>Counts for</th>") && page.includes("{credit(a).who}") && !page.includes("{text(a.basis)}"));
  // On a phone each action is a stacked block, not a four-column table cut at the right edge (D130).
  assert.ok(page.includes("<table className={log.log}>"));
  assert.match(read("../activity/activity.module.css"), /table\.log\.log thead \{ display: none; \}/);
});

test("Role briefs: one primary button (the first priority's next step), the caveat and the evidence button in plain words", () => {
  const page = read("../briefs/page.tsx"), controls = read("../briefs/controls.tsx");
  assert.ok(page.includes("primary={i===0}") && page.includes("{CAVEAT}") && !page.includes("{p.caveat}"));
  assert.ok(controls.includes(">Why Pulse says this</button>") && !controls.includes("vintage"));
});

test("no link to an address that is not a page: What Pulse can do's Search everything (/search), My sales' Quotes (/quotes)", () => {
  assert.ok(read("../features/page.tsx").includes('const NO_PAGE = ["/search"];'));
  assert.ok(!read("../sales/desk.tsx").includes('href="/quotes"'));
});

test("My sales points to New quotation only where that button is (people who can open Billing)", () => {
  const page = read("../sales/page.tsx");
  assert.ok(page.includes("d.canOpenErp ? 'Send your first quotation with New quotation above.' : 'Quotations that name you show here once someone with Billing sends one.'"));
  assert.ok(page.includes("d.canOpenErp ? 'Use New quotation above to send your first one.' : 'A quotation that names you shows here once it is sent.'"));
  assert.ok(page.includes("d.canOpenErp ? 'Quotations you make or send appear here.' : 'Quotations that name you appear here.'"));
});

test("My sales says 'nothing yet' once: no deals summary, Quotations, Invoices or empty approval list beside the empty hero", () => {
  const page = read("../sales/page.tsx"), desk = read("../sales/desk.tsx");
  assert.ok(page.includes("{deals.data && !fresh ? <section") && page.includes("{fresh ? null : <div className={css.grid}>"));
  assert.ok(desk.includes("{d.approval.on && (canOpenErp || d.approval.waiting.length || d.approval.forMe.length) ? <Panel"));
});

test("Attendance & leave history shows one empty state, not a bare table and pager, when nothing is recorded", () => {
  const page = read("../hr-history/page.tsx");
  assert.ok(page.includes('{!d.rows.length&&!d.page?<section className={styles.panel}><Empty first icon={CalendarRange} title="No past months yet"'));
  assert.ok(page.includes("{d.rows.length||d.page?<Navigation base=\"/hr-history\""));  // Plain words: no "every read audited" / "unanchored years stay explicit"; the button names where it goes (D137).
  assert.ok(!page.includes("every read audited") && !page.includes("{d.detail}") && page.includes(">History on My desk</Link>"));
});

test("the empty-state pictures have a transparent background (no white square on the canvas, no light disc in dark mode)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const a of ["nothing", "done", "connect"]) {
    const b = readFileSync(new URL(`../../public/fun/empty-${a}.webp`, import.meta.url));
    // A WebP with alpha is VP8X with the alpha flag (0x10), or lossless VP8L with its alpha hint bit set.
    const chunk = b.toString("latin1", 12, 16);
    assert.ok(chunk === "VP8X" ? (b[20] & 0x10) !== 0 : chunk === "VP8L" && (b[24] & 0x10) !== 0, `empty-${a}.webp has no alpha`);
  }
  assert.ok(!read("../kit/game/game.module.css").includes("background: #F6F5FA; padding: 8px"));
});

test("Meetings has one primary way in: no second violet 'Add a meeting' under the Paste or upload tile", () => {
  const page = read("../meetings/page.tsx");
  assert.ok(page.includes('action={q.length >= 2 ? { href: "/meetings/new", label: "Add a meeting" } : undefined}'));
  assert.ok(!page.includes("Wispr Flow, Loom, Otter"));
});

test("a red count on a chip (Finance's Money in 25) reaches 4.5:1: words mixed toward the text colour", () => {
  assert.match(read("../components/kit.module.css"), /\.chipCount\[data-tone="danger"\] \{[^}]*color: color-mix\(in srgb, var\(--theme-danger\) 80%, var\(--theme-text\)\)/);
});

test("on a phone, Attendance & leave history shows each month as one block with named counts", () => {
  const page = read("../hr-history/page.tsx");
  assert.ok(page.includes("<table className={hist.hist}>") && page.includes('<td data-label="Leave">') && page.includes('<td data-label="WFH">'));
  assert.match(read("../hr-history/history.module.css"), /table\.hist\.hist td\[data-label\]::before \{ content: attr\(data-label\)/);
});

test("the AI employee chips on Groups reach 4.5:1 in dark mode (were 3.29:1)", () => {
  assert.match(read("../chats/groups/hub.module.css"), /^\.aiChip \{[^}]*color: color-mix\(in srgb, #7c3aed 55%, var\(--theme-text\)\)/m);
});

test("PR Studio's violet and channel words reach 4.5:1 in light and dark (Open slot was 2.61:1 in dark)", () => {
  const flow = read("../pr/flow.module.css");
  assert.ok(flow.includes("--v-ink: color-mix(in srgb, var(--v) 60%, var(--theme-text));"));
  assert.ok(!/color: var\(--v\);/.test(flow) && !/color: var\(--chc(, var\(--v\))?\);/.test(flow));
  assert.match(flow, /^\.ghost \{[^}]*color: color-mix\(in srgb, var\(--chc, var\(--v\)\) 60%, var\(--theme-text\)\); \}/m);
});
