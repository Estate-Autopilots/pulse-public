"""SELLER-ONBOARD (owner, 17 Nov 2026): the server's side of people intakes (migration 2226).

Every PULSE_INTAKE_POLL seconds (default 20), for each active company with an open intake:
  1. what the watched people sent since it opened and was not read yet (pulse.people_intake_pending): a message's text
     and its files (CSV, Excel .xlsx, a photo of a written list read with tesseract on this server, eng+hin+mar), a
     comment on the task, or the doc's table once nobody has typed in it for a minute; read into the nine details
     (tools/people_intake_parse.py) and handed back (pulse.people_intake_read), which posts the preview card
     ("Add N sellers?") in the conversation for an approver to confirm. Nothing about a person changes here.
  2. hand-off lists an approver's confirm left (an app's testers), when PULSE_INTAKE_HANDOFF_DIR is set: written in
     its folder for the kind (e.g. sx-testers/) as <company handle>-<day>.csv (name, gmail, phone, role; mode 600), with
     a READY line appended to
     PULSE_INTAKE_HANDOFF_NOTE for whoever adds them on the other side; their answer, <same name>.answer.json
     ({"optInUrl": "https://…", "added": [...]}) or .answer.txt (the link), is taken back: the tester link is pinned in
     the intake's group (pulse.people_intake_answer). An answer that cannot be used (not JSON, a link that is not https)
     is said once as a REFUSED line there, and read again only when its file changes.
Files, photos and their words never leave this server. The worker's own database role only (as pulse-production-index).
A stop (SIGTERM, as each release restarts it) ends it cleanly.

  PULSE_DATABASE_URL_WORKER=... uv run --with "psycopg[binary]" python tools/people-intake.py [--once]
"""
from __future__ import annotations

import datetime
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile
import time

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import people_intake_parse as P  # noqa: E402

POLL = int(os.environ.get("PULSE_INTAKE_POLL", "20"))
OCR_LANGS = os.environ.get("PULSE_INTAKE_OCR_LANGS", "eng+hin+mar")
IMAGE = re.compile(r"^image/(png|jpe?g|webp|gif|bmp|tiff?)$")
SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
REFUSED: dict[str, tuple[str, int]] = {}  # hand-off id -> the answer file (name, mtime) that was refused and said
RUN = {"busy": False, "stop": False}


def log(*a):
    print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), *a, file=sys.stderr, flush=True)


def tenant(con, org):
    con.execute("select set_config('pulse.org_id',%s::text,true)", (str(org),))


def ocr(data: bytes) -> str:
    """The words of a photo, as lines; a second layout is tried when the first finds nobody."""
    with tempfile.NamedTemporaryFile(suffix=".img") as f:
        f.write(data)
        f.flush()
        first = ""
        for psm in ("6", "4"):
            try:
                r = subprocess.run(["nice", "-n", "19", "tesseract", f.name, "stdout", "-l", OCR_LANGS, "--psm", psm],
                                   capture_output=True, timeout=120)
            except (OSError, subprocess.TimeoutExpired):
                return first
            text = r.stdout.decode("utf-8", "replace")
            if P.has_people(P.finish(P.text_rows(text, ocr=True))):
                return text
            first = first or text
        return first


def read_file(name: str, mime: str, data: bytes) -> tuple[str | None, list[dict], str | None]:
    """(kind, raw rows, note): what one attached file holds. A file that is not a list (a PDF, a voice note) is passed by."""
    low, mime = (name or "").lower(), (mime or "").lower()
    if low.endswith((".csv", ".tsv")) or mime in ("text/csv", "text/tab-separated-values"):
        return "csv", P.csv_rows(data), None
    if low.endswith(".txt") or mime == "text/plain":
        return "text", P.text_rows(data.decode("utf-8", "replace")), None
    if low.endswith(".xlsx") or mime == SHEET:
        return "xlsx", P.table_rows(P.xlsx_cells(data)), None
    if low.endswith(".xls") or mime == "application/vnd.ms-excel":
        return "xls", [], f"{name}: an old Excel file (.xls) is not read. Save it as .xlsx or CSV and send it again"
    if IMAGE.match(mime) or low.endswith((".jpg", ".jpeg", ".png", ".webp")):
        return "photo", P.text_rows(ocr(data), ocr=True), None
    if mime.startswith("image/") or low.endswith((".heic", ".heif", ".avif")):
        return "photo", [], f"{name}: this kind of photo is not read. Send a screenshot of it or a JPG photo"
    if low.endswith(".pdf") or mime == "application/pdf":
        return "pdf", [], f"{name}: a PDF is not read. Send a photo, an Excel or CSV file, or paste the rows"
    return None, [], None


def read_source(con, org, s: dict) -> tuple[list[dict], list[dict], str | None]:
    """The rows one message, comment or doc gives, where they came from, and a note when a file gave nobody."""
    files = []
    with con.transaction():
        tenant(con, org)
        for f in s.get("files") or []:
            row = con.execute("select name, mime, bytes from pulse.people_intake_file(%s,%s,%s)", (s["intake"], s["id"], f["id"])).fetchone()
            if row:
                files.append((row["name"], row["mime"], bytes(row["bytes"])))
    raws, read_from, notes = [], [], []
    if s["kind"] in ("message", "comment") and (s.get("body") or "").strip():
        got = P.text_rows(s["body"])
        if P.has_people(P.finish(got)):
            raws += got
            read_from.append({"kind": "text"})
    for name, mime, data in files:
        try:
            kind, got, note = read_file(name, mime, data)
        except Exception as e:  # a broken file is said, never fatal
            kind, got, note = "file", [], f"{name}: Pulse could not open it ({type(e).__name__})"
        if note:
            notes.append(note)
        elif kind and P.has_people(P.finish(got)):
            raws += got
            read_from.append({"kind": kind, "name": name})
        elif kind in ("csv", "xlsx", "photo"):
            notes.append(f"{name}: no names with a number or Gmail found" + (". Try a sharper photo, straight on, in good light" if kind == "photo" else ""))
    if s["kind"] == "doc":
        got = P.doc_rows(s.get("html") or "")
        if P.has_people(P.finish(got)):
            raws += got
            read_from.append({"kind": "doc"})
    rows = P.finish(raws) if raws else []
    note = None if rows or not notes else "Pulse could not read people from " + "; ".join(notes)
    return rows, read_from, note


def read_pending(con, org) -> int:
    with con.transaction():
        tenant(con, org)
        pending = con.execute("select pulse.people_intake_pending() v").fetchone()["v"] or []
    n = 0
    for s in pending:
        try:
            rows, read_from, note = read_source(con, org, s)
        except Exception as e:
            log(f"intake {s['intake']}: {s['kind']} {s['id']} could not be read: {e!r}")
            rows, read_from, note = [], [], None
        with con.transaction():
            tenant(con, org)
            batch = con.execute("select pulse.people_intake_read(%s,%s,%s,%s,%s,%s,%s,%s) v",
                                (s["intake"], s["kind"], s["id"], s["key"], s.get("author"), Jsonb(rows), Jsonb(read_from), note)).fetchone()["v"]
        n += 1
        log(f"intake {s['intake']}: {s['kind']} {s['id']} read: {len(rows)} rows" + (f", preview {batch}" if rows and batch else "") + (f" ({note})" if note else ""))
    return n


def answer_file(path: pathlib.Path) -> pathlib.Path | None:
    """The other side's answer next to a hand-off file, if there is one yet."""
    return next((p for p in (path.with_suffix(".answer.json"), path.with_suffix(".answer.txt")) if p.exists()), None)


def answer_of(path: pathlib.Path) -> tuple[str | None, dict] | None:
    """The link and details of that answer; a ValueError when it cannot be read (not JSON, not an object, not UTF-8)."""
    j, t = path.with_suffix(".answer.json"), path.with_suffix(".answer.txt")
    if j.exists():
        data = json.loads(j.read_text("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("it is not a JSON object")
        url = data.get("optInUrl") or data.get("optinUrl") or data.get("url")
        return (str(url).strip() if url else None), {k: data[k] for k in ("added", "failed", "note", "package", "track") if k in data}
    if t.exists():
        m = re.search(r"https://\S+", t.read_text("utf-8"))
        return (m.group(0).rstrip(".,)") if m else None), {"note": "answer.txt"}
    return None


def handoffs(con, org, out_dir: str | None, note_file: str | None) -> int:
    if not out_dir:
        return 0
    with con.transaction():
        tenant(con, org)
        items = con.execute("select pulse.people_intake_handoffs() v").fetchone()["v"] or []
    n = 0
    now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")  # noqa: E731
    for h in items:
        if h["state"] == "pending":
            d = pathlib.Path(out_dir) / re.sub(r"[^a-z0-9-]", "", h["kind"] or "handoff")
            d.mkdir(parents=True, exist_ok=True)
            stem = f"{h['org'] or 'company'}-{str(h['createdAt'])[:10]}"
            path, i = d / f"{stem}.csv", 2
            while path.exists():
                path, i = d / f"{stem}-{i}.csv", i + 1
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
                f.write("name,gmail,phone,role\n")
                for r in h["rows"]:
                    f.write(",".join('"' + str(r.get(k) or "").replace('"', '""') + '"' for k in ("name", "gmail", "phone", "role")) + "\n")
            with con.transaction():
                tenant(con, org)
                con.execute("select pulse.people_intake_handoff_written(%s,%s)", (h["id"], str(path)))
            if note_file:
                with open(note_file, "a", encoding="utf-8") as f:
                    f.write(f"\n{now()} READY {h['kind']}: {path} ({len(h['rows'])} people of {h['orgName']} to add as testers; name, gmail, phone, role).\n"
                            f"  Answer next to it: {path.with_suffix('.answer.json').name} with {{\"optInUrl\": \"https://play.google.com/apps/testing/<package>\", \"added\": [gmails], \"failed\": [...]}}"
                            f" (or {path.with_suffix('.answer.txt').name} holding the opt-in link). Pulse then pins the link in the group.\n")
            log(f"hand-off {h['id']}: {len(h['rows'])} rows written to {path}")
            n += 1
        elif h["state"] == "written" and h.get("path"):
            ans = answer_file(pathlib.Path(h["path"]))
            if not ans:
                continue
            seen = (ans.name, ans.stat().st_mtime_ns)
            if REFUSED.get(h["id"]) == seen:
                continue  # said once already; read again when the file changes
            why = None
            try:
                got = answer_of(pathlib.Path(h["path"]))
                if got is None:
                    continue  # taken away again before it was read
                url, detail = got
                with con.transaction():
                    tenant(con, org)
                    msg = con.execute("select pulse.people_intake_answer(%s,%s,%s) v", (h["id"], url, Jsonb(detail))).fetchone()["v"]
            except ValueError as e:
                why = f"it cannot be read ({e})"
            except psycopg.OperationalError:
                raise  # the database, not the answer: tried again at the next poll
            except psycopg.Error as e:
                why = (e.diag.message_primary if e.diag else None) or str(e)
            if why:
                REFUSED[h["id"]] = seen
                log(f"hand-off {h['id']}: the answer {ans.name} was refused: {why}")
                if note_file:
                    with open(note_file, "a", encoding="utf-8") as f:
                        f.write(f"\n{now()} REFUSED {ans.name}: {why}. Nothing was pinned. Write the answer again under the same name;"
                                " Pulse reads it once it changes.\n")
                continue
            REFUSED.pop(h["id"], None)
            if note_file:
                with open(note_file, "a", encoding="utf-8") as f:
                    f.write(f"\n{now()} ANSWERED {pathlib.Path(h['path']).name}: " + (f"tester link {url} pinned in the group.\n" if msg else "noted (no new link to pin).\n"))
            log(f"hand-off {h['id']}: answered" + (f", link pinned (message {msg})" if msg else ""))
            n += 1
    return n


def run_once(con, out_dir=None, note_file=None, only=None) -> int:
    with con.transaction():
        orgs = [r["org"] for r in con.execute("select pulse.list_active_orgs() org").fetchall()]
    if only is not None:
        orgs = [o for o in orgs if str(o) in {str(x) for x in only}]
    n = 0
    for org in orgs:
        try:
            n += read_pending(con, org)
            n += handoffs(con, org, out_dir, note_file)
        except Exception as e:
            log(f"company {org}: {e!r}")
    return n


def _on_stop(signum, frame):
    """A stop between polls ends it now; during one, once that poll is done (no hand-off file left half-said)."""
    RUN["stop"] = True
    if not RUN["busy"]:
        sys.exit(0)


def main():
    url = os.environ.get("PULSE_DATABASE_URL_WORKER")
    if not url:
        sys.exit("PULSE_DATABASE_URL_WORKER is not set")
    out_dir, note_file = os.environ.get("PULSE_INTAKE_HANDOFF_DIR"), os.environ.get("PULSE_INTAKE_HANDOFF_NOTE")
    once = "--once" in sys.argv
    signal.signal(signal.SIGTERM, _on_stop)
    while True:
        try:
            with psycopg.connect(url, row_factory=dict_row, options="-c role=pulse_worker", autocommit=True) as con:
                while True:
                    RUN["busy"] = True
                    try:
                        run_once(con, out_dir, note_file)
                    finally:
                        RUN["busy"] = False
                    if once or RUN["stop"]:
                        return
                    time.sleep(POLL)
        except psycopg.OperationalError as e:
            if RUN["stop"]:
                return
            log(f"database: {' '.join(str(e).split())}; again in 60 s")  # one journal line (psycopg's message has several)
            if once:
                sys.exit(1)
            time.sleep(60)


if __name__ == "__main__":
    main()
