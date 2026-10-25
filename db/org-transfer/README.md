# Organisation transfer manifest

`tools/org-transfer manifest [--check]` runs the shared `pulse_sdk.org_transfer` module through uv.
Set `PULSE_DATABASE_URL_MIGRATE` (or the existing migration environment); tests can use
`PULSE_CI_DATABASE_URL`. The CLI reads **catalogue metadata only**, in a read-only connection with
a 60-second statement timeout. It never reads source rows or changes database data.

The sorted JSONL includes the isolation suite's exact tenant-table query plus `pulse.org`.
Refresh preserves all authored fields, classifications and stale entries; new tables start
`unclassified` with no JSONB declarations. Classifying a table never silently marks its JSONB
columns ID-free: declare each column explicitly. `--check` writes nothing and lists every
classification, stale-entry, missing-column, duplicate, skip-reason and FK-closure problem
before failing. `catalogue()` returns the table/JSONB map and `pg_constraint` FK edges together:
Within tenant tables, copy rows may reference only copy rows; rebuild rows may reference copy or rebuild rows.
Nullable and non-deferrable edges are checked too. The manifest path uses `repo_root()`
and supports `PULSE_REPO_ROOT` in non-editable installations.

Three reviewed global FK parents remain outside tenant transfer: `privacy.purpose` and
`privacy.retention_class` are destination registry seeds resolved by `code`;
`pulse_priv.pulse_account` requires the target account-link mapping. `SHARED_FK_PARENTS`
records these dependencies; the catalogue retains their FK edges for export/import preflight.
Import must fail on an unresolved reference and must never copy global sign-in credentials.
Unknown global parents fail the check; a listed parent becoming tenant-scoped must be classified.

- `copy`: canonical facts/history, including canonical rows with deterministic UUID5 IDs.
  `person` (talent), `client`/`project` (Ops Hub), `lead`/`buyer` (research) and `raw_capture`
  retain their source facts. `asset`, `version`, `file`, `ad`, `ad_set` and `campaign` also stay
  copy: copied history references them, indexed deliveries write them, and replay may reject
  source CIDs after an organisation-code collision. Copied UUID5 identities must be remapped
  by recomputing `entity_id(target_org, key)` so future events address the same records.
- `rebuild`: only `ad_metric_day`, `attribution` and `folder`; no copied row points at them.
  Replay under the target organisation. `task` is copy: authored fields and directly written records
  survive transfer, matching the projector's preservation of imported/edited tasks.
  This file does not implement replay.
- `skip`: ephemeral sessions, credentials, enrollment capabilities and caches, with a reason
  on every entry. Durable acceptance/invitation histories stay `copy`; their bearer capabilities
  must be invalidated/reissued by the importer. Mixed configuration/credential rows likewise
  require rekey/rotation. Classification never authorizes retaining source credentials live.
  Device and service-key parent rows remain `copy` to retain consent, activity and update
  history FKs. The importer must set `revoked_at`, clear keys/tokens (use constraint-valid
  inert values for NOT NULL keys), and require fresh device enrollment/target credentials.

Every `copy`/`rebuild` JSONB column has a list of ID-bearing paths or `[]` for no known ID leaves.
Paths include the column: `payload.person_id`, `payload.items[].asset_id`, `items[]`.
`[]` within a path means every array element (including nested arrays); `*` means one object
key in a documented map, e.g. `people.*`. There is no recursive wildcard.

`tests/core/test_org_transfer_manifest.py` builds the isolation suite's synthetic world/extras,
walks JSON values under existing tenant RLS, and rejects undeclared UUID-shaped string leaves.
Its negative transaction rolls back a new tenant table and an unexpected nested UUID path,
then checks a new path on an existing table. Diagnostics contain table/path names, not values.
Synthetic coverage is bounded by exercised shapes; new shapes require fixtures and reviewed
paths. UUID columns without FKs and identifiers in text columns belong to the import work.

This is a manual metadata command, not a poller. Run once per schema change; tests run through
`ea-heavy`, at most two workers. Source originals and privacy/participant access remain unchanged.

## Sealed columns and credentials

`sealed` maps ciphertext columns to `context_kind`, the exact original AAD `context` template,
`key_id`, `data_key` and `encoding`. Column layouts store binary envelopes directly; sales OAuth
uses base64 JSON `{k,w,d}` (key ID, wrapped key, ciphertext). Budget `month:YYYY-MM` takes the
first seven date characters; empty pod stays empty. Preserve original IDs/context until opened;
only document data may be explicitly re-sealed under the target IDs/keyring. Legacy pgcrypto
documents/bank rows without a key ID are unsupported: fail preflight, never silently reinterpret.
`credentials` decisions apply even to `copy` tables: `export:false` excludes the column entirely.
`on_import:revoke` invalidates the capability; `rotate` requires fresh target credentials/reconnection
before activation. Omitted NOT NULL/PK credentials need constraint-valid inert replacements;
disable/revoke their owning rows. Never reuse or silently re-seal credentials. This is an export/import
contract; the future exporter/importer must implement it. The metadata CI guard checks known envelope
layouts, token/password hashes, signing secrets and every declared key/credential column.

`pulse_sdk.document_keys.open(ring, key_id, wrapped, ciphertext, original_context)` returns bytes.
`load_keyring()` reads `PULSE_DOCUMENT_KEY_FILE`: a path, `file:path`, or `env:NAME` with keyring text;
files must have no world access. `python -m pulse_sdk.document_keys` prints SHA-256 fingerprints only.
Regenerate synthetic vectors with `ea-heavy node --experimental-transform-types tools/generate-document-key-vector.mjs`;
run `ea-heavy uv run --directory packages/sdk-py --locked pytest -q tests/test_document_keys.py`.

## Signed encrypted stream (export building block)

`pulse_sdk.transfer_archive.write_archive(path, recipient, signing_key, chunks, required_bytes=...)`
accepts bounded byte blocks. The snapshot exporter supplies the conservative output estimate and the
inner stream containing organisation metadata, table JSONL and blobs. This module alone is not the export CLI.
`open_archive(path, identity, signer)` is a context manager yielding decrypted byte blocks after verifying
the complete ciphertext with the pinned source public key. Consume it fully inside the context.
Key objects use `cryptography`; `load_key(file_or_env_reference, "x25519"|"ed25519", private=False)`
accepts PEM or base64 32-byte keys from a file (optionally `file:`) or `env:NAME`. Never pass inline secrets.

Envelope v1: `PULSEOT1\n`, big-endian u32 header length (max 16 KiB), JSON cryptographic header,
frames, then a 64-byte Ed25519 signature. No organisation, table or document metadata belongs in the
outer header. Frames are u8 final flag + u32 ciphertext length + ciphertext/tag, with 1 MiB plaintext
per non-final frame and a final frame (possibly empty). Fresh ephemeral X25519 ECDH feeds HKDF-SHA256
(random 32-byte salt, info `pulse.org-transfer.v1/kdf\0`), deriving an AES-256-GCM key. The 12-byte nonce
is a random 7-byte prefix + u32 counter + u8 final flag; counter exhaustion fails. AAD is
`pulse.org-transfer.v1/aad\0` + complete encoded header + counter/final flag. Ed25519 signs
`pulse.org-transfer.v1/sig\0` + encoded header + SHA-256 of
all framed ciphertext. Reordered, missing or truncated frames, trailing bytes and wrong keys fail closed.
The writer creates a new mode-600 file, refuses existing paths and `/tmp` (including symlinked paths),
checks free space plus a 2 MiB reserve, and removes a partial encrypted output on failure. It never
spools plaintext. Manual invocation only; memory is bounded by the supplied block and chunk size.
The reader's second pass re-reads disk; each frame remains authenticated against the verified
in-memory header. Import readers must retain the AAD binding. Focused tests must run as
`TMPDIR=/var/tmp /usr/local/bin/ea-heavy uv run --directory packages/sdk-py --locked pytest -q tests/test_transfer_archive.py`.
