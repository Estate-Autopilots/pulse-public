"""NEW-DOTS (1897): the red "new" dots. Each person's seen pages and their switch are theirs alone (row security on their
organisation and their own person); over HTTP each person is told only of changed pages they can open
(services/api/test/new-dots-runner.mjs). Synthetic data only."""
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


def add_note(owner):
    """As the release-notes generator would (it writes as the superuser; the table's owner stands in here)."""
    with owner.transaction():
        return owner.execute(
            """insert into pulse.release_note(sha, version, released_at, headline, items, please_check)
               values (%s, 'v0.0.1 · synthetic', '2099-01-01 10:00+05:30', 'Synthetic release: red dots', %s, %s) returning id""",
            (uuid.uuid4().hex + uuid.uuid4().hex[:8],
             Jsonb({'owner': [{'text': 'Synthetic: contracts list', 'href': '/contracts'}, {'text': 'Synthetic: audit', 'href': '/audit'}],
                    'salespeople': [{'text': 'Synthetic: quotes', 'href': '/erp/documents'}],
                    # An everyone line that links a page most people cannot open: only those who can see a dot.
                    'everyone': [{'text': 'Synthetic: tasks load faster', 'href': '/tasks'}, {'text': 'Synthetic: finance view', 'href': '/finance'}]}),
             Jsonb([{'text': 'Synthetic: open Tasks', 'href': '/tasks'}]))).fetchone()['id']


def drop_note(owner, note):
    with owner.transaction():
        owner.execute('delete from pulse.release_note where id=%s', (note,))


def test_seen_rows_are_each_persons_own(owner, api, worker):
    first, second = build_world(worker, owner, api), build_world(worker, owner, api)
    note = add_note(owner)
    try:
        with api.transaction():
            set_tenant(api, first.org, first.editor)
            api.execute("insert into pulse.release_seen(org_id, person_id, note_id, route) values (%s, %s, %s, '/tasks')", (first.org, first.editor, note))
            api.execute('insert into pulse.release_dots_pref(org_id, person_id, dots_on) values (%s, %s, false)', (first.org, first.editor))
        with api.transaction():
            set_tenant(api, first.org, first.editor)
            assert api.execute('select count(*) n from pulse.release_seen').fetchone()['n'] == 1
            assert api.execute('select dots_on from pulse.release_dots_pref').fetchone()['dots_on'] is False
        # A colleague in the same company, and anyone in another company, sees none of it.
        for org, person in ((first.org, first.editor2), (second.org, second.editor)):
            with api.transaction():
                set_tenant(api, org, person)
                assert api.execute('select count(*) n from pulse.release_seen').fetchone()['n'] == 0
                assert api.execute('select count(*) n from pulse.release_dots_pref').fetchone()['n'] == 0
        # Nobody writes a row for someone else, or for another company.
        for org, viewer, person in ((first.org, first.editor2, first.editor), (second.org, second.editor, first.editor)):
            with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
                set_tenant(api, org, viewer)
                api.execute("insert into pulse.release_seen(org_id, person_id, note_id, route) values (%s, %s, %s, '/chats')", (first.org, person, note))
        # A page address is plain: no query, no outside link.
        with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
            set_tenant(api, first.org, first.editor)
            api.execute("insert into pulse.release_seen(org_id, person_id, note_id, route) values (%s, %s, %s, 'https://example.invalid')", (first.org, first.editor, note))
        # Signed out (no viewer): nothing.
        with api.transaction():
            set_tenant(api, first.org)
            assert api.execute('select count(*) n from pulse.release_seen').fetchone()['n'] == 0
        # The other runtime roles never read or write it.
        for conn in (worker,):
            with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
                set_tenant(conn, first.org)
                conn.execute('select count(*) from pulse.release_seen')
    finally:
        drop_note(owner, note)
    # Removing a release removes its seen rows with it.
    with api.transaction():
        set_tenant(api, first.org, first.editor)
        assert api.execute('select count(*) n from pulse.release_seen').fetchone()['n'] == 0


def test_new_dots_http(api, owner, worker, auth_world):  # noqa: F811
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
        result = subprocess.run(['node', 'test/new-dots-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api', env=env,
                                capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
        assert 'NEW-DOTS OK' in result.stdout
    finally:
        drop_note(owner, note)


@pytest.mark.skipif(os.environ.get('PULSE_AUTH_BROWSER') != '1', reason='browser walk: set PULSE_AUTH_BROWSER=1')
def test_new_dots_in_the_browser(api, owner, worker, auth_world):  # noqa: F811
    """services/api/test/new-dots-browser-runner.mjs: the red dots for an owner at 1440 and a member at 363, before and
    after opening a changed page, What's new and Mark all as seen, the switch in Settings, reduced motion
    (PULSE_ND_SCREENSHOTS=<dir> keeps the shots)."""
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))
    with owner.transaction():
        note = owner.execute(
            """insert into pulse.release_note(sha, version, released_at, headline, items, please_check)
               values (%s, 'v0.0.1 · synthetic', now() - interval '1 hour', 'Synthetic release: red dots', %s, '[]') returning id""",
            (uuid.uuid4().hex + uuid.uuid4().hex[:8],
             Jsonb({'owner': [{'text': 'Synthetic: contracts list', 'href': '/contracts'}, {'text': 'Synthetic: settings tidy', 'href': '/settings'}],
                    'everyone': [{'text': 'Synthetic: tasks load faster', 'href': '/tasks'}, {'text': 'Synthetic: docs open faster', 'href': '/docs'}]}))).fetchone()['id']
    try:
        config = conninfo_to_dict(dsn('api'))
        config['database'] = config.pop('dbname')
        env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
        result = subprocess.run(['node', 'test/new-dots-browser-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                                env=env, capture_output=True, text=True, timeout=1800)
        assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-4000:]
        assert 'checks passed' in result.stdout
    finally:
        drop_note(owner, note)


def test_seen_anchor_rows(owner, api, worker):
    """NEW-DOTS-2 (1898): a thing reached on a page is its own row beside the page's; its id is a plain id."""
    w = build_world(worker, owner, api)
    note = add_note(owner)
    try:
        with api.transaction():
            set_tenant(api, w.org, w.editor)
            api.execute("insert into pulse.release_seen(org_id, person_id, note_id, route) values (%s, %s, %s, '/tasks')", (w.org, w.editor, note))
            api.execute("insert into pulse.release_seen(org_id, person_id, note_id, route, anchor) values (%s, %s, %s, '/tasks', 'work.new-task')", (w.org, w.editor, note))
            assert api.execute("select count(*) n from pulse.release_seen").fetchone()['n'] == 2
        for bad in ('nav:/tasks', 'Work.New', ' work', 'x' * 81):
            with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
                set_tenant(api, w.org, w.editor)
                api.execute("insert into pulse.release_seen(org_id, person_id, note_id, route, anchor) values (%s, %s, %s, '/tasks', %s)", (w.org, w.editor, note, bad))
        with api.transaction():
            set_tenant(api, w.org, w.editor2)
            assert api.execute('select count(*) n from pulse.release_seen').fetchone()['n'] == 0
    finally:
        drop_note(owner, note)


@pytest.mark.skipif(os.environ.get('PULSE_AUTH_BROWSER') != '1', reason='browser walk: set PULSE_AUTH_BROWSER=1')
def test_new_dots_trail_in_the_browser(api, owner, worker, auth_world):  # noqa: F811
    """NEW-DOTS-2: services/api/test/new-dots-trail-runner.mjs: from the rail down to the button (the counts on each level,
    "take me there", the spotlight tour through a menu, Got it, What's new's Show me), owner at 1440 and member at 363
    (PULSE_ND_SCREENSHOTS=<dir> keeps the shots and a video of each walk)."""
    w = auth_world
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute('update pulse.login_credential set must_change=false where org_id=%s', (w.org,))
    with owner.transaction():
        note = owner.execute(
            """insert into pulse.release_note(sha, version, released_at, headline, items, please_check)
               values (%s, 'v0.0.2 · synthetic', now() - interval '1 hour', 'Synthetic release: dots that lead', %s, '[]') returning id""",
            (uuid.uuid4().hex + uuid.uuid4().hex[:8],
             Jsonb({'everyone': [{'text': 'Start a task from a template: pick one when you add a task (synthetic)', 'href': '/tasks', 'anchor': 'work.new-task'},
                                 {'text': 'The pool now puts the tasks due soonest at the top (synthetic)', 'href': '/tasks', 'anchor': 'work.more.pool'},
                                 {'text': 'Chats open faster (synthetic)', 'href': '/chats'}]}))).fetchone()['id']
    try:
        config = conninfo_to_dict(dsn('api'))
        config['database'] = config.pop('dbname')
        env = {**os.environ, 'TEST_API_CONFIG': json.dumps(config), 'PULSE_CI': '1', 'PULSE_PUBLIC_LOGIN_ENABLED': '1', 'PULSE_AUTH_MAIL_MODE': 'sink'}
        result = subprocess.run(['node', 'test/new-dots-trail-runner.mjs'], cwd=Path(__file__).resolve().parents[2] / 'services/api',
                                env=env, capture_output=True, text=True, timeout=1800)
        assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-4000:]
        assert 'checks passed' in result.stdout
    finally:
        drop_note(owner, note)
