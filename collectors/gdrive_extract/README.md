# Useful text from approved Drive roots (R45)

`pulse-drive-extract` keeps the readable text and simple facts (tables, headings, page counts) of a small set of
document types from Drive roots the owner approved, as versioned compressed payloads in the database, so captured
data outlives the raw Drive copy. It is off unless `PULSE_DRIVE_EXTRACT=1`, and a root is read only when:

- the root is an R44 root (`pulse.drive_source`) that is tracked and approved, and
- an organisation admin recorded a separate **content approval** for it (`pulse.drive_extract_policy`, owner errands
  E08/E13): which formats, which Pulse roles may read the text (the audience), the size limit and a retention
  proposal for legal review.

Files come only from the R44 feed's accepted state (`pulse.drive_source_file`): nothing here lists or searches a
Drive, so there is no unrestricted scan. Reading content needs the read-only Drive scope
(`https://www.googleapis.com/auth/drive.readonly`), broader than R44's metadata scope, so the content approval names it.

## Formats

| Format key | Drive type | Read as | Known gap |
| --- | --- | --- | --- |
| `text` | `text/plain`, `text/markdown` | strict UTF-8/UTF-16 text | other encodings are labelled `unknown_encoding`, not guessed |
| `csv` | `text/csv` | text + table | — |
| `pdf` | `application/pdf` | text per page (pypdf, layout mode) + page counts | scans have no text layer: `no_text_layer` (no OCR) |
| `docx` | Word `.docx` | body paragraphs, headings and tables | headers, footers, comments and notes are not captured |
| `gdoc` | Google Docs | exported as `.docx` | as `docx` |
| `gsheet` | Google Sheets | exported as CSV | Drive exports the **first sheet only** (`first_sheet_only`) |
| `gslides` | Google Slides | exported as plain text | slide text only (`slide_text_only`) |

Everything else is labelled `unsupported` (`needs_ocr` for images, `media`, `format_not_supported`,
`format_not_approved`), never parsed.

## What one file goes through

1. **Before any byte is fetched:** the file's name and folders are checked. Chats and WhatsApp exports
   (`chat_source`), government ID material (Aadhaar, PAN, passport, voter ID, driving licence, KYC: `government_id`) and
   the snapshot collector's sensitive paths (EA Team Member Details, salary, finance: `sensitive_path`) are
   **excluded** and never fetched. Macro-enabled types are quarantined (`macro`), a declared size over the limit is
   quarantined (`oversized`), other types are labelled unsupported.
2. **Fetch, bounded:** at most the approved size (Google exports at most 10 MB); a larger body is quarantined
   (`oversized`), a file Drive flags as abusive is quarantined (`flagged_by_drive`), a file the reader cannot open is
   `failed / access_lost`. A rate limit or outage stops the root's run without recording anything.
3. **Extract in a sandbox:** a separate `python -I` process with an empty environment (no database URL or credential),
   limits on CPU, memory, file writes, open files and child processes, and a wall-clock timeout; inside
   [bubblewrap](https://github.com/containers/bubblewrap) with no network and only the interpreter and its packages
   visible where the host allows it (`sandbox` = `bwrap`, else `rlimit`; `PULSE_DRIVE_EXTRACT_SANDBOX=bwrap` requires
   it). Encrypted PDFs and Word files, wrong file types, entity tricks in XML, zip bombs, macros and corrupt files are
   **quarantined**; a timeout or crash is quarantined too (`extractor_timeout`, `extractor_crash`). Nothing is OCRed.
4. **Screen the text:** valid Aadhaar numbers (with their check digit) and PAN numbers (`government_id_content`) and
   chat-export lines (`chat_content`) drop the text; only the label is kept.
5. **Store in one transaction** after rechecking that the approval is still in force, the format still approved, and
   the file still in the root at the same version. The text and the facts (canonical JSON) are zlib payloads in
   `pulse_priv.drive_payload`, addressed by the SHA-256 of their uncompressed bytes (identical content is stored once
   per organisation), with schema (`pulse.drive.text/1`, `pulse.drive.facts/1`), codec and both lengths; each is
   decompressed and compared before it is written. `pulse.drive_extract` records the outcome and its provenance: name,
   type and version at capture (`md5:…`, or `modified:…` for Google files), export format, size and SHA-256 of the
   bytes read, extractor version, sandbox, time and known gaps. The bytes themselves are **not kept**: there is no raw
   binary archive.

A new content version (new checksum, or a newer Google modification time) is a new capture; renaming or moving a file
inside the root is not. Captures and payloads are append-only for the worker; nothing deletes them.

## Reading captured text

`pulse.drive_text(root, file)` (API: `GET /api/v0/drive-text/:source/:file`) decides each read: the content approval
must be in force and the viewer must hold one of its audience roles now (otherwise: nothing, 404). It is **held**
(state and reason only) when the root lost access or is no longer tracked, the file moved out of the root, or the
file disappeared from Drive (deleted or unshared: Drive reports both the same way) until an admin reviews it with
`keep-readable`. A file in Drive's bin stays readable with the gap `raw_in_bin`; a reviewed disappearance with
`raw_unavailable`; a newer version not yet captured with `newer_version_not_captured`. The API decompresses the
payloads, stops at the recorded length and checks the hash: a damaged payload answers `state: corrupt`, never text.

## Commands

```sh
pulse-drive-extract selftest                    # synthetic documents through this host's sandbox; no DB, no Drive
pulse-drive-extract approve --source <root> --approved-by <admin person id> --approval-ref "<E08/E13 record>" \
    --formats docx,pdf,gdoc --audience admin,leadership [--max-megabytes 10] [--retention-note "<proposal>"]
pulse-drive-extract run [--loop] [--files 25] [--megabytes 100]   # needs PULSE_DRIVE_EXTRACT=1
pulse-drive-extract status                      # approvals, outcome counts, held files (counts and codes only)
pulse-drive-extract verify                      # decode every payload; exit 1 if any is damaged
pulse-drive-extract keep-readable --source <root> --file <id> --reviewed-by <admin> --note "<why>"
pulse-drive-extract withdraw --source <root> --withdrawn-by <admin>   # stops runs and reads; keeps captures
```

`approve` again with different terms narrows or widens the audience or formats; reads follow the new terms at once.
Output never contains file names, captured text, accounts, credentials or tokens.

## Tests

`tests/` (no database: payload codec, sandboxed extractors on synthetic documents, exclusions, screening, limits) and
`tests/core/test_drive_extract.py` (PostgreSQL: approval gates, Unicode/tables/exports round trip, hostile files,
chats and IDs, duplicates, corruption, source loss and access changes, an isolated `pg_dump`/`pg_restore` read with no
Drive, and the API through `services/api/test/drive-text-runner.mjs`). Every Drive in them is synthetic.
