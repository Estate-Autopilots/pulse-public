"""EST-2549: HQ route mutations are audited once, with safe diffs and tenant isolation."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def test_hq_audit(worker, owner, api, tmp_path):
    first = build_world(worker, owner, api)
    second = build_world(worker, owner, api)
    for world in (first, second):
        with owner.transaction():
            set_tenant(owner, world.org)
            owner.execute("update pulse.account set purpose='Workspace account' where org_id=%s and holder_person_id=%s", (world.org, world.editor))
            owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (world.org, world.editor))
    with owner.transaction():
        set_tenant(owner, first.org, first.editor)
        owner.execute("""insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active)
            values(%s,'tenant','modules',1,'{"off":[],"on":["pulse_hq"]}',true)""", (first.org,))
    root = Path(__file__).resolve().parents[2]
    # A pre-existing audit trigger must survive reapplication without a second event per write.
    with owner.transaction():
        owner.execute((root / 'db/migrations/1102_hq_audit.sql').read_text().split('-- migrate:down')[0])
        triggers = owner.execute("""select c.relname, count(*) n from pg_trigger t
            join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='pulse' and c.relname=any(%s) and not t.tgisinternal
            and t.tgfoid='pulse.audit_mutation()'::regprocedure group by c.relname""",
            (['hq_feature', 'hq_offer', 'hq_idea', 'hq_idea_vote', 'hq_brand', 'hq_brand_version'],)).fetchall()
        assert len(triggers) == 6
        assert all(row['n'] == 1 for row in triggers)
    env = {**os.environ, 'PULSE_ORG_ID': str(first.org), 'TEST_OTHER_ORG': str(second.org),
           'TEST_PERSON': str(first.editor), 'TEST_OTHER_PERSON': str(second.editor),
           'TEST_EMAIL': first.editor_handle, 'TEST_REPORT': str(tmp_path / 'hq-audit.json')}
    config = conninfo_to_dict(dsn('api'))
    config['database'] = config.pop('dbname')
    env['TEST_API_CONFIG'] = json.dumps(config)
    result = subprocess.run(['node', 'test/hq-audit-runner.mjs'], cwd=root / 'services/api',
                            env=env, text=True, capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout + '\n' + result.stderr
    assert json.loads((tmp_path / 'hq-audit.json').read_text())['ok'] is True
