# Vitals QA (QA system stage 1, Vitals side, part 2: QA-2)

Scripts that use the QA company made by `tools/admin/qa-org.py` (QA-1): synthetic people only, a test and rehearsal
company, credentials in `~/.config/vitals-qa/<env>.json` (mode 600; never printed). No real person's login, ever.

| Script | What it does | Where | When |
|---|---|---|---|
| `role-walk.mjs --env dev` | Signs in as each of the 8 roles and opens every item of that person's own menu (each section's side menu too). Fails on a refusal page, a blank page, a script error, a failed API call, a sign-in wall, junk text (`undefined`, `NaN`, `[object Object]`, `Invalid Date`) or a page wider than the window. Home must open; the operator console must be out of reach of every customer role (`/me`, the hand-off API on dev, the menu, its address); signed out, staff pages lead to sign-in; the AI employee's key works on its own tools (MCP `tools/list` and every read-only tool that needs no input) and is never a person's sign-in. | dev, browser on nivi | nightly 21:00 UTC (night.sh); by hand |
| `prod-monitor.py` | `role-walk.mjs --env prod --mode monitor`: the QA owner and seller open home and the main screens of production. Read only: every write is held in the browser. Red once: `ea-notify -l important`; red twice in a row for the same reason: `-l critical`; green again: `--resolve`. | production, browser on nivi (beside the build slots, nice 15) | every 15 min (`vitals-qa-monitor.timer`) |
| `journeys.mjs` | Three journeys, each person in their own session, in the QA company on dev: **chat** (owner writes, seller sees and answers), **call** (owner calls, it rings, seller answers; two real browser pages with fake microphones connect audio through the app's own signalling and ICE servers, once directly and once relay-only through TURN), **quote** (seller drafts and asks the owner; the owner's bell has it; the owner approves; the seller is told and gets the PDF; under a minute). | dev | nightly (night.sh) |
| `journeys.mjs` wl-* (`wl-flows.mjs`) | **Willow Lane's working day** (WL-FLOWS), in Willow Lane's order, as its people and AI employees call Pulse: **wl-lead** (bhrātā adds a customer for the seller: `create_quote_lead`; one per phone number; the seller finds it), **wl-quote** (bhrātā drafts from the seller's words in the seller's chat; at catalogue prices within ₹10 lakh it is approved by the company's rule and its PDF is in the chat; the seller opens it), **wl-approval** (over ₹10 lakh it waits; the owner's bell has it; the owner approves; the PDF reaches the seller's chat by itself), **wl-followup** (the seller marks it sent; the follow-up is the seller's; made due (dev), the minute tick gives a follow-up task and a notice; the seller records the answer), **wl-reminder** ("remind me about this" rings in the seller's bell), **wl-proforma** (Artha makes the proforma, the same one when asked again, cannot issue it; Finance issues it, numbered, PDF; the quotation's follow-up ends), **wl-task** (bhrātā gives the seller a task; the seller is told, finishes it; the reviewer accepts), **wl-checkin** (check in and out; a weekly off is refused with its reason). The AI employees are the QA copies of bhrātā and Artha (`ai-task-set.py --prepare wl-bhrata,wl-artha`: production's settings **and access**, a dev key, noted in `dev-agent-keys/copies.json`); their tools are called directly with their keys, as the runtime does after the model chose them: no tokens. The company is set up as Willow Lane works (auto-approve up to ₹10 lakh, a catalogue item, attendance on: `wl-dev.py fixture`). | dev, QA company | nightly (night.sh) |
| `wl-prod-check.py` | **Willow Lane on production, read only**: for each of those workflows, is it set up (the AI employees' access and tools, auto-approve and its limit, priced catalogue, approver, bank details on documents, follow-up ladder, reminders reaching the bell, attendance on and confirmed, an office site) and is it used (counts only, no names). One read-only transaction, rolled back. Gaps go to the ledger. | production | nightly (night.sh), by hand |
| `night-matrix.mjs` | Every screen the walk opened × the standard states (corners first: 360 dark 130 %, 360 light, 1280 light, 1280 dark; then 360/412 × light/dark × 100/130 %, 768, 1440), as the least-privileged role that has it, then a second role, until 01:00 UTC. Checks: QA-1's Readability Gate (`tests/e2e/readability-gate.mjs`, R1–R15 + axe) when the checkout has it, else the walk's own checks. | dev, browser on nivi (a shared builder slot) | nightly after the walk |
| `ai-task-set.py` + `ai-tasks/*.json` | 10 fixed tasks per AI employee (Willow Lane: bhrātā, Artha; EA: Artha, HR Assistant, Project Coordinator, Operations Chief, Client Care, Creative Strategist, Pulse Updates). The AI employee's settings are read from production (read only) and given to "<name> (QA copy)" in dev's QA company; a 7-day key on dev; its own one-shot runtime (`services/coworker/runner.mjs`, `PULSE_COWORKER_ONCE=1`, a private config; the shared dev runtime is untouched). Each task is sent by a synthetic person in their chat with the copy and judged by the tools the run called (`agent_run.tools_used`): `expect.tools`, `expect.notTools` (no payments recorded, nothing deleted or sent without asking), `expect.reply`. Each task is judged on the run(s) of its own message (`agent_event.subject_id`); messages the copy had not answered yet are answered before the first task (WL-AGENTS, 19 Nov 2026: before, a backlog of old messages, folded at 0 tokens, was taken for a task's run). | dev, QA company | one set a night in turn (`--rotate`, beside the matrix; about 170k to 240k tokens) |
| `qa-ledger.py` | One ledger for the matrix, walk, journeys and monitor, grouped by fingerprint; each morning appends the top 10 open items to `~/ea-research/flow/qa-ledger/ledger.md` (`top10-<date>.txt` too). An item absent two nights running on a covered route becomes "gone". | ea | 01:30 UTC (`vitals-qa-ledger.timer`) |

**Willow Lane (WL-FLOWS)**: the ledger also takes `wl-prod-check.py`'s gaps (route "(Willow Lane)"), and a journey or a Willow Lane
item that is clean two nights running turns "gone" like a page. After an AI employee's brief, tools or access change,
re-run its set by hand (`--set`, `--only` for the tasks concerned).

**The browser on nivi** (`nivi-browser.mjs`, `browser-server.mjs`): nivi refuses ssh port forwarding, so
`browser-server.mjs` (with playwright-core, copied to `/home/eadev/work/qa-runtime` on nivi) is started through
`builder-run` (a shared slot) or beside the slots (`slot: false`), and ea reaches it through `ssh nivi-builder nc`.
The script, the sign-ins and dev's network stay on ea: dev.vitalsos.ai is behind Cloudflare Access, so every dev
request the page makes is fetched by ea from its own dev server (127.0.0.1:3200). The server exits 10 s after ea's
connection goes, so a killed run never holds a slot. `QA_BROWSER=local` runs the browser on ea instead.

**Units** (`systemd/`, user units of eadev, run from strike): install with
`cp tools/qa/vitals/systemd/* ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now vitals-qa-monitor.timer vitals-qa-night.timer vitals-qa-ledger.timer`.
Output: `~/.local/state/vitals-qa/{monitor,night}/` (3 days of monitor runs, 14 nights).

**Dev's QA company**: made on pulse_dev with the same tool (`qa-org.py --dsn-env /etc/estate-autopilots/db/pulse_dev.env:MIGRATE_DATABASE_URL --credentials ~/.config/vitals-qa/dev.json --base-url https://dev.vitalsos.ai --apply`).

**Dev's long QA company** (QA-1D, research §4.4 R14 and §6 step 4: real-shaped worst cases), on dev only:
`qa-org.py --profile long --dsn-env /etc/estate-autopilots/db/pulse_dev.env:MIGRATE_DATABASE_URL --approver … --words … --apply`
makes `@vitalsqalong` ("Vitals QA लंबे नाम – Long-Name Stress Company (TEST)", test + rehearsal) with `qal.owner`,
`qal.admin`, `qal.saleshead`, `qal.seller`, `qal.finance`, `qal.hr`, `qal.client` and `qal.agent` (the same roles; names of
40 to 57 characters, one an unbroken 28-letter word, Hindi and Marathi among them), credentials in
`~/.config/vitals-qa/dev-long.json`. It refuses production's database and address. Then `node tools/qa/vitals/long-org.mjs`
fills it through the app's own API, as its people would: 48 more people with long names and titles, 24 clients (and
their contacts) with long English, Hindi and Marathi names, 12 long projects, 120 tasks (all four priorities, due from
ten days ago to forty days on, "100%" in some), and 18 quotations worth ₹100 to ₹700 crore, two in each of nine stages:
draft, awaiting approval, approved, sent, negotiating, accepted, declined, lost (to a competitor) and cancelled, with a
100% discount line among them. A run again adds only what is missing. Any walk or matrix takes it with
`--credentials ~/.config/vitals-qa/dev-long.json`. Fixture test: `node --test tools/qa/vitals/long-org.test.mjs`.

Tests: `python3 -m pytest -q tools/qa/vitals/test_vitals_qa.py` (the monitor's alert decisions, the ledger's merge).
