"""FLOW-A (owner, 21 Oct 2026): the Flow engine (0800) through the built API on the synthetic agency: processes and
templates, readiness (data, not permission), variants, the sprint clock, Work tasks both ways, module backends, Pip per
step, decisions, alerts from the tick, scorecard and capacity (services/api/test/flow-runner.mjs)."""
import json
import os

import pytest
from conftest import MODE, dsn, role_url
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_sop import demo_world, run_runner


def test_flow_api(worker, owner, api, tmp_path):
    w, p = demo_world(worker, owner, api)
    report = run_runner('flow-runner', w, p, tmp_path, timeout=600)
    assert report['checks'] >= 100


def test_flow_primitives(worker, owner, api, tmp_path):
    """FLOW-D: primitives, company blocks, Describe it, the order of a vertical flow, Decide by a rule, Message, Wait,
    runs that start by themselves (a lead, a form, a schedule), a Collect step finished by its form, Try it
    (services/api/test/flow-d-runner.mjs). The lead is inserted as the ads sync does (the worker's login)."""
    w, p = demo_world(worker, owner, api)
    config = conninfo_to_dict(dsn('worker')); config['database'] = config.pop('dbname')
    report = run_runner('flow-d-runner', w, p, tmp_path, extra={'TEST_WORKER_CONFIG': json.dumps(config)}, timeout=600)
    assert report['checks'] >= 60


def test_flow_industry_apps(worker, owner, api, tmp_path):
    """FLOW-E: industry packs (words, roles, starter processes, record types), roles as data (holders, two roles, steps
    landing on a role's holder, home tiles, a role's screens), apps as App actions (statuses, a process's own address,
    a signed webhook out, a calendar event, a Drive folder and file, a WhatsApp opened), and a new company set up with a
    pack by the operator (services/api/test/flow-e-runner.mjs)."""
    w, p = demo_world(worker, owner, api)
    config = conninfo_to_dict(dsn('worker')); config['database'] = config.pop('dbname')
    report = run_runner('flow-e-runner', w, p, tmp_path, extra={'TEST_WORKER_CONFIG': json.dumps(config)}, timeout=600)
    assert report['checks'] >= 80


@pytest.mark.skipif(os.environ.get('PULSE_AUTH_BROWSER') != '1', reason='browser flows need PULSE_AUTH_BROWSER=1 and a built web app (or FLOW_NEXT_DEV=1)')
def test_flow_end_to_end(worker, owner, api, tmp_path):
    """FLOW-D end to end in the browser (services/api/test/flow-e2e.mjs): a process built from scratch with primitives,
    the EA client project and the Solar install, each made live, run and finished by the people of each role signing
    in, with notifications, alerts on a late step (the clock moved), the run's end and the scorecard. FLOW-E: a new
    company set up from scratch with the Solar pack (Sales X-Ray through a test double, the GPS photo), a consulting
    engagement, and someone in HR with a second role."""
    w, p = demo_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        client = owner.execute("select client_id from pulse.project where id=%s", (w.project,)).fetchone()["client_id"]
        # The installer's sales person makes quotations in Billing (Billing is for leadership and the Finance role).
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2020-01-01')", (w.org, p['asha']))
        for kind, status, number in [('quotation', 'sent', 'Q-E2E-1'), ('invoice', 'issued', 'INV-E2E-1')]:
            owner.execute("""insert into pulse.erp_document(org_id,doc_type,status,number,client_id,project_id,buyer,total)
                values(%s,%s,%s,%s,%s,%s,'{"name":"Putig"}',250000)""", (w.org, kind, status, number, client, w.project))
    config = conninfo_to_dict(dsn('worker')); config['database'] = config.pop('dbname')
    # FLOW-E: the new company is activated as its operator would (the activation gates are R53/R54's, tested there).
    owner_config = conninfo_to_dict(role_url('migrate') if MODE['value'] == 'superuser' else dsn('owner')); owner_config['database'] = owner_config.pop('dbname')
    report = run_runner('flow-e2e', w, p, tmp_path, extra={'TEST_WORKER_CONFIG': json.dumps(config), 'TEST_OWNER_CONFIG': json.dumps(owner_config), 'TEST_PROJECT': str(w.project)}, timeout=3600)
    assert not report['failed'], report
