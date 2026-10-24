# Drive metadata snapshot backfill

`pulse-drive-backfill` imports eligible file and folder rows from EA's read-only `drive_file` index into Pulse using
the Event Core's registered `drive.file.observed` envelope. It reads `drive_file` only; folder rows resolve paths and
are emitted so the work graph can reconstruct folder ancestry. It never queries `drive_text` or fetches file contents.
It skips the “EA Team Member Details” tree, salary and finance paths, and trashed rows.

The recurring `pulse-ea-bootstrap` refresh seeds verified account identities, the active `folder_rules` tenant
config, and the roster from the Ops Hub list, Workspace groups, and Workspace directory metadata. It does not read
`drive_text`; existing HR-derived records are preserved. The active rules include ordered project-path patterns
and pod mappings, sourced from `config/ea-team.json` until the EA tenant pack is installed. Its design taxonomy is
kept in `config/ea-design-type-rules.json` as generic folder patterns only; it does not store project, file, or
person names. Unmatched and ambiguous folder labels remain `other`.

## Account identity seeding

Workspace accounts are classified as shared only after an exact active Workspace directory match and a configured
`shared_local_parts` match. That local-part rule does not classify outside uploader handles. Other indexed accounts are
shared only when their exact normalized full handle appears in `shared_external_accounts` or the protected account-map
file; local-part-only account-map entries are rejected. The protected `PULSE_EA_SHARED_EXTERNAL_ACCOUNTS` environment
variable can override the checked-in full-handle list. Unknown uploader handles remain unverified. Personal handles
and person mappings stay in the protected account map; fixtures use synthetic handles.

The index does not retain a Drive content checksum. The collector computes a SHA-256 over normalized metadata and
stores the latest `source_ref` for each file in `pulse.drive_backfill_emission`. Re-listing an unchanged row after the
indexer refreshes `indexed_at` is skipped before an event insert. A changed row emits one event; its deterministic id
and event time use the same observation timestamp. The `(indexed_at, id)` cursor and each batch of at most 1,000 rows
commit with their events and revision keys, so an interrupted run resumes after its last committed row. Existing
id-only cursors get one compatibility scan using the old snapshot's event-time anchor; that lets unchanged events
deduplicate while the scan seeds revision keys. Successful command runs also write a count-only `pulse.sync_run` row
for the staging freshness status.

## Staging

Use the approved staging runtime environment at `/etc/estate-autopilots/apps/pulse.staging.env` to provide
`EA_INDEX_DATABASE_URL` (read-only index role), `PULSE_DATABASE_URL_WORKER` (Pulse worker role), and
`PULSE_DRIVE_BACKFILL_ENABLED=1`. Confirm the connection key is configured without printing its value. Do not put a
connection string on the command line or in logs.
`--org-id` defaults to the EA tenant and can be overridden with `PULSE_ORG_ID`:

```bash
uv run --directory collectors/gdrive_snapshot pulse-drive-backfill --org-id <EA_ORG_UUID>
```

The default batch size is 500; `--batch-size` accepts 1–1000. Standard output contains counts only. The command exits
nonzero on an invalid event or a database failure and leaves the last committed cursor available for resume.

### Run and stop the recurring worker

Run it in the foreground every 30 minutes (the default) with:

```bash
uv run --directory collectors/gdrive_snapshot pulse-drive-backfill --loop
```

Stop a foreground run with Ctrl+C or SIGTERM. In the server container, set
The server container starts this worker only when `PULSE_DRIVE_BACKFILL_ENABLED=1` and
`EA_INDEX_DATABASE_URL` is configured. Set `PULSE_DRIVE_BACKFILL_INTERVAL` to change the interval in seconds; invalid
values use the 30-minute default and values below 60 are clamped to 60. A failed or exited backfill process does not
stop the web or API services. To stop the server worker, set `PULSE_DRIVE_BACKFILL_ENABLED=0` and restart the staging
app; container shutdown sends SIGTERM and the worker exits cleanly. It records successful checks in `pulse.sync_run`,
including when no files changed, so the staging “Last data” status reflects the latest completed poll. Projections
consume emitted events through the existing worker notification path.

Check source read access, worker role permissions, and Pulse event partitions if a run exits nonzero.

## Synthetic tests

```bash
uv run --directory collectors/gdrive_snapshot pytest -q
```
