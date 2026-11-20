"""DHANASHREE-3 (18 Nov 2026): every change the API writes to the history (pulse.record_change) uses an entity type the
database accepts.

Settings → Organisation renamed the company and, when Billing's seller still carried the old name, renamed it too and
logged that as entity "erp_settings". record_change_entity_type_check has never accepted "erp_settings", so the whole save
failed (500) and nothing was renamed: a company made at sign-up ("website developer pune", Billing's legal name = the
company name) could not fix its own name. The log now says "org" / "billingLegalName". Settings → Drive backup had the
same fault ("drive_backup": every save failed); it now logs "org" / "driveBackup".

This reads the check from the migrated database and every entity type written by services/api/src: through a file's
own `log(c, v, "<entity>", …)` helper that inserts into record_change, an inline `insert into pulse.record_change(…)
values ($1,'<entity>', …)`, or its parameters `[…, "<entity>", …]`. Any type the check refuses fails here, before it
fails a person's save."""
import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
# A helper named log/logChange/... whose body inserts into pulse.record_change.
HELPER = re.compile(r"const\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*(?:\{[^}]*?)?c\.query\(\s*[`'\"][^`'\"]*record_change", re.S)
INSERT = re.compile(r"insert into pulse\.record_change\s*\(org_id,\s*entity_type[^)]*\)\s*values\s*\(\s*[^,]+,\s*'([a-z_]+)'", re.I)
# insert … values ($1,$2,…)", [<org>, "<entity>", …]
PARAMS = re.compile(r"insert into pulse\.record_change\s*\(org_id,\s*entity_type[^)]*\)\s*values\s*\(\s*\$1\s*,\s*\$2[^`'\"]*[`'\"]\s*,\s*\[\s*[^,\]]+,\s*[\"']([a-z_]+)[\"']", re.I)


def allowed(owner) -> set[str]:
    row = owner.execute("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'record_change_entity_type_check'").fetchone()
    assert row, "record_change_entity_type_check is missing"
    return set(re.findall(r"'([a-z_]+)'::text", row["def"]))  # the test connections return rows as dicts


def written() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for f in sorted(SRC.glob("*.ts")):
        text = f.read_text(encoding="utf-8")
        found = set(INSERT.findall(text)) | set(PARAMS.findall(text))
        for name in {m.group(1) for m in HELPER.finditer(text)}:
            found |= set(re.findall(rf"\b{re.escape(name)}\(\s*\w+\s*,\s*\w+\s*,\s*[\"']([a-z_]+)[\"']", text))
        if found:
            out[f.name] = found
    return out


def test_every_history_entity_the_api_writes_is_accepted(owner):
    ok = allowed(owner)
    assert {"org", "company", "client", "person", "project"} <= ok
    seen = written()
    # The scan finds the helpers it guards: Settings (org, pod, role, permission) and the company book.
    assert "org" in seen.get("settings.ts", set()), seen.get("settings.ts")
    assert "company" in seen.get("companies.ts", set()), seen.get("companies.ts")
    bad = {f: sorted(x - ok) for f, x in seen.items() if x - ok}
    assert not bad, f"record_change refuses these entity types (add them to the check, or log another entity): {bad}"


def test_the_rename_and_drive_backup_log_as_the_organisation(owner):
    ok = allowed(owner)
    assert "erp_settings" not in ok and "drive_backup" not in ok, "the check accepts them now: the logs below may change back"
    settings = (SRC / "settings.ts").read_text(encoding="utf-8")
    assert '"erp_settings"' not in settings
    assert re.search(r'log\(c, v, "org", v\.org, "billingLegalName", before, name\)', settings)
    backup = (SRC / "drive-backup.ts").read_text(encoding="utf-8")
    assert "'drive_backup',pulse.current_org()" not in backup
    assert "values(pulse.current_org(),'org',pulse.current_org(),'driveBackup'" in backup
