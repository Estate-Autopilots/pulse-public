"""PEOPLE-CONTACTS: profiles, bank details, Account access, photos, contact types and contact profiles on a disposable
tenant with synthetic people only. The acceptance itself is services/api/test/people-contacts-runner.mjs against the
built API: who may change a photo, My info, bank details sealed with a throwaway keyring and seen only by the person
and the HR role, change requests HR approves, bank nudges, one-time sign-in links, per-device sign-out, the
organisation's own types and a contact's profile (notes, money, suggested links). The browser flows (cropper, My info,
Account access, types, contact profile) run with PULSE_AUTH_BROWSER=1 after `NEXT_DIST_DIR=.next-build next build`."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _world(worker, owner, api):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ['person', 'other', 'lead', 'hr', 'leadership', 'admin', 'contact']}
    client, project = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            side = 'client' if role == 'contact' else 'staff'
            name = 'Synthetic Rao' if role == 'contact' else 'Synthetic ' + role
            worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,%s)", (pid, w.org, name, side))
            if role == 'contact':
                worker.execute("insert into pulse.contact_profile(org_id,person_id,contact_type,designation,city) values(%s,%s,'developer','Sales head','Pune')", (w.org, pid))
                continue
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,email) values(%s,%s,%s,'Pod 1','{}',%s,%s)",
                           (w.org, pid, role, 'synthetic.' + role, role + '@delivery.example'))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role + '@people.example', pid))
            if role in ['hr', 'leadership', 'admin']:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
        # A client with the contact, one of its projects, and Drive files: one in the project, one naming the contact.
        worker.execute("insert into pulse.client(id,org_id,display_name,client_type) values(%s,%s,'Synthetic Developers','developer')", (client, w.org))
        worker.execute("insert into pulse.client_contact(org_id,client_id,person_id,is_primary) values(%s,%s,%s,true)", (w.org, client, roles['contact']))
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,client_id,kind,start_month) values(%s,%s,9101,'Synthetic Heights',%s,'client_work','2026-08-01')", (project, w.org, client))
        # Another project, not linked to the contact, whose Drive files name them: Pulse proposes the link.
        other_project = uuid.uuid4()
        worker.execute("insert into pulse.project(id,org_id,registry_no,name,kind,start_month) values(%s,%s,9102,'Synthetic Towers','client_work','2026-09-01')", (other_project, w.org))
        for fid, name, path, pid in [('syn-file-1', 'Synthetic Heights brochure.pdf', 'Projects/Synthetic Heights', project), ('syn-file-2', 'Call notes Synthetic Rao.docx', 'Shared/Sales', None),
                                     ('syn-file-3', 'Synthetic Rao approval.pdf', 'Projects/Synthetic Towers', other_project)]:
            worker.execute("insert into pulse.index_file(org_id,file_id,name,mime,path,project_id,modified_at,observed_at,account_basis,event_seq) values(%s,%s,%s,'application/pdf',%s,%s,now(),now(),'unknown',1)",
                           (w.org, fid, name, path, pid))
        # FIN-LIVE: one invoice to the client's invoice party (matched to the client).
        worker.execute("""insert into pulse_priv.finance_live_record(org_id,kind,key,scope,body,source,hash,confidence) values(%s,'invoice','INV-SYN-1','mail:sales',
            '{"number":"INV-SYN-1","date":"2026-09-15","client":"Synthetic Developers Pvt Ltd","total":118000,"balanceDue":18000}','{"type":"synthetic"}',%s,'high')""", (w.org, '0' * 64))
        worker.execute("insert into pulse_priv.money_party(org_id,party_key,party,client_id,basis,status) values(%s,pulse.value_key('Synthetic Developers Pvt Ltd'),'Synthetic Developers Pvt Ltd',%s,'exact','auto')", (w.org, client))
    roles['client'] = client; roles['project2'] = other_project
    # The person has a password (sign-in links are for accounts that have one); the other one does not.
    with api.transaction():
        set_tenant(api, w.org, roles['admin'])
        api.execute("select pulse.login_issue(%s,'Synthetic-account-2026!')", (roles['person'],))
    config = conninfo_to_dict(dsn('api')); config['database'] = config.pop('dbname')
    wc = conninfo_to_dict(dsn('migrate')); wc['database'] = wc.pop('dbname')
    return w, roles, config, wc


def test_people_contacts(worker, owner, api, tmp_path):
    w, roles, config, wc = _world(worker, owner, api)
    keys = tmp_path / 'keys'; keys.mkdir(mode=0o700)
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(wc), 'PULSE_ORG_ID': str(w.org),
           'TEST_ROLES': json.dumps({r: str(p) for r, p in roles.items()}), 'TEST_REPORT': str(tmp_path / 'people-contacts.json'),
           'TEST_KEY_DIR': str(keys), 'PULSE_CI': '1', 'PULSE_IFSC_LOOKUP': 'off'}
    env.pop('PULSE_DOCUMENT_KEY_FILE', None)
    result = subprocess.run(['node', 'test/people-contacts-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, text=True, capture_output=True, timeout=240)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    report = json.loads((tmp_path / 'people-contacts.json').read_text())
    assert report['checks'] >= 90
    # The API's own log never carries an account number, the UPI ID or a master key.
    log = result.stdout + result.stderr
    assert '000123456789' not in log and '9876543210@ybl' not in log
    for line in (keys / 'document-master.key').read_text().split('\n'):
        if line.strip():
            assert line.split()[1] not in log


@pytest.mark.skipif(os.environ.get('PULSE_AUTH_BROWSER') != '1', reason='browser flows need PULSE_AUTH_BROWSER=1 and a built web app')
def test_people_contacts_in_the_browser(worker, owner, api, tmp_path):
    w, roles, config, wc = _world(worker, owner, api)
    keys = tmp_path / 'keys'; keys.mkdir(mode=0o700)
    env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_ROLES': json.dumps({r: str(p) for r, p in roles.items()}),
           'TEST_REPORT': str(tmp_path / 'browser.json'), 'TEST_KEY_DIR': str(keys), 'PULSE_CI': '1'}
    p = subprocess.run(['node', 'test/people-contacts-browser.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env, capture_output=True, text=True, timeout=1500, check=False)
    report = json.loads((tmp_path / 'browser.json').read_text()) if (tmp_path / 'browser.json').exists() else None
    assert p.returncode == 0 and report and not report['failed'], (p.stderr + p.stdout)[-8000:]
