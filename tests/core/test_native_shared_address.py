"""FIX-LIVE-2 (BC-137, 2477): the Pulse phone app registers and works for a person of any company on the shared
address, not only the install's own. Synthetic companies only."""
import base64, hashlib, json, os, secrets, subprocess, uuid
from pathlib import Path
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _staff(worker, org, name):
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, org, name))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence) values(%s,%s,'video_editor','Pod 1','{}')", (org, pid))
    return pid


def _account_session(owner, org, person):
    """A Pulse account's session in that company: how people of every company sign in on the shared address."""
    raw = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    with owner.transaction():
        set_tenant(owner, org)
        owner.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at,device,remembered,via) values(%s,%s,%s,now()+interval '1 day','Phone',true,'account')",
                      (org, person, hashlib.sha256(raw.encode()).hexdigest()))
    return raw


def test_native_shared_address(worker, owner, api, tmp_path):
    a = build_world(worker, owner, api)
    other = build_world(worker, owner, api)
    third = build_world(worker, owner, api)
    with owner.transaction():
        home = owner.execute("select pulse.install_org() o").fetchone()["o"]
    assert home not in (other.org, third.org)
    people = {"home": _staff(worker, home, "Synthetic home phone"), "other": _staff(worker, other.org, "Synthetic other phone")}
    sessions = {"home": _account_session(owner, home, people["home"]), "other": _account_session(owner, other.org, people["other"])}
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc),
           'TEST_ORGS': json.dumps({"home": str(home), "other": str(other.org), "third": str(third.org)}),
           'TEST_PEOPLE': json.dumps({k: str(v) for k, v in people.items()}), 'TEST_SESSIONS': json.dumps(sessions),
           'TEST_REPORT': str(tmp_path / 'native-shared-address.json')}
    result = subprocess.run(['node', 'test/native-shared-address-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    report = json.loads((tmp_path / 'native-shared-address.json').read_text())
    assert report['checks'] >= 25
