"""PRESENCE-ONBOARD: check-in everywhere and onboarding everyone, on a disposable tenant with synthetic people only.

Attendance correctness (racing taps, offline replay, office Wi-Fi and phone-geofence simulations through the server
tick, never an automatic check-out), the day timeline, reminders, the payroll month, onboarding and who may see
government IDs. The acceptance itself is services/api/test/presence-onboard-runner.mjs against the built API."""
import base64, json, os, subprocess, uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_presence_onboard(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ['person', 'other', 'lead', 'outsider', 'member2', 'member3', 'hr', 'leadership', 'admin']}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, 'Synthetic ' + role))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,%s,'Pod 1','{}')", (w.org, pid, role))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role + '@presence.example', pid))
            if role in ['hr', 'leadership', 'admin']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
        # HR holds the named permissions; leadership deliberately does not (sees "on file" only).
        for permission in ['hr.documents.read', 'hr.contact.read', 'hr.contact.write']:
            worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,%s,'synthetic')", (w.org, roles['hr'], permission))
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    nc = conninfo_to_dict(dsn('worker')); nc['database'] = nc.pop('dbname')
    # PRESENCE-2: throwaway document keyrings live only in this test's own directory.
    keys = tmp_path / 'keys'; keys.mkdir(mode=0o700)
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc), 'PULSE_ORG_ID': str(w.org),
           'TEST_WORKER_CONFIG': json.dumps(nc), 'TEST_ROLES': json.dumps({r: str(p) for r, p in roles.items()}),
           'TEST_REPORT': str(tmp_path / 'presence-onboard.json'), 'TEST_KEY_DIR': str(keys)}
    env.pop('PULSE_DOCUMENT_KEY_FILE', None)
    result = subprocess.run(['node', 'test/presence-onboard-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=240)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    report = json.loads((tmp_path / 'presence-onboard.json').read_text())
    assert report['checks'] >= 150
    # The API's log (stdout/stderr, including its refusals) never carries a master key in any encoding.
    log = result.stdout + result.stderr
    for line in (keys / 'all.keys').read_text().split():
        raw = base64.b64decode(line)
        for form in (line, raw.hex(), base64.urlsafe_b64encode(raw).decode().rstrip('=')):
            assert form not in log, 'a document master key reached the API log'
    assert 'Request refused' in log, 'the refusals were logged (by reason, without keys)'
    if os.environ.get('PRESENCE_RECEIPT_DIR'):
        out = Path(os.environ['PRESENCE_RECEIPT_DIR']); out.mkdir(parents=True, exist_ok=True)
        (out / 'presence-onboard-acceptance.json').write_text(json.dumps(report, indent=2))


class _Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchall(self):
        return self.rows


class _Index:
    """A stand-in for the read-only EA index: one HR sheet and two KYC-named files in HR's Drive."""

    def __init__(self, sheets, files):
        self.sheets, self.files = sheets, files

    def execute(self, sql, _params=()):
        return _Rows(self.sheets if "drive_text" in sql else self.files)


def test_onboard_proposals_point_and_never_copy_ids(worker, owner, api):
    from pulse_gdrive_snapshot.onboard_proposals import propose
    from pulse_sdk.sheet_rows import MARKER
    w = build_world(worker, owner, api)
    asha, ravi = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name in [(asha, 'Synthetic Asha Rao'), (ravi, 'Synthetic Ravi Kalah')]:
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,'Editor','{}')", (w.org, pid))
        worker.execute("insert into pulse_priv.hr_document(org_id,person_id,doc_type) values(%s,%s,'id_aadhaar')", (w.org, asha))
    sheet = {"id": "sheet-synthetic", "name": "Employee details (synthetic)", "path": "HR",
             "body": f"## Staff{MARKER}\nName,Date of Birth,Personal Email,Aadhaar No,Salary\nSynthetic Asha Rao,14/03/1997,asha@example.test,2345 6789 0124,50000\nSynthetic Unknown,01/01/1990,x@example.test,,\n"}
    files = [{"id": "file-pan-asha", "name": "PAN card.pdf", "path": "HR/KYC/Synthetic Asha Rao"},
             {"id": "file-aadhaar-both", "name": "Aadhaar.pdf", "path": "HR/KYC/Synthetic Asha Rao and Synthetic Ravi Kalah"}]
    config = {"sensitive_access": ["hr@synthetic.example"]}
    result = propose(_Index([sheet], files), worker, w.org, config)
    assert result["proposed"] == {"document": 1, "sheet": 2, "drive": 1}
    again = propose(_Index([sheet], files), worker, w.org, config)
    assert again["proposed"] == {"document": 0, "sheet": 0, "drive": 0}, "proposals are offered once"
    with worker.transaction():
        set_tenant(worker, w.org)
        rows = worker.execute("select person_id,field,value,document_kind,source,source_label,source_ref from pulse_priv.profile_proposal order by field,source").fetchall()
    assert {(r["field"], r["value"], r["document_kind"], r["source"]) for r in rows} == {
        ("dob", "1997-03-14", None, "hr_sheet"), ("personalEmail", "asha@example.test", None, "hr_sheet"),
        ("document", None, "aadhaar", "drive"), ("document", None, "pan", "drive")}
    assert all(r["person_id"] == asha for r in rows), "an unknown name and a folder naming two people propose nothing"
    blob = repr(rows)
    assert "2345" not in blob and "50000" not in blob, "no ID number or salary reaches a proposal"
    assert any(r["source_label"].startswith("HR's records: Aadhaar on file") for r in rows)
