# Pulse product encyclopedia

Snapshot: **5 October 2026**. Twelve research modules contributed **{{RAW}} feature rows**. The integrated menu contains **{{COUNT}} distinct capabilities**, after merging **{{MERGED}} overlapping rows** into one implementation owner. This is a choice catalog, not a promise to build everything. A phase is a planning bucket; `active-scope` means part of the current MVP scope, not shipped or verified in production.

## Start here

Open [the offline browser](pulse-catalog.html) on a phone or laptop. Search a problem such as “missing footage”, then combine module, phase, persona, minimum value and effort filters. Open a feature for its summary, dependencies, variants and source references. Select useful items and export a shortlist. The page works without a connection and sends nothing. Its source is [MASTER-FEATURES.csv](MASTER-FEATURES.csv); all rows are embedded in the page, including conditional and excluded candidates with clear labels.

Read [PRIORITY-MENU.md](PRIORITY-MENU.md) for a small bundle, [WORKFLOWS.md](WORKFLOWS.md) for the 30 journeys that connect the modules, and [PHASES.md](PHASES.md) for gates and build order. Tell the Planner the bundle or feature IDs, the problem, the pilot pod/client and what should improve. The Planner resolves aliases, checks prerequisites and proposes a bounded delivery slice. A feature appearing here does not automatically create a backlog issue.

The full entries in each module contain acceptance criteria, privacy notes and research beyond the compact master row. Preserve those when making implementation issues. Historical IDs still work through [FEATURE-ALIASES.csv](FEATURE-ALIASES.csv); do not renumber the remaining IDs to close gaps.

## How the research was assembled

Each module run read Pulse v0.3 [vision](../spec/00-vision.md), [scope](../spec/09-product-scope.md), [domain model](../spec/02-domain-model.md), sensing, intelligence, architecture, privacy, apps and roadmap. They combined public vendor documentation and product comparisons, academic papers and case studies, standards and policy sources, and EA's own operating evidence. The module research files are the citation ledgers; feature `sources` may contain URLs, local evidence paths or citation keys resolved there. The integration preserves those source expressions with their originating IDs rather than pretending every citation is a public URL.

Public comparisons include Keka, Darwinbox, greytHR, Zoho People, BambooHR, Rippling, HiBob, Lattice and Culture Amp for HR; ActivityWatch, Hubstaff, ActivTrak, Insightful and similar sensing products; Linear, Asana, ClickUp, Teamwork and Productive for operations; Drive, Frame.io, Air and review tools for assets; Slack, Teams and WhatsApp vendors for communication. Research includes measurement validity, motivation and feedback, human-AI interaction, privacy, process mining, forecasting and causal inference. Vendor feature availability is evidence of a pattern, not proof that EA needs it or that an API entitlement exists.

Company evidence came from read-only `~/ea-research/` inventories, data-model and live-data reports, work-tracking notes, aggregate index queries by the module researchers, Kazuk's editor/designer briefs in `~/ea-context/kazuk-agents/`, and the SOPs in `~/ea-context/sop-docs/`. The integration itself read these reports and the live Paperclip roadmap; it did not re-open employee records or export the company database. Selected baseline evidence, dated **3 October** in DATA-INVENTORY: 74,585 visible Drive items, 584 engagement folders representing 525 projects, 3,685 finished assets, and 97,555 distinct buyers in the indexed lead-sheet sample. These are historical coverage figures, not today's complete universe. Shared role accounts and ambiguous upload credit explain why person identity, CID linkage, corrections and source coverage precede scores.

EST-55's owner direction and the live **“Pulse roadmap v0.4” plan document** were read on 5 October. That plan is newer than the repository's v0.3 date sequence: preserve the MVP, add the full app frame and People/leave in P1, and Mac/Drive/Meta/team and client chat in P2. Kazuk's order remains editors → designers → HR → projects → intelligence. See [the source task](https://paperclip.estateautopilots.com/EST/issues/EST-55) and [the phase reconciliation](PHASES.md).

This integration reviews overlaps, scope and interfaces; it is not a fresh audit of every research citation or legal assertion. Existing `(unconfirmed)` labels remain in source entries. WhatsApp messaging policy was checked against [Meta's current policy](https://business.whatsapp.com/policy) on 5 October: opt-in, opt-out and the 24-hour reply/template rule affect the client-chat slice. Direct access to the official Groups get-started page returned HTTP 429, so group eligibility and limits remain **unconfirmed by this integration** and must be proven before scheduling. Legal requirements and numerical research claims should be rechecked against their primary source when a selected feature is implemented.

## Integration rules and fields

One owner provides the domain API and behavior. Another module's identical UI or adapter description becomes an alias/related surface; similar vocabulary alone does not justify a merge. Attendance capture differs from payroll reconciliation; message approvals differ from asset approvals; employee payroll hand-off differs from leadership salary-cost visibility. Domain-specific variants remain separate when their state, audience or acceptance gate differs.

`persona` normalizes spelling and role synonyms into browser groups; `persona_notes` retains the source role expressions. `module` uses the directory slug everywhere; `related` lists other module slugs merged into that capability; `aliases` lists their old IDs. `source_refs`, `research_refs`, `sources` and `variant_details` retain provenance and non-owner requirements. The master uses the owner's value rating, the **largest effort band among its merged descriptions**, and an integrated phase. Original suggestions remain in `source_phases`. Dependencies use canonical feature IDs; original dependency language remains in `dependency_notes`. `core_services` is a best-effort normalization of named contracts, not a claim that every service is implemented. Symbolic contracts still need binding during issue preparation.

Effort points are **S=1, M=3, L=8, XL=13**; these are relative sizing units, not days. Sources used different sizing assumptions, so bands are a consistent comparison vocabulary, not a reliable total delivery estimate. Break down a chosen bundle and re-estimate it. Rankings below use **value / effort points**, then value, earlier phase and ID as deterministic ties. Dependency closure, feasibility and privacy gates can change the practical order. Excluded features do not appear in the top 50.

The `phase` column is reconciled to the live roadmap. Extra module-MVP candidates move to pilot or their domain phase; Finance and market intelligence do not become MVP because their local foundation is labelled MVP. Candidate phases are moved later when their canonical prerequisites require it. Explicit MVP substitutions use a minimal tenant-configuration contract for retention/contact settings, and defer My Week’s private draft-review facet; single-tenant widget links do not require later multi-organisation switching. Each substitution is recorded in integration.json and the row note. [INTEGRATION-REPORT.json](INTEGRATION-REPORT.json) records any remaining conflicts; the current build has none. Symbolic dependencies still need a service owner and acceptance gate when selected.

## Module index

“Source” counts the original module rows. “Owned” counts the de-duplicated master rows owned here. “Related” counts canonical rows owned elsewhere with this module as a related surface; it does not add to the total distinct feature count.

| Module | Source | Owned | Related | Read more |
|---|---:|---:|---:|---|
{{INDEX}}

## Top 50 by value / effort

Value is the module author's 1–5 assessment. A high score identifies a candidate for discussion; small setup controls can rank above a bigger end-to-end bundle because the rule measures individual rows.

| Rank | Canonical ID | Feature | Module | Value | Effort | Ratio | Phase |
|---:|---|---|---|---:|---|---:|---|
{{TOP50}}

## Counts, maintenance and reproducibility

[INTEGRATION-REPORT.json](INTEGRATION-REPORT.json) records per-file whitespace word counts, feature counts, phase counts, dependency conflicts and the master SHA-256. **Page equivalents = counted Markdown words / 500**, displayed with decimals; they are not printed pages. The count includes all 60 source Markdown files and the four integrated narrative documents, including table and Mermaid text. It excludes repeated CSV data, embedded HTML/JavaScript, builder code and the count receipt. The summary states total words and page equivalents so long research cannot be confused with feature count.

Rebuild with `python3 tools/catalog/build.py` from the repository. The curated ownership map and current-scope choices live in [integration.json](../../tools/catalog/integration.json); the page template and README source live beside it. `--html-output ~/ea-research/pulse-catalog.html` builds the owner delivery copy. The checked-in browser makes the delivered artifact reviewable; both copies must match. Add new source rows, review overlaps, update the plan/bundles and rebuild before publishing a new snapshot.
