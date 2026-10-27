# Direct Drive changes feed (R44)

`pulse-drive-changes` reads Google Drive's changes feed for **approved roots only**: a shared drive, or a folder and
everything below it. It is off unless `PULSE_DRIVE_CHANGES=1`, and a root is read only after an organisation admin
records the owner's approval (errand E13). It never runs or replaces the old production bootstrap, never reads file
contents, and asks Google for the metadata-only scope `drive.metadata.readonly`.

## What one run does

- **Cursor.** A new root starts at Google's current start page token: history before approval is not replayed (a
  backfill is a separate reviewed operation). The page token lives in `pulse.collector_cursor`, which the API role
  cannot read; it never appears in output or logs.
- **One page, one transaction.** For each change Pulse computes a key from the root, file, change time and metadata
  hash, writes the change journal (`pulse.drive_change`), the registered `drive.file.*` / `drive.folder.created`
  event (deterministic id, `/collectors/gdrive_changes/1/<root>`), the file's accepted state
  (`pulse.drive_source_file`) and the next page token together. A crash before the commit refetches the page; a
  replayed page or an overlapping change finds its key and adds nothing.
- **Scope.** A file counts when its folders lead to the root (folders are looked up in the accepted state, then once
  per run with `files.get`). Files elsewhere, and anything under the EA Team Member Details, salary or finance paths
  (the snapshot collector's rule), are dropped and counted, not stored.
- **Tombstones.** A deleted or unshared file (`removed`), or one moved out of the root, keeps its last accepted name,
  folder and checksum; only `availability` changes (`removed`, `out_of_scope`; Drive's bin is `trashed`). Accepted
  events stay. The worker role has no delete grant on these tables.
- **Bounded polling.** At most `--max-pages` (20) pages of `--page-size` (500) per root per run; a caught-up root is
  read again after `PULSE_DRIVE_CHANGES_POLL` seconds (300, at least 60). The loop checks every 30 seconds for roots
  that are due, woken by a channel, or past their back-off.
- **Push channels.** With `PULSE_DRIVE_CHANGES_HOOK_URL` (https) set, each healthy root keeps one `changes.watch`
  channel (3 days, renewed 6 hours before expiry; the old one is then stopped). Only the channel token's SHA-256 is
  stored. A notification only sets `wake_at`; a missed one is caught by the next scheduled poll. If Google refuses a
  watch, the root shows channel "failed", polling carries on, and the loop tries again after an hour.
- **Failures.** Rate limits back off exponentially (honouring `Retry-After`, at most an hour) from the last committed
  page. Lost access to a root (403/404, a removed shared drive, an unreadable credential) marks it `access_lost` and
  is retried hourly; its files are not touched. A cursor Google refuses marks the root `cursor_invalid` and stops it
  until `recover` (below). Output is counts and codes only.

Google's feed reports the current state of changed files, not every intermediate edit; Pulse promises only the
changes Google reports, and discloses gaps it knows about.

## Operate

Credentials are service-account key files named `<credential-ref>.json` in `PULSE_DRIVE_CHANGES_CREDENTIALS_DIR`,
readable by the service user only (a group- or world-readable file is refused). A shared drive can add the service
account itself as a viewer (no delegation); a folder in someone's Drive needs `--subject` and a Workspace admin's
domain-wide delegation of the metadata scope.

```bash
pulse-drive-changes add --kind shared_drive --drive-id <ID> --label "Deliverables" --credential-ref ea-collector
pulse-drive-changes approve --source <SOURCE> --approved-by <ADMIN_PERSON> --approval-ref "E13 …"
PULSE_DRIVE_CHANGES=1 pulse-drive-changes run --loop
pulse-drive-changes status
pulse-drive-changes disable --source <SOURCE>
pulse-drive-changes recover --source <SOURCE> --reviewed-by <ADMIN_PERSON> --note "…"
```

`recover` starts the root again at Google's current position and records the window that may have been missed in
`pulse.drive_change_gap` (from the last committed checkpoint, with the old cursor's hash and the reviewer), open until a
reviewed rescan closes it. It resets and deletes nothing. Admins see each root's health in Settings → Connected sources
("Google Drive changes").

## Tests

Unit: `uv run --directory collectors/gdrive_changes pytest -q`. Database and API acceptance on a synthetic Drive:
`tests/core/test_drive_changes.py` (crash before/after commit, page replay, rate limit, missed webhook, channel expiry
and renewal, refused cursor, tombstones, selected and shared roots, two tenants). These are mock evidence: no real
Google Drive, channel or credential is involved.
