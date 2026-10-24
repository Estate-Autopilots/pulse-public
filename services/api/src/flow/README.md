# Flow: the module (plugin) contract

Flow is one engine that can hold any company's work (owner, 21 Oct 2026). A **process** is a write-up (the SOP text,
by section) plus a definition: **steps** (modules placed with who, when due, a variant filter and the SOP section that
explains them), **wires** from one step's **Makes** to another step's **Needs**, stages, variant fields, alert rules and
a scorecard. A **run** is one client or project going through it. The engine follows Kazuk's rule, *data, not
permission*: a step opens when the data it needs exists, never because someone clicked "done" or "approved".
The API contract (endpoints, JSON shapes, examples) is `~/ea-research/flow/CONTRACT.md` and `../../openapi/flow.yaml`.

## Files
| File | What it is |
|---|---|
| `types.ts` | The shared shapes, pure (the web app imports it as is). |
| `registry.ts` | Every module's manifest (`MODULES`). `GET /api/v1/flow/modules` returns them; the UI hard-codes none. |
| `handlers.ts` | Module backends: `openStep` (makes the step's record), `outputsOf` (its Makes values when done), `runAction` (its actions). |
| `record-types.ts` | Built-in record types (Persona, Fact, Asset, Meeting, Review …): fields + a status machine; `assetId`. |
| `model.ts` | `normalizeFlow`, `problems` (in words, with converter fixes), `compile` (what the engine reads), old SOPs/workflows/boards as processes. |
| `store.ts`, `views.ts` | Reads (process library, run detail, My steps) and the words (due dates, "waiting for", Pip's line). |
| `intel.ts` | Builder intel (converters, people by load), scorecard, capacity. |
| `routes.ts` | `/v1/flow/*` (the browser's `/api/v1/flow/*`). |
| `templates/` | EA client project, Solar install, Blank. `seed.ts`: the dev seed. |
| `../ai/flow-assist.ts` | Pip inside a step (draft, critique, summarise, extract, check), behind the `FlowAssistant` interface. |
| `db/migrations/0800_flow_engine.sql` | The engine (PL/pgSQL): start, values on ports, readiness, Work tasks, verdicts, the clock, alerts, the tick. |

## A module = a manifest + handlers
```ts
type Port = { key: string; label: string; kind: Kind; required?: boolean; many?: boolean; recordType?: string };
type ModuleManifest = {
  key: string; version: number; name: string; icon: string;            // lucide icon name
  category: 'Start' | 'People' | 'Talk' | 'Write' | 'Media' | 'Field' | 'Money' | 'Review' | 'Flow' | 'Apps' | 'AI';
  summary: string;                                                     // one plain sentence
  needs: Port[]; makes: Port[];
  surface: 'task' | 'doc' | 'meeting' | 'media' | 'form' | 'money' | 'review' | 'board' | 'none';   // where the person works
  finish: 'person' | 'auto' | 'output' | 'verdict';                    // how its step ends
  settings: SettingField[];                                            // per-step settings the builder shows
  defaults: { role?; checklist?; qualityTest?; dueDays?; hours? };
  pip: ('draft' | 'critique' | 'summarise' | 'extract' | 'check' | 'suggest')[];
  engine: 'live' | 'partial' | 'stub'; status: string;                 // honest: how much is built, in words
  records?: string[]; converter?: boolean; legacy?: string[]; actions?: { key; label; help }[]; link?: string;
};
```
**Kinds** (what travels on a wire, the same for every industry): `contact`, `talk`, `doc`, `media`, `answers`, `money`,
`verdict`, `slot`, `list`, `any`. Industry words are port and step labels, never new kinds. A wire fits when the kinds
are equal or one end is `any`; a wire that does not fit is an error whose fix lists the **converters** (modules whose
needs and makes are different kinds: a Meeting turns a slot into a talk, Transcript to document a talk into a doc).

**Needs and readiness.** A Needs port that is **wired** gates its step. A port with `required: false` (by convention
the `context` ports, "Builds on") carries what the step builds on and never holds it up. A `many` port collects every
wire into it and waits for each source step that is part of the run. A need fed only by steps a variant skipped is not
waited on; a need fed only by a decision's way not chosen makes its step skipped. A need nobody wires can be typed in
(`step.inputs: [{ port, owner }]`): the step waits for it, "Waiting for … from the GS".

**How a step ends** (`finish`): `auto` steps finish when they open (Start, Notify, End …); `person` steps when the doer
says so (`POST /steps/:id/finish`, or by finishing the Work task); `output` steps when their record is final (the
module's action finishes them); `verdict` steps when answered (`POST /steps/:id/verdict`). Finishing puts a value on
every Makes port: the value given, else `{ recordType, recordId }` of the step's record, else `{ done: true }`, each
with who and when; then every wire carries it on and the steps waiting for it open.

**Handlers** (`handlers.ts`): `openStep(ctx)` makes the step's record the first time the step is opened (records are the
module backends: a meeting, a document, an asset, a review …); `outputsOf(ctx, given)` gives the typed values of its
Makes ports; `runAction(ctx, action, body)` runs `<module>.<action>`. `ctx` = `{ c (the transaction, as the viewer),
v (the viewer), step (its run step row), run (its run row), def (its FlowStep), flow (the run's definition) }`.
A handler never sends anything outside Pulse; it writes records and calls the engine (`flow_step_finish`,
`flow_step_move`, `flow_step_verdict`, `flow_input_put`, `flow_intake_set`).

## Adding a module
1. Add its manifest to `MODULES` in `registry.ts` (a unique `key`; ports of known kinds; `engine` and `status` say
   honestly what is built). If its work is a record, name the record type in `records` (add the type to
   `record-types.ts` when none fits: fields + statuses with their `next`).
2. If it has actions, add `case '<key>.<action>'` in `runAction` and list them in `actions` (the label and the body in
   words). Use `openStep` for its record, `updateRecord` for changes (each change keeps a version), `finish`/`move`/
   `verdict` for the step.
3. If Pip can help in it, list the actions in `pip`; the assistant reads the step's SOP section and the run's records.
4. Add a check to `test/flow-model.test.mjs` (pure) or `test/flow-runner.mjs` (through the API on a database).
A third-party app plugs in through the `webhook` module today (a stub: nothing is sent until the Apps page connects
apps); the manifest shape above is what an app module will declare.

## Rules every module keeps
- Data, not permission: never make a step wait on an approval unless a later step explicitly Needs its verdict.
- Inform and tag, not gates: a wire's `notify` roles hear that a value landed (inside Pulse only).
- AI suggests, the person decides: Pip's results are suggestions with what they rest on (`basis`); nothing is saved or
  sent until the person keeps it.
- No sends to people outside Pulse from a module (WhatsApp, e-mail, Telegram): the message is written for the person to post.

## Primitives and company blocks (FLOW-D)
The builder's palette is about a dozen primitives, nothing industry-specific (`blocks.ts` `PRIMITIVES`): Start, Task,
Collect, Meet, Write, Review, Decide, Wait, Message, AI (Pip), App action, Repeat, End. Each asks one plain question
and has a few **kinds**; a kind names the module above that does the work (Collect → "Photos on the spot" →
`site_visit`). A step keeps both: `block` (what the person chose) and `module` (the backend), so the engine, records,
Pip and alerts are unchanged.
- **Order, not wires.** A step with a block waits on one port, `in` ("Starts after"): the steps before it in the list.
  Its module's own needs become what it *uses*; they never hold it up. When a process goes live, `withData()` adds the
  data wires (the nearest earlier step making that kind, and the step's `uses`), so values still reach the step.
  `problems()` says in words when something used has no maker before it, with the primitive that would make it.
- **Skipped steps pass through** (0810): a step skipped for this run (a variant) passes on what the steps before it say,
  so the step after it still waits; every step on a Decide's way not chosen is skipped.
- **Decide** with `settings.rule` (`{ field, op, value }`) decides by itself from the run's fields or an earlier step's
  answers (case-insensitive); without one, a person chooses. Its two ways are named by `settings.yes` / `settings.no`.
- **Message** in Pulse (`notify`) fills `{run}`, `{client}`, `{project}`, `{today}` and each field (by key or label);
  `message` is a WhatsApp or e-mail text the person copies and marks sent (`actions/text`, `actions/sent`).
- **Wait** for hours or days (`hours`), until a date field (`until: 'field'`, the tick), or until something arrives
  (`until: 'input'`, the person marks it arrived: `actions/arrived`).
- **Start** by hand, on a new lead (`lead_capture`, a trigger on `pulse.lead`), when a form is sent (`trigger: 'form'`,
  `formId`), on a schedule (`trigger: 'schedule'`, `every`, `day`, `at`; the tick), or by a hand-off.
- **Company blocks** (`pulse.flow_block`, `company-blocks.ts`): named presets of a primitive (title, kind, settings,
  checklist, quality test, who, due, write-up part). `GET/POST /v1/flow/blocks`, `POST /v1/flow/blocks/:id`
  (`{ archive: true }` removes one). A template brings its own (`Template.blocks`); EA's and the installer's live in
  their template files, never in the primitives.
- **Describe it**: `POST /v1/flow/describe { text, title }` drafts primitives, roles and due days from someone's words
  (`describe.ts`, grounded rules; Pulse has no language model).
- **Try it**: a run in mode `try` runs the draft (no Work task, nobody told; who would have heard is kept as notices),
  `POST /v1/flow/runs/:id/later { days }` moves its clock, `POST /v1/flow/runs/:id/discard` throws it away.
- **A Collect form finishes its step**: a field form sent with `flowStepId` finishes that step with its answers, place
  and photo count.

Adding a primitive kind: add it to `PRIMITIVES` with the module that does it (and its settings that tell it apart),
then teach the side sheet (`apps/web/app/processes/builder/sheet.tsx` `KindQuestions`) the questions it asks.
