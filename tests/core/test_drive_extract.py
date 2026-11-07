"""R45 (migration 0280): useful text and lossless compressed facts from approved Drive roots, against a synthetic Drive.

Only files the R44 feed accepted under a root with a content approval in force are read. Unicode, tables and Google
export shapes are captured and decompress byte for byte; encrypted, oversized, hostile and unsupported files are
labelled, never parsed; chats, WhatsApp exports and government ID material never enter extraction; identical content
is stored once; a damaged payload is reported, not returned; captured text survives the loss of the raw file while a
deletion, a move out of the root, lost access, a narrower audience, a removed role or a withdrawn approval each stop
reads at once; and an isolated restore reads every capture with no Drive at all.
Every Drive here is a stand-in (FakeDrive from the R44 test): this is mock evidence, not a Google receipt."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from test_drive_changes import FakeDrive, folder_root, make_admin, q

from pulse_gdrive_changes import feed
from pulse_gdrive_extract import payload, synthetic
from pulse_gdrive_extract import worker as xw
from pulse_gdrive_extract.content import TooLarge
from pulse_gdrive_extract.extract import DOCX

GDOC, GSHEET, GSLIDES = (f"application/vnd.google-apps.{k}" for k in ("document", "spreadsheet", "presentation"))
ALL = ["text", "csv", "pdf", "docx", "gdoc", "gsheet", "gslides"]
MB = 1024 * 1024


class ContentDrive(FakeDrive):
    """The R44 synthetic changes feed plus file bytes: downloads and Google exports, each one recorded."""

    def __init__(self):
        super().__init__()
        self.content: dict[str, bytes] = {}
        self.fetched: list[tuple[str, str | None]] = []
        self.lie_size: set[str] = set()

    def put_doc(self, file_id, name, parents, data, *, mime, google=False):
        self.content[file_id] = data
        file = {"id": file_id, "name": name, "mimeType": mime, "parents": list(parents), "trashed": False,
                "modifiedTime": self.tick()}
        if not google:
            file["md5Checksum"] = hashlib.md5(data).hexdigest()
            file["size"] = "10" if file_id in self.lie_size else str(len(data))
        self.files[file_id] = file
        self.log.append({"changeType": "file", "time": self.tick(), "removed": False, "fileId": file_id,
                         "file": dict(file)})

    def rename(self, file_id, name):
        file = dict(self.files[file_id], name=name)
        self.files[file_id] = file
        self.log.append({"changeType": "file", "time": self.tick(), "removed": False, "fileId": file_id, "file": file})

    def trash(self, file_id):
        file = dict(self.files[file_id], trashed=True)
        self.files[file_id] = file
        self.log.append({"changeType": "file", "time": self.tick(), "removed": False, "fileId": file_id, "file": file})

    def _bytes(self, file_id, max_bytes, mime=None):
        self.fetched.append((file_id, mime))
        data = self.content[file_id]
        if len(data) > max_bytes:
            raise TooLarge()
        return data

    def download(self, file_id, max_bytes):
        return self._bytes(file_id, max_bytes)

    def export(self, file_id, mime, max_bytes):
        return self._bytes(file_id, max_bytes, mime)


@pytest.fixture
def world(worker, owner, api):
    w = build_world(worker, owner, api)
    make_admin(worker, w)
    return w


def tracked(worker, w, drive):
    """An approved, tracked R44 root at Google's current position."""
    source = folder_root(worker, w, drive)
    feed.poll_source(worker, drive, w.org, source)
    return source


def accept(worker, w, drive, source):
    assert feed.poll_source(worker, drive, w.org, source).status == "ok"


def approve(conn, w, source, *, audience=("admin",), formats=ALL, max_bytes=MB):
    xw.approve(conn, w.org, source, approved_by=w.manager, approval_ref="E08/E13 synthetic approval",
               formats=list(formats), audience=list(audience), max_bytes=max_bytes,
               retention_note="proposal: keep while the root is approved; legal review pending")


def run(conn, w, drive, source, **limits):
    return xw.run_source(conn, drive, w.org, source, limits=xw.Limits(**limits))


def captures(conn, w, source):
    return {r["file_id"]: r for r in q(conn, w.org, """select * from pulse.drive_extract where source_id=%s
                                                              order by extracted_at, id""", (source,))}


def payload_count(conn, w):
    return q(conn, w.org, "select count(*) n from pulse_priv.drive_payload")[0]["n"]


def read(api, w, viewer, source, file_id):
    """pulse.drive_text as the API role and one viewer, with the payloads decoded and checked like the API does."""
    rows = q(api, w.org, "select * from pulse.drive_text(%s, %s)", (source, file_id), viewer=viewer)
    if not rows:
        return None
    meta = rows[0]["meta"]
    if meta["state"] == "readable":
        t, f = meta["text"], meta["facts"]
        meta["body"] = payload.decode(t["codec"], rows[0]["text_data"], t["sha256"], t["rawLength"]).decode()
        meta["factsBody"] = json.loads(payload.decode(f["codec"], rows[0]["facts_data"], f["sha256"], f["rawLength"]))
    return meta


def test_nothing_is_read_without_a_content_approval_in_force(worker, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    drive.put_doc("doc", "Brief.docx", ["root-folder"], synthetic.docx(), mime=DOCX)
    accept(worker, w, drive, source)
    assert run_all(worker, w, drive) == []            # R44 approval alone: no content is read
    assert run(worker, w, drive, source).status == "not_approved" and drive.fetched == []
    with pytest.raises(PermissionError):
        xw.approve(worker, w.org, source, approved_by=w.editor, approval_ref="E08/E13 synthetic approval",
                       formats=ALL, audience=["admin"])
    with pytest.raises(psycopg.errors.CheckViolation):                # enabling needs a recorded approval
        q(worker, w.org, """insert into pulse.drive_extract_policy(org_id,source_id,formats,audience,enabled)
                            values(%s,%s,'{docx}','{admin}',true)""", (w.org, source))
    approve(worker, w, source)
    assert [r.extracted for r in run_all(worker, w, drive)] == [1]
    drive.put_doc("doc2", "Second.docx", ["root-folder"], synthetic.docx(["two"]), mime=DOCX)
    accept(worker, w, drive, source)
    xw.withdraw(worker, w.org, source, withdrawn_by=w.manager)
    assert run(worker, w, drive, source).status == "not_approved"
    assert [f for f, _ in drive.fetched] == ["doc"]
    approve(worker, w, source)
    feed.disable_source(worker, w.org, source)                        # the R44 root is no longer tracked
    assert run(worker, w, drive, source).status == "not_approved"
    assert [f for f, _ in drive.fetched] == ["doc"]
    assert set(captures(worker, w, source)) == {"doc"}               # the withdrawn period's capture stays


def run_all(conn, w, drive):
    return xw.run_once(conn, w.org, lambda policy: drive)


def test_unicode_tables_and_google_exports_round_trip_exactly(worker, api, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    docs = {
        "docx": ("Site visit.docx", synthetic.docx(table=synthetic.TABLE), DOCX, False),
        "pdf": ("Shoot plan.pdf", synthetic.pdf(), "application/pdf", False),
        "md": ("Notes.md", "# नोट्स\n- 東京 ✓\n".encode(), "text/markdown", False),
        "gdoc": ("Brief", synthetic.docx(["Google Doc export — ठीक है"], table=[["a", "b"]]), GDOC, True),
        "gsheet": ("Tracker", synthetic.sheet_csv(), GSHEET, True),
        "gslides": ("Pitch", synthetic.slides_text(), GSLIDES, True),
    }
    for file_id, (name, data, mime, google) in docs.items():
        drive.put_doc(file_id, name, ["root-folder"], data, mime=mime, google=google)
    accept(worker, w, drive, source)
    approve(worker, w, source)
    result = run(worker, w, drive, source)
    assert (result.status, result.extracted, result.fetched_bytes) == ("ok", 6, sum(len(d[1]) for d in docs.values()))
    assert dict(drive.fetched) == {"docx": None, "pdf": None, "md": None, "gdoc": DOCX, "gsheet": "text/csv",
                                   "gslides": "text/plain"}
    rows = captures(worker, w, source)
    for file_id, (name, data, mime, _) in docs.items():
        row = rows[file_id]
        assert (row["status"], row["file_name"], row["mime"]) == ("extracted", name, mime)
        assert row["original_sha256"] == hashlib.sha256(data).hexdigest() and row["original_size"] == len(data)
        assert row["extractor"] == xw.EXTRACTOR and row["sandbox"] in ("bwrap", "rlimit")
        assert row["text_schema"] == payload.TEXT_SCHEMA and row["facts_schema"] == payload.FACTS_SCHEMA
        text, facts = xw.read_capture(worker, w.org, row["id"])
        assert hashlib.sha256(text.encode()).hexdigest() == row["text_sha256"]
        seen = read(api, w, w.manager, source, file_id)
        assert seen["state"] == "readable" and seen["body"] == text and seen["factsBody"] == facts
        assert seen["provenance"]["originalSha256"] == row["original_sha256"]
    assert xw.read_capture(worker, w.org, rows["docx"]["id"])[0] == synthetic.docx_text(table=synthetic.TABLE)
    assert xw.read_capture(worker, w.org, rows["docx"]["id"])[1]["tables"] == [{"rows": synthetic.TABLE}]
    assert all(line in xw.read_capture(worker, w.org, rows["pdf"]["id"])[0] for line in synthetic.UNICODE_LINES)
    assert xw.read_capture(worker, w.org, rows["md"]["id"])[0] == "# नोट्स\n- 東京 ✓\n"
    sheet_text, sheet = xw.read_capture(worker, w.org, rows["gsheet"]["id"])
    assert sheet_text == synthetic.sheet_csv().decode() and sheet["tables"][0]["rows"][2][1] == "दादर पूर्व"
    assert rows["gsheet"]["gaps"] == ["first_sheet_only"] and rows["gsheet"]["export_mime"] == "text/csv"
    assert read(api, w, w.manager, source, "gsheet")["gaps"] == ["first_sheet_only"]
    assert xw.read_capture(worker, w.org, rows["gdoc"]["id"])[1]["tables"] == [{"rows": [["a", "b"]]}]
    assert rows["gdoc"]["source_version"].startswith("modified:") and rows["pdf"]["source_version"].startswith("md5:")
    assert xw.verify(worker, w.org) == {"payloads": 12, "corrupt": 0, "corrupt_payloads": []}
    assert run(worker, w, drive, source).files == 0 and len(drive.fetched) == 6     # nothing is read twice


def test_hostile_oversized_and_unsupported_files_are_labelled_not_parsed(worker, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    drive.lie_size.add("liar")
    files = {
        "macro": ("Budget.docx", synthetic.macro_docx(), DOCX, ("quarantined", "macro")),
        "docm": ("Old.docm", b"PK\x03\x04", "application/vnd.ms-word.document.macroEnabled.12",
                 ("quarantined", "macro")),
        "entity": ("Lol.docx", synthetic.entity_docx(), DOCX, ("quarantined", "hostile_xml")),
        "bomb": ("Bomb.docx", synthetic.bomb_docx(), DOCX, ("quarantined", "hostile_archive")),
        "locked": ("Locked.docx", synthetic.encrypted_docx(), DOCX, ("quarantined", "encrypted")),
        "lockedpdf": ("Locked.pdf", synthetic.encrypted_pdf(), "application/pdf", ("quarantined", "encrypted")),
        "big": ("Big.pdf", b"%PDF-" + b"x" * (MB + 1), "application/pdf", ("quarantined", "oversized")),
        "liar": ("Small.pdf", b"%PDF-" + b"x" * (MB + 1), "application/pdf", ("quarantined", "oversized")),
        "photo": ("Site.jpg", b"\xff\xd8\xff", "image/jpeg", ("unsupported", "needs_ocr")),
        "scan": ("Scan.pdf", synthetic.scanned_pdf(), "application/pdf", ("unsupported", "no_text_layer")),
        "broken": ("Broken.pdf", synthetic.corrupt_pdf(), "application/pdf", ("quarantined", "corrupt")),
        "fake": ("Fake.pdf", synthetic.docx(), "application/pdf", ("quarantined", "type_mismatch")),
        "latin": ("Old.txt", "naïve".encode("latin-1"), "text/plain", ("unsupported", "unknown_encoding")),
        "zip": ("Bundle.zip", b"PK\x03\x04", "application/zip", ("unsupported", "format_not_supported")),
    }
    for file_id, (name, data, mime, _) in files.items():
        drive.put_doc(file_id, name, ["root-folder"], data, mime=mime)
    accept(worker, w, drive, source)
    approve(worker, w, source)
    result = run(worker, w, drive, source, files_per_run=50)
    rows = captures(worker, w, source)
    assert {f: (rows[f]["status"], rows[f]["reason"]) for f in files} == {f: v[3] for f, v in files.items()}
    assert (result.extracted, result.quarantined, result.unsupported) == (0, 10, 4)
    never_fetched = {"docm", "big", "photo", "zip"}
    assert {f for f, _ in drive.fetched} == set(files) - never_fetched
    assert all(rows[f]["original_sha256"] is None and rows[f]["sandbox"] is None for f in never_fetched)
    assert all(rows[f]["text_sha256"] is None for f in files) and payload_count(worker, w) == 0

    drive.put_doc("slow", "Slow.pdf", ["root-folder"], synthetic.pdf(), mime="application/pdf")
    accept(worker, w, drive, source)
    assert run(worker, w, drive, source, timeout=0.05).quarantined == 1
    assert (captures(worker, w, source)["slow"]["status"], captures(worker, w, source)["slow"]["reason"]) == \
        ("quarantined", "extractor_timeout")


def test_chats_whatsapp_and_government_ids_never_enter_extraction(worker, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    drive.files["ids"] = {"id": "ids", "name": "Aadhaar copies", "parents": ["root-folder"]}
    drive.put_doc("wa", "WhatsApp Chat with Synthetic Client.txt", ["root-folder"], synthetic.chat_export(),
                  mime="text/plain")
    drive.put_doc("pan", "PAN card.pdf", ["root-folder"], synthetic.pdf(["ABCPE1234F"]), mime="application/pdf")
    drive.put_doc("inids", "scan 1.pdf", ["ids"], synthetic.pdf(), mime="application/pdf")
    drive.put_doc("notes", "notes.txt", ["root-folder"], synthetic.chat_export(), mime="text/plain")
    drive.put_doc("joining", "checklist.txt", ["root-folder"], synthetic.id_numbers(), mime="text/plain")
    drive.put_doc("fine", "fine.txt", ["root-folder"], b"Shoot at 4 pm, Bandra West", mime="text/plain")
    accept(worker, w, drive, source)
    approve(worker, w, source)
    result = run(worker, w, drive, source)
    rows = captures(worker, w, source)
    assert {f: (r["status"], r["reason"]) for f, r in rows.items()} == {
        "wa": ("excluded", "chat_source"), "pan": ("excluded", "government_id"),
        "inids": ("excluded", "government_id"), "notes": ("excluded", "chat_content"),
        "joining": ("excluded", "government_id_content"), "fine": ("extracted", None)}
    assert (result.excluded, result.extracted) == (5, 1)
    assert {f for f, _ in drive.fetched} == {"notes", "joining", "fine"}    # names alone never fetch the others
    stored = q(worker, w.org, "select codec, data, sha256, raw_length from pulse_priv.drive_payload")
    texts = [payload.decode(r["codec"], r["data"], r["sha256"], r["raw_length"]).decode() for r in stored]
    assert len(texts) == 2 and not any("2345 6789 0125" in t or "Synthetic A" in t for t in texts)


def test_identical_content_is_stored_once_and_new_metadata_is_not_a_new_capture(worker, api, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    same = synthetic.docx(table=synthetic.TABLE)
    drive.put_doc("a", "Plan A.docx", ["root-folder"], same, mime=DOCX)
    drive.put_doc("b", "Plan copy.docx", ["root-folder"], same, mime=DOCX)
    accept(worker, w, drive, source)
    approve(worker, w, source)
    assert run(worker, w, drive, source).extracted == 2
    rows = captures(worker, w, source)
    assert rows["a"]["text_sha256"] == rows["b"]["text_sha256"] and payload_count(worker, w) == 2
    drive.rename("a", "Plan A (final).docx")                          # same bytes, new metadata
    accept(worker, w, drive, source)
    assert run(worker, w, drive, source).files == 0 and len(drive.fetched) == 2
    seen = read(api, w, w.manager, source, "a")
    assert (seen["provenance"]["name"], seen["provenance"]["currentName"]) == ("Plan A.docx", "Plan A (final).docx")
    drive.put_doc("a", "Plan A (final).docx", ["root-folder"], synthetic.docx(["v2 only"]), mime=DOCX)
    accept(worker, w, drive, source)
    assert "newer_version_not_captured" in read(api, w, w.manager, source, "a")["gaps"]
    assert run(worker, w, drive, source).extracted == 1
    assert read(api, w, w.manager, source, "a")["body"] == synthetic.docx_text(["v2 only"])
    assert len(q(worker, w.org, "select 1 from pulse.drive_extract where file_id='a' and source_id=%s", (source,))) == 2
    assert payload_count(worker, w) == 4                               # the first version's payloads stay
    drive.put_doc("a", "Plan A (final).docx", ["root-folder"], synthetic.encrypted_docx(), mime=DOCX)
    accept(worker, w, drive, source)
    assert run(worker, w, drive, source).quarantined == 1              # a locked new version hides nothing captured
    seen = read(api, w, w.manager, source, "a")
    assert seen["body"] == synthetic.docx_text(["v2 only"]) and "newer_version_not_captured" in seen["gaps"]
    assert seen["latest"] == {"state": "quarantined", "reason": "encrypted"}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):          # captures are append-only for the worker
        q(worker, w.org, "update pulse.drive_extract set file_name='x' where source_id=%s", (source,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(worker, w.org, "delete from pulse_priv.drive_payload")


def test_a_damaged_payload_is_reported_never_returned(worker, owner, api, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    drive.put_doc("doc", "Brief.docx", ["root-folder"], synthetic.docx(), mime=DOCX)
    accept(worker, w, drive, source)
    approve(worker, w, source)
    run(worker, w, drive, source)
    row = captures(worker, w, source)["doc"]
    with owner.transaction():
        owner.execute("select set_config('pulse.org_id', %s, true)", (str(w.org),))
        owner.execute("""update pulse_priv.drive_payload set data = overlay(data placing '\\x00'::bytea from 20 for 1)
                          where sha256 = %s and schema = %s""", (row["text_sha256"], row["text_schema"]))
    assert xw.verify(worker, w.org)["corrupt"] == 1
    with pytest.raises(payload.PayloadCorrupt):
        xw.read_capture(worker, w.org, row["id"])
    with pytest.raises(payload.PayloadCorrupt):
        read(api, w, w.manager, source, "doc")


def test_raw_source_loss_keeps_captures_and_access_changes_apply_at_once(worker, owner, api, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    for file_id in ("trash", "gone", "moved", "kept"):
        drive.put_doc(file_id, f"{file_id}.docx", ["root-folder"], synthetic.docx([f"text of {file_id}"]), mime=DOCX)
    accept(worker, w, drive, source)
    approve(worker, w, source, audience=("admin", "hr"))
    assert run(worker, w, drive, source).extracted == 4
    before = (len(q(worker, w.org, "select 1 from pulse.drive_extract")), payload_count(worker, w))
    body = lambda f: read(api, w, w.manager, source, f)  # noqa: E731

    assert read(api, w, w.editor, source, "kept") is None              # not in the audience: nothing at all
    drive.trash("trash")
    drive.remove("gone")
    drive.put_doc("elsewhere", "Elsewhere", ["my-drive"], b"", mime="application/vnd.google-apps.folder", google=True)
    drive.files["moved"] = dict(drive.files["moved"], parents=["elsewhere"])
    drive.log.append({"changeType": "file", "time": drive.tick(), "removed": False, "fileId": "moved",
                      "file": dict(drive.files["moved"])})
    accept(worker, w, drive, source)
    assert body("trash")["state"] == "readable" and body("trash")["gaps"] == ["raw_in_bin"]
    assert body("trash")["body"] == synthetic.docx_text(["text of trash"])
    assert body("gone") == {"state": "held", "reason": "source_removed"}
    assert body("moved") == {"state": "held", "reason": "moved_out_of_root"}
    with pytest.raises(PermissionError):
        xw.keep_readable(worker, w.org, source, "gone", reviewed_by=w.editor, note="deleted at source")
    with pytest.raises(ValueError):
        xw.keep_readable(worker, w.org, source, "kept", reviewed_by=w.manager, note="still in Drive")
    xw.keep_readable(worker, w.org, source, "gone", reviewed_by=w.manager, note="deleted by its owner, reviewed")
    assert body("gone")["gaps"] == ["raw_unavailable"]
    assert body("gone")["body"] == synthetic.docx_text(["text of gone"])
    assert (len(q(worker, w.org, "select 1 from pulse.drive_extract")), payload_count(worker, w)) == before

    q(worker, w.org, "update pulse.drive_source set status='access_lost' where id=%s", (source,))
    assert body("kept") == {"state": "held", "reason": "root_access_lost"}
    assert run(worker, w, drive, source).status == "not_approved"
    q(worker, w.org, "update pulse.drive_source set status='ok' where id=%s", (source,))

    q(worker, w.org, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'hr',%s)",
      (w.org, w.editor, datetime.now(UTC).date() - timedelta(days=3)))
    assert read(api, w, w.editor, source, "kept")["body"] == synthetic.docx_text(["text of kept"])
    q(worker, w.org, "update pulse.role_assignment set valid_to=%s where person_id=%s and role_key='hr'",
      (datetime.now(UTC).date() - timedelta(days=1), w.editor))
    assert read(api, w, w.editor, source, "kept") is None              # the role was taken away
    approve(worker, w, source, audience=("hr",))
    assert body("kept") is None                                        # the audience was narrowed
    approve(worker, w, source, audience=("admin",))
    assert body("kept")["state"] == "readable"
    xw.withdraw(worker, w.org, source, withdrawn_by=w.manager)
    assert body("kept") is None and body("trash") is None              # the approval was withdrawn
    assert (len(q(worker, w.org, "select 1 from pulse.drive_extract")), payload_count(worker, w)) == before

    other = build_world(worker, owner, api)                             # another tenant sees nothing of this one
    make_admin(worker, other)
    assert q(api, other.org, "select * from pulse.drive_text(%s, 'kept')", (source,), viewer=other.manager) == []
    assert q(worker, other.org, "select count(*) n from pulse_priv.drive_payload")[0]["n"] == 0


def test_health_carries_counts_and_codes_only(worker, api, world):
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    drive.put_doc("doc", "Secret plan name.docx", ["root-folder"], synthetic.docx(["captured words"]), mime=DOCX)
    drive.put_doc("photo", "Site.jpg", ["root-folder"], b"\xff\xd8", mime="image/jpeg")
    accept(worker, w, drive, source)
    approve(worker, w, source)
    run(worker, w, drive, source)
    rows = xw.status(worker, w.org)
    assert rows[0]["outcomes"] == {"extracted": 1, "unsupported": 1} and rows[0]["held"] == 0
    health = q(api, w.org, "select pulse.drive_extract_status() s", viewer=w.manager)[0]["s"]
    root = health["roots"][0]
    assert root["outcomes"] == {"extracted": 1, "unsupported": 1} and root["reasons"] == {"needs_ocr": 1}
    assert root["payloads"] == 2 and root["rawBytes"] > 0 and root["storedBytes"] > 0
    text = json.dumps([rows, health])
    assert "Secret plan" not in text and "captured words" not in text and "collector@" not in text
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w.org, "select pulse.drive_extract_status()", viewer=w.editor)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w.org, "select * from pulse.drive_extract")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q(api, w.org, "select * from pulse_priv.drive_payload")


def _pg_bin(name: str, server_major: int) -> str | None:
    """A pg_dump/pg_restore at least as new as the server (scratch PostgreSQL's own first)."""
    candidates = [os.environ.get("PULSE_PG_BIN", ""), str(Path.home() / f".cache/pulse-pg/{server_major}/usr/lib/"
                                                          f"postgresql/{server_major}/bin")]
    for folder in candidates:
        if folder and (Path(folder) / name).exists():
            return str(Path(folder) / name)
    found = shutil.which(name)
    if found:
        version = subprocess.run([found, "--version"], capture_output=True, text=True, check=False).stdout
        if int(version.split()[-1].split(".")[0]) >= server_major:
            return found
    return None


def test_an_isolated_restore_reads_every_capture_without_drive(worker, world):
    """pg_dump of this throwaway database, restored into a fresh one: every capture decodes to the same text and
    facts with no Drive object at all (the restore has nothing to fetch from)."""
    from conftest import ADMIN_URL, MODE, dsn
    if MODE["value"] != "superuser":
        pytest.skip("an isolated restore needs the scratch server's superuser (tools/pg-scratch.sh)")
    w, drive = world, ContentDrive()
    source = tracked(worker, w, drive)
    drive.put_doc("docx", "Plan.docx", ["root-folder"], synthetic.docx(table=synthetic.TABLE), mime=DOCX)
    drive.put_doc("pdf", "Plan.pdf", ["root-folder"], synthetic.pdf(), mime="application/pdf")
    drive.put_doc("sheet", "Tracker", ["root-folder"], synthetic.sheet_csv(), mime=GSHEET, google=True)
    accept(worker, w, drive, source)
    approve(worker, w, source)
    run(worker, w, drive, source)
    originals = {r["id"]: xw.read_capture(worker, w.org, r["id"]) for r in captures(worker, w, source).values()}
    assert len(originals) == 3
    server = int(worker.execute("show server_version_num").fetchone()["server_version_num"]) // 10000
    dump, restore = _pg_bin("pg_dump", server), _pg_bin("pg_restore", server)
    if not dump or not restore:
        pytest.skip(f"no pg_dump/pg_restore for PostgreSQL {server} on this machine")
    source_db = conninfo_to_dict(ADMIN_URL)["dbname"]
    target_db = f"pulse_ci_restore_{uuid.uuid4().hex[:10]}"
    archive = Path(os.environ.get("TMPDIR", "/tmp")) / f"{target_db}.dump"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'create database "{target_db}"')
    try:
        subprocess.run([dump, "-Fc", "-f", str(archive), "-d", ADMIN_URL], check=True, capture_output=True)
        subprocess.run([restore, "--exit-on-error", "-d", make_conninfo(ADMIN_URL, dbname=target_db), str(archive)],
                       check=True, capture_output=True)
        with psycopg.connect(make_conninfo(dsn("worker"), dbname=target_db), autocommit=True,
                             row_factory=dict_row) as restored:
            assert restored.execute("select current_database() d").fetchone()["d"] != source_db
            for extract_id, (text, facts) in originals.items():
                assert xw.read_capture(restored, w.org, extract_id) == (text, facts)
            assert xw.verify(restored, w.org)["corrupt"] == 0
        with psycopg.connect(make_conninfo(dsn("api"), dbname=target_db), autocommit=True,
                             row_factory=dict_row) as restored_api:
            seen = read(restored_api, w, w.manager, source, "sheet")
            assert seen["body"] == synthetic.sheet_csv().decode() and seen["gaps"] == ["first_sheet_only"]
    finally:
        archive.unlink(missing_ok=True)
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f'drop database if exists "{target_db}" with (force)')


def test_captured_text_through_the_api(worker, owner, api, world, tmp_path):
    """services/api/test/drive-text-runner.mjs: an audience member reads text with provenance, someone outside the
    audience gets 404, held and damaged captures say so without text, and the admin's Settings card shows counts."""
    from conftest import dsn
    from test_company import configure
    w, drive = world, ContentDrive()
    configure(worker, w)
    q(worker, w.org, """insert into pulse.account(org_id,provider,handle,holder_person_id,purpose)
                        values(%s,'google',%s,%s,'Workspace account')""", (w.org, f"admin-r45@{w.domain}", w.manager))
    source = tracked(worker, w, drive)
    drive.put_doc("doc", "Brief.docx", ["root-folder"], synthetic.docx(table=synthetic.TABLE), mime=DOCX)
    drive.put_doc("gone", "Gone.docx", ["root-folder"], synthetic.docx(["gone"]), mime=DOCX)
    drive.put_doc("bad", "Bad.docx", ["root-folder"], synthetic.docx(["damaged"]), mime=DOCX)
    accept(worker, w, drive, source)
    approve(worker, w, source)
    run(worker, w, drive, source)
    drive.remove("gone")
    accept(worker, w, drive, source)
    bad = captures(worker, w, source)["bad"]
    with owner.transaction():
        owner.execute("select set_config('pulse.org_id', %s, true)", (str(w.org),))
        owner.execute("""update pulse_priv.drive_payload set data = overlay(data placing '\\x00'::bytea from 20 for 1)
                          where sha256 = %s and schema = %s""", (bad["text_sha256"], bad["text_schema"]))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_ADMIN_EMAIL": f"admin-r45@{w.domain}", "TEST_OTHER_EMAIL": w.editor_handle, "TEST_SOURCE": str(source),
           "TEST_TEXT": synthetic.docx_text(table=synthetic.TABLE), "PULSE_R45_REPORT": str(tmp_path / "r45.json")}
    p = subprocess.run(["node", "test/drive-text-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                       env=env, capture_output=True, text=True, timeout=300, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    assert json.loads((tmp_path / "r45.json").read_text())["checks"] >= 8
