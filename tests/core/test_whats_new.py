"""RELEASE-COMMS (1844): release notes are global and read-only for every runtime role; each person reads only their
audiences' parts over HTTP (services/api/test/whats-new-runner.mjs). Synthetic data only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_account_security import auth_world as auth_world  # noqa: F401

# A real 8x10 JPEG (a plain blue tile) so the browser can draw it.
JPEG = ('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAKAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDCooor0zzj/9k=')


def add_note(owner, headline='Synthetic release: faster task lists', when='2099-01-01 10:00+05:30'):
    """As the release-notes generator would (it writes as the superuser; the table's owner stands in here)."""
    with owner.transaction():
        return owner.execute(
            """insert into pulse.release_note(sha, version, released_at, headline, items, please_check, known_issues, share)
               values (%s, 'v0.0.1 · synthetic', %s, %s, %s, %s, %s, %s) returning id""",
            (uuid.uuid4().hex + uuid.uuid4().hex[:8], when, headline,
             Jsonb({'owner': [{'text': 'Synthetic: billing totals', 'href': '/erp'}],
                    'salespeople': [{'text': 'Synthetic: quotes', 'href': '/erp/documents'}],
                    'everyone': [{'text': 'Synthetic: tasks load faster', 'href': '/tasks'}]}),
             Jsonb([{'text': 'Synthetic: open Tasks', 'href': '/tasks'},
                    {'text': 'Synthetic: check a bill', 'href': '/erp', 'audience': 'owner'}]),
             Jsonb(['Synthetic known issue']),
             Jsonb({'owner': {'text': 'Synthetic owner text', 'image': JPEG},
                    'salespeople': {'text': 'Synthetic sales text', 'image': JPEG},
                    'everyone': {'text': 'Synthetic everyone text', 'image': JPEG}}))).fetchone()['id']


def drop_note(owner, note):
    with owner.transaction():
        owner.execute('delete from pulse.release_note where id=%s', (note,))


def test_release_notes_are_global_and_read_only(owner, api, worker, ingest, privacy):
    first, second = build_world(worker, owner, api), build_world(worker, owner, api)
    note = add_note(owner)
    try:
        # Every company's signed-in people read the same note, only their audiences' parts.
        for w in (first, second):
            with api.transaction():
                set_tenant(api, w.org, w.editor)
                notes = api.execute("select pulse.release_notes('vitals', array['everyone'], 20) r").fetchone()['r']
            mine = next(n for n in notes if n['id'] == note)
            assert set(mine['items']) == {'everyone'} and set(mine['share']) == {'everyone'}
            assert 'data:image' not in json.dumps(notes)
            with api.transaction():
                set_tenant(api, w.org, w.editor)
                assert api.execute("select pulse.release_note_card(%s, 'everyone') d", (note,)).fetchone()['d'] == JPEG
        # Signed out (no viewer): nothing.
        with api.transaction():
            set_tenant(api, first.org)
            assert api.execute("select pulse.release_notes('vitals', array['everyone'], 20) r").fetchone()['r'] == []
            assert api.execute("select pulse.release_note_card(%s, 'everyone') d", (note,)).fetchone()['d'] is None
        # No runtime role reads or writes the table itself.
        for conn in (api, worker, ingest, privacy):
            for sql, args in [('select count(*) from pulse.release_note', ()),
                              ("insert into pulse.release_note(sha, released_at, headline) values (%s, now(), 'x')", ('f' * 40,)),
                              ("update pulse.release_note set headline='changed' where id=%s", (note,)),
                              ('delete from pulse.release_note where id=%s', (note,))]:
                with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
                    set_tenant(conn, first.org)
                    conn.execute(sql, args)
    finally:
        drop_note(owner, note)


def test_whats_new_http(api, owner, worker, auth_world):  # noqa: F811
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'sales','2020-01-01')", (w.org, w.editor2))
    note = add_note(owner)
    try:
        config = conninfo_to_dict(dsn('api'))
        config['database'] = config.pop('dbname')
        env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_NOTE_ID': str(note), 'PULSE_CI': '1',
               'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
        result = subprocess.run(['node', 'test/whats-new-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env,
                                capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
        assert 'WHATS-NEW OK' in result.stdout
    finally:
        drop_note(owner, note)


@pytest.mark.skipif(os.environ.get('PULSE_AUTH_BROWSER') != '1', reason='browser walk: set PULSE_AUTH_BROWSER=1')
def test_whats_new_in_the_browser(api, owner, worker, auth_world):  # noqa: F811
    """services/api/test/whats-new-browser-runner.mjs: /whats-new for an owner and a member at 1440 and 390, light and
    dark, the "was updated" note and the account menu link (PULSE_WN_SCREENSHOTS=<dir> keeps the shots)."""
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))
    note = add_note(owner)
    try:
        config = conninfo_to_dict(dsn('api'))
        config['database'] = config.pop('dbname')
        env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'TEST_NOTE_ID': str(note), 'PULSE_CI': '1',
               'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
        result = subprocess.run(['node', 'test/whats-new-browser-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                                env=env, capture_output=True, text=True, timeout=1800)
        assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-4000:]
    finally:
        drop_note(owner, note)
