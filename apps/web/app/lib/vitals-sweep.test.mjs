// VITALS-SWEEP (owner war sprint, 22 Nov 2026: "400+ screens ... extreme testing on all mobiles"): every screen outside
// project management was shot at 360/390/834/1440 in light and dark and scored by lane C's Fable rubric (words above the
// fold, one filled button, taps of 44 px, plain words, a phone layout of one column). These pin what each fix changed, so
// a later edit cannot quietly bring the low score back. Source-level, like the other app/lib tests: no browser here; the
// lane's browser walk and judge re-measure the live screens after each land.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
/** The CSS rules inside every `@media (max-width: N)` block whose N is a phone width (under 760 px, the app's breakpoint). */
const phoneCss = (css) => {
  const out = [];
  const re = /@media\s*\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (Number(m[1]) >= 760) continue;
    let depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out.join("\n");
};
/** The words a person sees: string and JSX text in a TSX file, without comments. */
const visibleText = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("Leads: the page title is the menu's word, Leads", () => {
  const page = read("acquisition/page.tsx");
  assert.match(page, /PageHeader title="Leads"/);
});

test("Leads: no internal or one-company words on the screen", () => {
  const ui = visibleText(read("acquisition/workspace.tsx"));
  for (const word of ["Accountable acquisition", "ROAS", "staffed-window", "Elapsed age", ">Cohort", "EA prospect", "EA agency sales", "EA collection", "Verified EA"]) {
    assert.ok(!ui.includes(word), `"${word}" is still on the Leads screen`);
  }
});

test("Leads on a phone: the filters fold behind one Filters button and the header stacks", () => {
  const ui = read("acquisition/workspace.tsx");
  assert.match(ui, /className=\{css\.filtersToggle\}[^>]*aria-expanded=/, "a Filters button that says whether the filters are open");
  assert.match(ui, /className=\{css\.tools\}[^>]*data-open=/, "the filters row carries its open state");
  const phone = phoneCss(read("acquisition/acquisition.module.css"));
  assert.match(phone, /\.tools:not\(\[data-open\]\)\s*\{\s*display:\s*none/, "closed filters take no room on a phone");
  assert.match(phone, /\.filtersToggle\s*\{[^}]*display:\s*flex[^}]*min-height:\s*44px/, "the Filters button is a 44 px tap");
  assert.match(phone, /\.intro\s*\{[^}]*flex-direction:\s*column/, "the title and Manual intake stack");
  assert.match(phone, /\.tabs a\s*\{[^}]*min-height:\s*44px/, "each view tab is a 44 px tap");
});

test("Leads: an empty queue says what to do, with one button", () => {
  const ui = read("acquisition/workspace.tsx");
  const empty = /className=\{css\.empty\}>([\s\S]*?)<\/div>/.exec(ui)?.[1] ?? "";
  assert.match(empty, /No enquiries yet/);
  assert.match(empty, /<Link[^>]*className=\{styles\.btnPrimary\}/, "one filled button in the empty state");
});

// SPEED (VITALS-SWEEP step 5): reads a page needs are sent together. Each read awaited after another one costs a full
// round trip to the API (0.1-0.6 s each in production telemetry, 7-20 Nov), so a page that awaits four in a row opens
// a second or more late. These pin that the reads below start before the page waits on the others.
/** The source position of the first match, or Infinity. */
const at = (src, re) => { const m = re.exec(src); return m ? m.index : Infinity; };

test("speed: a person's page starts carried, chats, Sales X-Ray and report reads with its main batch", () => {
  const src = read("people/[id]/page.tsx");
  const batch = at(src, /const \[work, personHr, hr,/);
  for (const re of [/people\/\$\{p\.id\}\/carried/, /chats\/whatsapp\?person=\$\{p\.id\}/, /sales-xray\/linked\?person=\$\{p\.id\}/, /reportFor\("person", p\.id\)/]) {
    assert.ok(at(src, re) < batch, `${re} starts before the main batch is awaited`);
  }
  assert.doesNotMatch(src, /\(await api<\{ card: Carried/, "carried is not awaited on its own");
  assert.doesNotMatch(src, /await reportFor\("person"/, "the report is not awaited on its own");
});

test("speed: the dashboard asks for a person's own tasks with the home read, not after it", () => {
  const src = read("dashboard/page.tsx");
  const home = at(src, /api<HomeData>\(`home\$\{apiPeriod\(params\)\}`\)/);
  const early = at(src, /const tasksEarly =/);
  assert.ok(early < home, "the tasks read starts before the home batch is awaited");
  assert.match(src, /tasksEarly \?\? api</, "the editor home uses the early read when it was made");
});

test("speed: Settings sends a tab's reads together", () => {
  const src = read("settings/page.tsx");
  assert.match(src, /await Promise\.all\(\[\s*tab === "work-rules" \? api</, "Work rules' reads go out in one batch");
  for (const re of [/\(await api<Parameters<typeof WorkModel>/, /tab === "work-rules" \? await api<RulesData>/, /tab === "organisation" && !hrOnly \? await api<PolicyData>/]) {
    assert.doesNotMatch(src, re, `${re} is no longer awaited on its own`);
  }
});

test("speed: an accepted quotation reads its project and its agreement chain together", () => {
  const src = read("erp/documents/[id]/page.tsx");
  assert.match(src, /const \[linked, chain\] = await Promise\.all\(\[/);
});

test("speed: Notifications reads an admin's connections with the main batch", () => {
  const src = read("notifications/page.tsx");
  assert.doesNotMatch(src, /\? await api<\{ people: Row\[\]; connections: Row\[\] \}>/);
  assert.ok(at(src, /notifications\/connections/) < at(src, /await Promise\.all\(\[api<\{ rows: Row\[\] \}>\("notifications"/), "connections start before the batch is awaited");
});

// Every screen in dark mode: the menu's count badges (the phone tab bar and the desktop rail) put white on the dark
// theme's light red (#e38e8e): 2.46:1. The label is the dark ink there (7.2:1), white on the light theme's red (5.34:1).
test("dark mode: the menu's count badges are readable (a label colour of their own, not the action's)", () => {
  const shell = readFileSync(new URL("../../../../packages/ui-shell/src/shell.module.css", import.meta.url), "utf8");
  const base = /\.bottomBadge, \.stripBadge \{([^}]*)\}/.exec(shell)?.[1] ?? "";
  assert.doesNotMatch(base, /color:\s*var\(--theme-action-text/, "a danger badge does not borrow the action's label colour");
  assert.match(base, /color:\s*#fff/);
  assert.match(shell, /:global\(:root\[data-theme="dark"\]\) \.bottomBadge, :global\(:root\[data-theme="dark"\]\) \.stripBadge \{ color: #17123a; \}/);
});

test("Dashboard on a phone: the three tiles are one-line rows (label, then the number), each a 44 px tap", () => {
  const phone = phoneCss(read("home/visible.module.css"));
  assert.match(phone, /\.lead\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, "one tile per row");
  assert.match(phone, /\.leadCard\s*\{[^}]*flex-direction:\s*row[^}]*min-height:\s*48px/, "label and number on one line, 48 px tall");
  assert.match(phone, /\.leadValue small\s*\{[^}]*display:\s*inline/, "the unit sits beside the number");
});

test("Start here on a phone: each step is its title (the note stays on wider screens); the step number keeps its contrast", () => {
  const css = read("start/start.module.css");
  assert.match(phoneCss(css), /\.startStep small\s*\{\s*display:\s*none/, "a phone shows the step titles only");
  assert.match(phoneCss(css), /\.startStep\s*\{[^}]*min-height:\s*48px/, "each step is a 48 px tap");
  assert.match(css, /\.startNo\s*\{[^}]*background:\s*var\(--theme-action[^}]*color:\s*var\(--theme-action-text/, "the number is the action's label on its fill");
});

test("Sales X-Ray connect: the Connect button comes before the reads and promises, which fold into one disclosure", () => {
  const src = read("apps/sales-xray/page.tsx");
  assert.ok(at(src, /<ConnectSheet /) < at(src, /className=\{css\.lists\}/), "the button is above the lists");
  assert.match(src, /<details className=\{css\.what\}><summary>[^<]+<\/summary><div className=\{css\.lists\}>/, "the lists are in one closed disclosure");
});

test("Audit: the filters fold behind one Filter button (open when a filter is set), dates say From and To, plain words", () => {
  const src = read("audit/page.tsx");
  assert.match(src, /<details className=\{own\.filters\} open=\{active > 0\}><summary>/, "one Filter disclosure, open when filtering");
  assert.match(src, /<label>From <DateField/); assert.match(src, /<label>To <DateField/);
  assert.doesNotMatch(src, /'Source sync'/, "no internal name for the automatic import");
  assert.match(src, /replace\(\/\^pulse\[\._\]\/, ""\)/, "the internal 'pulse.' prefix is never shown");
  assert.match(read("audit/audit.module.css"), /\.filters > summary \{[^}]*min-height: 44px/);
});

test("Connect your AI: the steps and the side card follow the room they have, not the window (container queries)", () => {
  const css = read("settings/connect-ai.module.css");
  assert.match(css, /\.page \{[^}]*container-type: inline-size/, "the page measures its own width");
  assert.match(css, /\.panel \{[^}]*container-type: inline-size/, "the setup panel measures its own width");
  assert.match(css, /@container \(max-width: 640px\) \{[^@]*\.steps li \{ grid-template-columns: 32px minmax\(0, 1fr\); \}/, "a narrow panel stacks each example under its step");
  assert.match(css, /@container \(max-width: 1000px\) \{[^@]*\.main \{ grid-template-columns: minmax\(0, 1fr\); \}/, "a narrow page puts Connected apps under the setup");
});

test("People: AI employee cards use plain words (no tokens or lanes, no bare Off); no filler line on person cards", () => {
  const ai = visibleText(read("people/ai-rows.tsx"));
  for (const w of ["tokens left", "Thinking lane", "Quick lane", '"Off"']) assert.ok(!ai.includes(w), `"${w}" is still shown`);
  assert.doesNotMatch(read("people/directory.tsx"), /"No joining date yet"/);
});

test("Billing document: no 'GSTIN' or 'ERP settings' jargon on the totals; the hint says how to charge GST", () => {
  const ui = visibleText(read("erp/documents/[id]/editor.tsx")).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const w of ['"no GST (no GSTIN)"', "no GST (no GSTIN in ERP settings)", "No GSTIN in ERP settings"]) assert.ok(!ui.includes(w), `"${w}" is still shown`);
  assert.match(ui, /add your company’s GST number in Billing settings/);
});

test("Work's set-up list: plain words, and only the next step shows until 'All steps' is opened", () => {
  const src = read("tasks/first-run.tsx");
  const ui = visibleText(src).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const w of ["Claude Max or Codex", "Linux server", "API key"]) assert.ok(!ui.includes(w), `"${w}" is still shown`);
  assert.match(src, /steps\.filter\(\(s\) => all \|\| s\.k === next\?\.k\)/, "closed, the list shows the next step only");
  assert.match(src, /aria-expanded=\{all\}/, "a button opens all the steps");
});

test("Tasks on touch screens: the tick circles are 32 px taps (as on the board)", () => {
  assert.match(read("tasks/focus.module.css"), /@media \(pointer: coarse\) \{[^}]*\.tick \{ width: 32px; height: 32px;/);
});

test("Tasks on touch screens: the lens chips (Assigned to me, I created, I'm reviewing, All mine) are 44 px taps", () => {
  assert.match(read("tasks/work3.module.css"), /@media \(pointer: coarse\) \{ \.lenses > button, \.listHead > \.lenses > button \{ height: 44px;/);
});

test("A person's page: no 'not set' chips in the header (About says it), and a one-sentence empty reporting line", () => {
  const src = read("people/[id]/page.tsx");
  assert.doesNotMatch(src, /value: p\.pod \?\? "not set"/);
  assert.doesNotMatch(src, /label: "Reports to", value: "not set"/);
  assert.doesNotMatch(src, /Admins can also set managers for the whole team in Settings/);
});

test("My desk: today's work comes first; 'Finish your profile' sits under it, not in the greeting", () => {
  const src = read("me/my-pulse.tsx");
  const hero = src.slice(at(src, /<section className=\{css\.hero\}/), at(src, /<\/section>\s*\{\/\* EST-1196/));
  assert.doesNotMatch(hero, /\{banner \?/, "no banner inside the greeting card");
  assert.ok(at(src, /className=\{css\.top\}/) < at(src, /\{banner \? <div className=\{`\$\{css\.heroAside\} \$\{css\.below\}`\}/), "the banner comes after today's cards");
});

test("Tasks → People on a phone: six numbers in a compact three-across strip (no notes), Fix first without its footnote, 44 px chips", () => {
  const css = read("tasks/people-view.module.css");
  assert.match(phoneCss(css), /\.tiles \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(phoneCss(css), /\.tile small, \.fix small \{ display: none; \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.fix a \{ height: 44px; \} \}/);
  assert.match(read("tasks/people-view.tsx"), /`\$\{onTime\.n\} of \$\{onTime\.of\} on time`/);
});

test("A phone's resting preview sheet (quote, template) is slim: no title row or info line at peek; errors still show", () => {
  const css = read("kit/drawer.module.css");
  assert.match(css, /\.drawer\[data-snap="peek"\] \.title, \.drawer\[data-snap="peek"\] \.status\[data-tone="info"\] \{ display: none; \}/);
  assert.doesNotMatch(css, /\.drawer\[data-snap="peek"\] \.status \{ display: none/, "an error line is never hidden");
});

test("Who can do what: the rules table turns into cards when its box is narrow (it pushed a tablet 180 px sideways)", () => {
  const css = read("settings/work-rules.module.css");
  assert.match(css, /\.scroll \{ container-type: inline-size; \}/);
  assert.match(css, /@container \(max-width: 700px\) \{[^@]*\.table thead \{ display: none; \}/);
});

test("Settings → Notifications: what may ping you comes first, no repeated subtitle, no 'bot token' words", () => {
  const page = read("settings/page.tsx");
  assert.match(page, /tab === "notifications" \? <Panel title="Notifications"><div style=\{\{ padding: "12px 16px" \}\}><MuteKinds \/><NotificationStatus \/><TelegramLink \/>/);
  assert.doesNotMatch(read("settings/telegram-link.tsx"), /bot token|start on the server/);
});

test("Settings → Organisation: 'Web address name', not 'Slug'", () => {
  const src = read("settings/organisation.tsx");
  assert.doesNotMatch(src, /<dt>Slug<\/dt>/);
  assert.match(src, /<dt>Web address name<\/dt>/);
});

test("A task: several 'looks like the same work' notes fold into one row (one shows as it is)", () => {
  const src = read("tasks/focus.tsx");
  assert.match(src, /same\.length > 1 \? <details className=\{css\.sameAll\}><summary>\{`\$\{same\.length\} tasks look like the same work`\}<\/summary>\{notes\}<\/details> : notes/);
  assert.match(read("tasks/focus.module.css"), /\.sameAll > summary \{[^}]*min-height: 44px/);
});

test("Docs on a phone: a card is its title, type and last activity (no body preview, no 'Last edit' line); 32 px title taps", () => {
  const css = read("docs/drive/drive.module.css");
  assert.match(phoneCss(css), /\.card \.cardText, \.card \.cardEdit \{ display: none; \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.cardTitle a \{ display: inline-flex; min-height: 32px;/);
});

test("Start here (dashboard, My day): the first step, then 'All N steps' (the guide page shows them all)", () => {
  const src = read("start/first-run.tsx");
  assert.match(src, /const steps = page \|\| all \? g\.seat\.steps : g\.seat\.steps\.slice\(0, 1\);/);
  assert.match(src, /aria-expanded=\{all\}/);
});

test("Billing sections on a phone: the chosen pill is a tinted outline (the page's main button stays the only filled one); 44 px pills", () => {
  const phone = phoneCss(read("erp/nav.module.css"));
  assert.match(phone, /\.section\[aria-current="page"\] \{ border-color: var\(--theme-action\); background: color-mix\(in srgb, var\(--theme-action\) 10%, var\(--theme-surface\)\); color: var\(--theme-action\);/);
  assert.match(phone, /\.section \{ min-height: 44px; \}/);
});

test("A list row's status chip stays in its column (a long 'With QA Owner (synthetic)' covered the client line on a phone)", () => {
  assert.match(read("components/calm.module.css"), /\.rowEnd > :not\(b\) \{ display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
});

test("Billing's numbers on a phone: each tile is one line (label, number), notes hidden: about half the height", () => {
  const phone = phoneCss(read("components/calm.module.css"));
  assert.match(phone, /\.stat \{ flex-direction: row; align-items: baseline; justify-content: space-between;/);
  assert.match(phone, /\.statSub \{ display: none; \}/);
});

test("What's new names a page by its menu name ('HR desk', 'PR Studio'), never 'Hr', 'Ai' or 'Pr'", () => {
  const src = read("whats-new/page.tsx");
  assert.match(src, /destForHref\(route\)\?\.label/);
  assert.match(src, /last\.length <= 3 \? last\.toUpperCase\(\)/);
});

test("Groups on touch screens: the count buttons (waiting on us, unread, to review) are 32 px taps", () => {
  assert.match(read("chats/groups/hub.module.css"), /@media \(pointer: coarse\) \{ \.statBtn \{ display: inline-flex; align-items: center; min-height: 32px;/);
});

test("An open doc on touch screens: Share is a 44 px tap, the File/Edit/View menus 36 px, 'Last edit' 32 px", () => {
  assert.match(read("docs/gdocs/gdocs.module.css"), /@media \(pointer: coarse\) \{ \.shareBtn \{ min-height: 44px; \} \.menuBtn \{ min-height: 36px; \} \.lastEdit \{ display: inline-block; max-width: 100%; line-height: 32px; \} \}/);
});

test("HR on touch screens: the alert's Review link 44 px, the attendance chip and day arrows 32 px", () => {
  assert.match(read("hr/desk.module.css"), /@media \(pointer: coarse\) \{ \.attChip \{ height: 32px; \} \.pickStep \{ width: 32px; \} \}/);
  assert.match(read("hr/desk/overview.module.css"), /@media \(pointer: coarse\) \{ \.alertLink \{ display: inline-flex; align-items: center; min-height: 44px; \} \}/);
});

test("Finance → Ledger: the read-only note is in plain words (no 'company index', 'as the file owner')", () => {
  const src = read("finance/cash.tsx");
  assert.doesNotMatch(src, /company index|as the file owner/);
});

test("Autopilots: what needs a person comes before the day's numbers", () => {
  const src = read("people/ai/autopilots.tsx");
  assert.ok(at(src, /<Needs agents=\{w\.agents\}/) < at(src, /<StatTiles label=\{today \? "Today in numbers"/));
});

test("People cards say where someone is in words (the dot alone was a colour-only state)", () => {
  assert.match(read("presence.tsx"), /export function PresenceWord\(/);
  assert.match(read("people/directory.tsx"), /<span className=\{css\.cardRole\}>\{p\.role\}<\/span><PresenceWord id=\{p\.id\} \/>/);
});

test("PR Studio's Today step is a tinted outline when chosen (Open the calendar stays the only filled button)", () => {
  assert.match(read("pr/flow.module.css"), /\.flowHome\[data-on="yes"\] \{ background: color-mix\(in srgb, #6B4CF0 12%, var\(--theme-surface\)\); color: var\(--theme-text\); box-shadow: inset 0 0 0 1\.5px #6B4CF0; \}/);
});

test("Rate cards with no service yet: the empty state's one button opens Catalogue", () => {
  assert.match(read("erp/rate-cards/rate-cards.tsx"), /!services\.length \? <Link className=\{`\$\{styles\.btn\} \$\{styles\.btnPrimary\}`\} href="\/erp\/catalog">Go to Catalogue<\/Link>/);
});

test("Add people: one spelling, 'email'", () => {
  const src = read("people/add/add-flow.tsx");
  assert.doesNotMatch(src, /Their e-mail|Pulse e-mails them/);
});

// RESTART 23 Nov: a task page (EA staff p50 2.3 s to open) read the org's zone, then the plan step, then the plan place,
// one after another after its main batch. They need only the task: one batch.
test("speed: a task page reads its zone, plan step and plan place together", () => {
  const page = read("tasks/[id]/page.tsx");
  assert.doesNotMatch(page, /await planStepOf\(/, "the plan step is not awaited on its own");
  assert.doesNotMatch(page, /\(await api<[^>]*>\(`tasks\/\$\{encodeURIComponent\(id\)\}\/plan-place`\)\)/s, "the plan place is not awaited on its own");
  assert.match(page, /Promise\.all\(\[orgZone\(\),\s*\n?\s*t\.projectId && me\.data\?\.side !== "client" \? planStepOf\(t\.id\)/);
});

test("CI-FIX-1124: a phone's resting quotation sheet still says why its main step is held (a warning line shows at peek)", () => {
  const css = read("kit/drawer.module.css");
  assert.doesNotMatch(css, /\.drawer\[data-snap="peek"\][^{]*\.status\[data-tone="warning"\]/, "a held reason is not hidden at peek");
  assert.match(css, /\.status\[data-tone="warning"\] \{/);
  assert.match(read("kit/drawer.tsx"), /tone\?: "error" \| "warning" \| "info"/);
  assert.match(read("erp/documents/[id]/editor.tsx"), /<DrawerFooter tone=\{!waiting && \(blocked \|\| approvalWait\) \? "warning" : "info"\}/);
});

// RESTART 24 Nov (judge: a task page scored 2 on a tablet, "no Start button above the fold"): from 721 to 1180 px the
// properties panel was ordered before the reading column, so Flag, Starts, Tags, Repeats and Who sees it filled the
// screen and the status, the why line and Start came after. A tablet now reads like a phone: the task first.
test("a task page on a tablet: the status and Start come before the properties panel", () => {
  const css = read("tasks/[id]/task-page.module.css");
  assert.doesNotMatch(css, /\.side\s*\{[^}]*order:\s*-1/, "the properties panel is never ordered first");
  const tablet = css.match(/@media \(max-width: 1180px\) \{([^\n]*)\}/);
  assert.ok(tablet, "the one-column rule for tablets is still there");
  assert.match(tablet[1], /\.side \{[^}]*order: 1;/, "on a tablet the panel follows the reading column");
});

// RESTART 24 Nov (judge: Settings → Work rules 2 for a seller, 4 for leadership): the chosen kind of business was shown by
// a violet border only, and the words were the builders' ("the rail", "scopes, dashboards and pickers", "the database
// enforces"). The chosen card now says "Selected" with a tick; the words are a seller's.
test("Work rules: the chosen kind of business says Selected, not only a coloured border", () => {
  const src = read("tasks/work-two.tsx");
  assert.match(src, /aria-checked=\{model === k\}[\s\S]{0,400}\{model === k \? <span className=\{css\.picked\}><Check size=\{12\} aria-hidden="true" \/>Selected<\/span> : null\}/);
  assert.match(read("tasks/work-two.module.css"), /\.models \.picked \{/);
});

test("Work rules: plain words, no builders' words", () => {
  const ui = visibleText(read("tasks/work-two.tsx")) + visibleText(read("settings/work-rules.tsx"));
  for (const word of ["the rail", "scopes, dashboards and pickers", "the database enforces"]) assert.ok(!ui.includes(word), `"${word}" is still on Work rules`);
});
