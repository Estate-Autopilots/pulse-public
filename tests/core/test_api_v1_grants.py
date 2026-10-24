"""EST-1788 (0670): API v1 area grants on psvc_ and pak_ keys and the two database-checked principals. Grants are
explicit (none by default, no legacy alias); a principal is always the key's active AI member with agent_session on,
never a staff viewer. Synthetic only."""
import re
import uuid
from pathlib import Path

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_agent_coworkers import as_agent, make_agent, owner_sql
from test_service_chat_post import DIGEST, post, setup_chat
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

V1 = [f'{area}.{mode}' for area in ['tasks', 'projects', 'people', 'chats', 'docs', 'billing', 'workflows', 'companies', 'search', 'events']
      for mode in ['read', 'write']]
SERVICE = 'select pulse.v1_service_principal(%s,%s,%s) p'
AGENT = 'select pulse.v1_agent_principal(%s,%s) p'
REFUSED = {'viewer': None, 'session': None, 'actor': None, 'ai': None}


def principal(api, org, sql, args, viewer=None):
    """A request transaction as the API's `open` starts it (tenant set, no viewer): the result and what it left set."""
    with api.transaction():
        set_tenant(api, org, viewer)
        p = api.execute(sql, args).fetchone()['p']
        return p, api.execute("""select nullif(current_setting('pulse.viewer_id',true),'')::uuid viewer,
            nullif(current_setting('pulse.agent_session',true),'') session, nullif(current_setting('pulse.actor_account',true),'') actor,
            pulse.agent_session() ai""").fetchone()


def test_one_v1_scope_set_in_sql_and_typescript(api):
    assert api.execute('select pulse.v1_scopes() s').fetchone()['s'] == V1
    source = (Path(__file__).resolve().parents[2] / 'services/api/src/service-key.ts').read_text()
    block = re.search(r'V1_SCOPES = \[(.*?)\] as const', source, re.S).group(1)
    assert re.findall(r"'([^']+)'", block) == V1
    assert not {'chats.post', 'catalog.read'} & set(V1)


def test_v1_service_principal(api, worker, owner, ingest, privacy, team):  # noqa: F811
    w, other = team, build_world(worker, owner, api)
    agent, chat, legacy = setup_chat(api, w)
    issue = "select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic app',%s)"
    for scopes in [['tasks.read'], ['catalog.read', 'billing.read'], ['tasks.admin'], ['tasks.read', None]]:
        with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
            api.execute(issue, (uuid.uuid4(), DIGEST, scopes, None))  # unbound, unknown or null
    key, reader = uuid.uuid4(), uuid.uuid4()
    api.execute(issue, (key, DIGEST, ['tasks.read', 'chats.read'], agent))
    api.execute(issue, (reader, DIGEST, ['catalog.read'], None))
    assert principal(api, w.org, SERVICE, (key, DIGEST, 'tasks.read')) == (
        agent, {'viewer': agent, 'session': 'on', 'actor': f'service:{key}', 'ai': agent})
    for args in [(key, DIGEST, 'tasks.write'), (key, DIGEST, 'catalog.read'), (key, '0' * 64, 'tasks.read'), (key, DIGEST, None),
                 (reader, DIGEST, 'billing.read'), (legacy, DIGEST, 'chats.write'), (legacy, DIGEST, 'chats.post')]:
        assert principal(api, w.org, SERVICE, args) == (None, REFUSED)
    assert principal(api, other.org, SERVICE, (key, DIGEST, 'tasks.read')) == (None, REFUSED)  # another company's address
    p, ctx = principal(api, w.org, SERVICE, (key, DIGEST, 'tasks.read'), viewer=w.manager)
    assert p is None and ctx['viewer'] == w.manager and ctx['ai'] is None  # never on top of a staff viewer
    one(api, w, w.manager, 'select pulse.agent_switch(%s,false)', (agent,))
    assert principal(api, w.org, SERVICE, (key, DIGEST, 'tasks.read')) == (None, REFUSED)
    one(api, w, w.manager, 'select pulse.agent_switch(%s,true)', (agent,))
    assert principal(api, w.org, SERVICE, (key, DIGEST, 'chats.read'))[0] == agent
    # The existing chats.post key still posts exactly as before.
    assert post(api, legacy, chat)['replayed'] is False
    api.execute("select pulse.service_key_manage('revoke',%s)", (key,))
    assert principal(api, w.org, SERVICE, (key, DIGEST, 'tasks.read')) == (None, REFUSED)
    for connection in [worker, ingest, privacy]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
            connection.execute(SERVICE, (key, DIGEST, 'tasks.read'))


def test_v1_agent_principal(api, worker, owner, ingest, privacy, team):  # noqa: F811
    w, other = team, build_world(worker, owner, api)
    agent, old = make_agent(api, w, 'v1-agent')
    issue = 'select pulse.agent_key_issue(%s,%s,%s,%s) k'
    key = one(api, w, w.manager, issue, (agent, 'v1', 30, ['tasks.read', 'chats.read']))['k']
    for who, scopes, error in [(w.editor, ['tasks.read'], psycopg.errors.InsufficientPrivilege), (w.manager, ['chats.post'], psycopg.errors.CheckViolation),
                               (w.manager, [None], psycopg.errors.CheckViolation), (w.manager, None, psycopg.errors.NotNullViolation)]:
        with pytest.raises(error):
            as_(api, w, who, issue, (agent, 'bad', 30, scopes))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, issue, (agent, 'self', 30, ['tasks.read']))
    fields = owner_sql(owner, w, "select fields from pulse.audit_event where action='agent_key_issued' and resource_id=%s", (key[4:12],))
    assert fields == [{'fields': ['tasks.read', 'chats.read']}]
    assert principal(api, w.org, AGENT, (key, 'tasks.read')) == (
        agent, {'viewer': agent, 'session': 'on', 'actor': 'agent:v1-agent', 'ai': agent})
    # An existing key has no v1 grant, and its /api/v0/agent/* resolution is unchanged.
    for args in [(old, 'tasks.read'), (key, 'tasks.write'), (key, 'chats.post'), (key, None), ('pak_' + key[4:12] + '_' + '0' * 64, 'tasks.read')]:
        assert principal(api, w.org, AGENT, args) == (None, REFUSED)
    assert one(api, w, None, 'select pulse.agent_key_resolve(%s) id', (old,))['id'] == agent
    assert principal(api, other.org, AGENT, (key, 'tasks.read')) == (None, REFUSED)
    assert principal(api, w.org, AGENT, (key, 'tasks.read'), viewer=w.manager)[0] is None
    one(api, w, w.manager, 'select pulse.agent_switch(%s,false)', (agent,))
    assert principal(api, w.org, AGENT, (key, 'tasks.read')) == (None, REFUSED)
    one(api, w, w.manager, 'select pulse.agent_switch(%s,true)', (agent,))
    owner_sql(owner, w, "update pulse_priv.agent_key set expires_at=now()-interval '1 second' where prefix=%s", (key[4:12],))
    assert principal(api, w.org, AGENT, (key, 'tasks.read')) == (None, REFUSED)
    revoked = one(api, w, w.manager, issue, (agent, 'revoked', 30, ['tasks.read']))['k']
    one(api, w, w.manager, 'select pulse.agent_key_revoke(%s)', (revoked[4:12],))
    assert principal(api, w.org, AGENT, (revoked, 'tasks.read')) == (None, REFUSED)
    for connection in [worker, ingest, privacy]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
            connection.execute(AGENT, (key, 'tasks.read'))
