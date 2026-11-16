"""EST-652: the EA-unchanged baseline is read-only, counts-only and refuses every database but staging and production.

A synthetic Northwind company is the install; a decoy tenant proves the counts never cross companies.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

from conftest import ADMIN_URL
from helpers import new_code
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

SCRIPT = Path(__file__).resolve().parents[2] / 'tools/qa/ea-baseline.py'
_spec = importlib.util.spec_from_file_location('ea_baseline', SCRIPT)
ea_baseline = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ea_baseline)

NAMES = ['Northwind Editor One', 'Northwind Editor Two', 'Northwind Lead', 'Northwind Pod Head',
         'Northwind Freelancer', 'Northwind Former Staff']


def schema_owner(owner) -> None:
    role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()['r']
    assert re.fullmatch(r'[a-z_][a-z0-9_]*', role)
    owner.execute(f'set local role {role}')


def northwind(owner) -> dict:
    """The install company with people, roles, pods, projects, clients, config, HR policy and leave."""
    org, decoy = uuid.uuid4(), uuid.uuid4()
    code = new_code()
    people = [uuid.uuid4() for _ in NAMES]
    editor, editor2, lead, head, freelancer, former = people
    pod_a, pod_b, old_pod = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        schema_owner(owner)
        set_tenant(owner, decoy)
        owner.execute("insert into pulse.org(id,slug,name,code) values(%s,%s,'Decoy Company',%s)",
                      (decoy, f'decoy-{decoy}', new_code()))
        decoy_person = owner.execute("insert into pulse.person(org_id,display_name,side) values(%s,'Decoy Person',"
                                     "'staff') returning id", (decoy,)).fetchone()['id']
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) "
                      "values(%s,%s,'video_editor','2026-01-01')", (decoy, decoy_person))
        owner.execute("insert into pulse.project(org_id,registry_no,name) values(%s,1,'Decoy project')", (decoy,))

        set_tenant(owner, org)
        owner.execute("insert into pulse.org(id,slug,name,code,time_zone) values(%s,%s,'Northwind Studio',%s,"
                      "'Europe/London')", (org, f'northwind-{org}', code))
        for pid, name, side, status in zip(people, NAMES, ['staff'] * 4 + ['freelancer', 'staff'],
                                           ['active'] * 5 + ['inactive']):
            owner.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,%s,%s,%s)",
                          (pid, org, name, side, status))
        for pid, role in ((editor, 'editor'), (editor2, 'editor'), (lead, 'pgs'), (head, 'head_pgs'),
                          (freelancer, 'editor'), (former, 'editor')):
            owner.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,email) "
                          "values(%s,%s,%s,'Pod Avery',%s,%s)",
                          (org, pid, role, 'Synthetic Northwind fixture', f'{role}.{pid.hex[:6]}@northwind.example'))
        for unit, name, valid_to in ((pod_a, 'Pod Avery', None), (pod_b, 'Pod Blake', None),
                                     (old_pod, 'Pod Casey', '2026-02-01')):
            owner.execute("insert into pulse.unit(id,org_id,kind,name,valid_from,valid_to) "
                          "values(%s,%s,'pod',%s,'2026-01-01',%s)", (unit, org, name, valid_to))
        owner.execute("insert into pulse.unit(org_id,kind,name) values(%s,'team','Video')", (org,))
        for pid, role, valid_to in ((editor, 'video_editor', None), (editor2, 'video_editor', None),
                                    (lead, 'pgs', None), (head, 'head_pgs', None), (head, 'pgs', '2026-02-01'),
                                    (editor, 'admin', None)):
            owner.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,valid_from,valid_to) "
                          "values(%s,%s,%s,%s,'2026-01-01',%s)", (org, pid, pod_a, role, valid_to))
        clients = []
        for name, status in (('Northwind Homes', 'active'), ('Lakeview Group', 'active'), ('Old Client', 'churned'),
                             ('Unsorted Client', None)):
            clients.append(owner.execute("insert into pulse.client(org_id,display_name,status) values(%s,%s,%s) "
                                         "returning id", (org, name, status)).fetchone()['id'])
        for n, (name, unit, status) in enumerate((('Maple Rise', pod_a, 'active'), ('Cedar Point', pod_a, 'active'),
                                                  ('Old Launch', pod_a, 'done'), ('Harbour View', pod_b, 'active'),
                                                  ('Loose Project', None, 'active'), ('Past Pod', old_pod, 'active'),
                                                  ('New Brief', None, 'onboarding')), start=1):
            owner.execute("insert into pulse.project(org_id,registry_no,name,client_id,unit_id,lead_person_id,status) "
                          "values(%s,%s,%s,%s,%s,%s,%s)", (org, n, name, clients[n % 2], unit, lead, status))
        for kind, key, version, active in (('folder_rules', 'default', 1, False), ('folder_rules', 'default', 2, True),
                                           ('role_pack', 'video_editor', 1, True), ('rubric', 'editing', 1, False)):
            owner.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active,created_by) "
                          "values(%s,%s,%s,%s,%s,%s,%s)", (org, kind, key, version, Jsonb({}), active, head))
        owner.execute("insert into pulse.hr_policy(org_id,attendance_enabled,wfh_per_month,confirmed_at,confirmed_by) "
                      "values(%s,true,4,now(),%s)", (org, head))
        for pid, created in ((editor, '1 day'), (editor2, '29 days'), (lead, '45 days')):
            owner.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,created_at) "
                          "values(%s,%s,current_date+7,current_date+8,'annual',now()-%s::interval)", (org, pid, created))
        owner.execute("insert into pulse.install(org_id,initialised_by) values(%s,'test:northwind-baseline')", (org,))
    return {'org': org, 'code': code, 'people': people, 'editor2': editor2}


def ci_database(owner) -> str:
    return owner.execute('select current_database() db').fetchone()['db']


def test_refuses_every_database_but_staging_and_production(owner):
    assert ci_database(owner) not in ea_baseline.ALLOWED_DATABASES
    run = subprocess.run([sys.executable, str(SCRIPT)], env={**os.environ, 'PULSE_RELEASE_TEST_URL': ADMIN_URL},
                         capture_output=True, text=True, timeout=60, check=False)
    assert run.returncode == 2
    assert run.stdout == ''
    assert 'refusing to run on database' in run.stderr and 'pulse_staging, pulse' in run.stderr


def test_northwind_baseline_is_counts_and_config_only(owner):
    world = northwind(owner)
    result = ea_baseline.read_baseline(ADMIN_URL, allowed=(ci_database(owner),))
    assert result['meta']['database'] == ci_database(owner)
    policy = result.pop('hr_policy')
    assert policy['attendance_enabled'] is True and policy['confirmed'] is True and policy['wfh_per_month'] == 4
    assert not {'org_id', 'confirmed_by', 'confirmed_at', 'updated_at'} & policy.keys()
    org = result.pop('org')
    assert {k: org[k] for k in ('name', 'code', 'time_zone')} == {'name': 'Northwind Studio', 'code': world['code'],
                                                                  'time_zone': 'Europe/London'}
    assert not {'id', 'slug', 'created_at'} & org.keys()
    del result['meta']
    assert result == {
        'people': {'active': 5, 'active_by_side': {'freelancer': 1, 'staff': 4}},
        'roles': {'assigned': {'admin': 1, 'head_pgs': 1, 'pgs': 1, 'video_editor': 2},
                  'profile': {'editor': 3, 'head_pgs': 1, 'pgs': 1}},
        'projects': {'by_status': {'active': 5, 'done': 1, 'onboarding': 1}, 'active_without_pod': 2},
        'clients': {'by_status': {'active': 2, 'churned': 1, 'none': 1}},
        'pods': {'current': 2, 'active_projects': [2, 1]},
        'tenant_config': {'folder_rules/default': 2, 'role_pack/video_editor': 1},
        'leave_requests_last_30_days': 2,
    }
    text = json.dumps([org, result, policy])
    assert '@' not in text and not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-', text)
    assert not [name for name in NAMES + ['Pod Avery', 'Pod Blake', 'Maple Rise', 'Northwind Homes'] if name in text]


def test_diff_prints_only_the_changed_keys(owner, tmp_path, capsys, monkeypatch):
    world = northwind(owner)
    database = ci_database(owner)
    before = ea_baseline.read_baseline(ADMIN_URL, allowed=(database,))
    assert ea_baseline.diff(before, ea_baseline.read_baseline(ADMIN_URL, allowed=(database,))) == {}
    with owner.transaction():
        schema_owner(owner)
        set_tenant(owner, world['org'])
        owner.execute("update pulse.person set status='inactive' where id=%s", (world['editor2'],))
        owner.execute("update pulse.tenant_config set is_active=false where org_id=%s and doc_kind='role_pack'",
                      (world['org'],))
        owner.execute("insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active) "
                      "values(%s,'role_pack','video_editor',2,'{}',true)", (world['org'],))
        owner.execute("update pulse.hr_policy set attendance_enabled=false where org_id=%s", (world['org'],))
    old = tmp_path / 'old.json'
    old.write_text(json.dumps(before))
    monkeypatch.setenv('PULSE_RELEASE_TEST_URL', ADMIN_URL)
    assert ea_baseline.main(['--diff', str(old)], allowed=(database,)) == 0
    assert json.loads(capsys.readouterr().out) == {
        'hr_policy.attendance_enabled': [True, False],
        'people.active': [5, 4],
        'people.active_by_side.staff': [4, 3],
        'roles.profile.editor': [3, 2],
        'tenant_config.role_pack/video_editor': [1, 2],
    }


def test_refuses_to_print_an_id_or_email():
    for leak in ({'tenant_config': {'role_pack/0b0e8a3c-4f1d-4a77-9c3e-2f6d8b1a9e10': 1}},
                 {'org': {'name': 'someone@northwind.example'}}):
        try:
            ea_baseline.assert_private_free(leak)
        except ea_baseline.Refused:
            continue
        raise AssertionError(f'leak not refused: {leak}')


def test_diff_refuses_private_prior_json_without_output(tmp_path, capsys, monkeypatch):
    old = tmp_path / 'old.json'
    monkeypatch.setenv('PULSE_RELEASE_TEST_URL', ADMIN_URL)

    def should_not_read_database(*_args, **_kwargs):
        raise AssertionError('database was read')

    monkeypatch.setattr(ea_baseline, 'read_baseline', should_not_read_database)
    for leak in ('someone@northwind.example', '0b0e8a3c-4f1d-4a77-9c3e-2f6d8b1a9e10'):
        old.write_text(json.dumps({'org': {'name': leak}}))

        assert ea_baseline.main(['--diff', str(old)], allowed=()) == 2
        captured = capsys.readouterr()
        assert captured.out == ''
        assert 'nothing printed' in captured.err
