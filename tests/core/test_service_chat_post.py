"""EST-1555: synthetic install-local AI chat posting through the existing membership and outbox paths."""
from concurrent.futures import ThreadPoolExecutor

import hashlib
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from psycopg.rows import dict_row
from conftest import dsn
from test_agent_coworkers import make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401

PNG = bytes.fromhex('89504e470d0a1a0a') + b'synthetic-image'
DIGEST = hashlib.sha256(b'synthetic-service-secret').hexdigest()


def setup_chat(api, w):
    agent, _ = make_agent(api, w, 'updates-agent')
    chat = one(api, w, w.manager, "select pulse.chat_group_create('Synthetic updates',%s) id", ([w.editor],))['id']
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (chat, agent))
    key = uuid.uuid4()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic updates',%s)", (key, DIGEST, ['chats.post'], agent))
    return agent, chat, key


def post(api, key, chat, slot='2026-10-18-am', text='Synthetic update', name='card.png', mime='image/png', image=PNG, auth=True):
    with api.transaction():
        if auth:
            assert api.execute("select pulse.service_key_auth(%s,%s,'chats.post') ok", (key, DIGEST)).fetchone()['ok']
        return api.execute('select pulse.service_chat_post(%s,%s,%s,%s,%s,%s,%s) r', (key, chat, slot, text, name, mime, image)).fetchone()['r']


def test_chat_slot_attachment_and_normal_notifications(api, worker, owner, team):  # noqa: F811
    w = team
    agent, chat, key = setup_chat(api, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        for person in [w.manager, w.editor]:
            worker.execute("insert into pulse.web_push_subscription(org_id,person_id,endpoint,keys,created_at) values(%s,%s,%s,'{}',clock_timestamp()-interval '1 hour')", (w.org, person, f'https://fcm.googleapis.com/fcm/send/{person}'))
    first = post(api, key, chat)
    assert set(first) == {'messageId', 'chatId', 'replayed'} and first['replayed'] is False
    assert post(api, key, chat) == {**first, 'replayed': True}
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute('select count(*) n from pulse.chat_message where id=%s', (first['messageId'],)).fetchone()['n'] == 1
        notices = worker.execute('select person_id,title,priority,quiet from pulse.notification where message_id=%s', (first['messageId'],)).fetchall()
        assert {n['person_id'] for n in notices} == {w.manager, w.editor}
        assert all(n['title'] == 'New message in Chats' for n in notices)
        # ATT (0860, 21 Oct 2026): a message in a group conversation is for-your-information: it waits in the bell,
        # quiet, and is never pushed (no web delivery), unless it mentions or replies to the person.
        assert all(n['priority'] == 'fyi' and n['quiet'] for n in notices)
        for _ in range(2):
            worker.execute("select pulse.notification_outbox_seed('web')")
        deliveries = worker.execute('select n.person_id from pulse.notification_delivery d join pulse.notification n on n.id=d.notification_id where n.message_id=%s', (first['messageId'],)).fetchall()
        assert deliveries == []
    assert owner_sql(owner, w, 'select count(*) n from pulse_priv.chat_file where channel_id=%s', (chat,))[0]['n'] == 1
    message = one(api, w, w.manager, "select p.side='agent' ai, m.attachments from pulse.chat_message m join pulse.person p on p.id=m.author_id where m.id=%s", (first['messageId'],))
    assert message['ai'] is True and len(message['attachments']) == 1
    other = one(api, w, w.manager, "select pulse.chat_group_create('Another updates group',%s) id", ([w.editor],))['id']
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (other, agent))
    for kwargs in [{'text': 'Changed'}, {'image': PNG + b'changed'}, {'chat': other}]:
        with pytest.raises(psycopg.errors.UniqueViolation):
            post(api, key, kwargs.pop('chat', chat), **kwargs)
    assert post(api, key, chat, slot='2026-10-18-pm', name=None, mime=None, image=None)['replayed'] is False


def test_scope_membership_revocation_and_disabled_agent(api, worker, owner, team):  # noqa: F811
    w = team
    agent, chat, key = setup_chat(api, w)
    outside = one(api, w, w.manager, 'select pulse.chat_direct(%s) id', (w.editor,))['id']
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        post(api, key, outside)
    for args in [(key, outside), (uuid.uuid4(), chat)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            post(api, *args, auth=False)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        post(api, key, chat, auth=False)
    post(api, key, chat)
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,false)", (chat, agent))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        post(api, key, chat)  # replay is forbidden after removal too
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (chat, agent))
    one(api, w, w.manager, 'select pulse.agent_switch(%s,false)', (agent,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        post(api, key, chat)
    one(api, w, w.manager, 'select pulse.agent_switch(%s,true)', (agent,))
    api.execute("select pulse.service_key_manage('revoke',%s)", (key,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        post(api, key, chat, auth=False)


def test_key_binding_and_sql_image_validation(api, worker, owner, team):  # noqa: F811
    w = team
    agent, chat, key = setup_chat(api, w)
    for scopes, binding in [(['chats.post'], None), (['catalog.read'], agent)]:
        with pytest.raises(psycopg.errors.CheckViolation), api.transaction():
            api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic',%s)", (uuid.uuid4(), DIGEST, scopes, binding))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Synthetic',%s)", (uuid.uuid4(), DIGEST, ['chats.post'], w.manager))
    for kwargs in [{'image': PNG + b'x' * 2097152}, {'mime': 'image/gif'}, {'mime': 'image/jpeg'}, {'slot': '2026-02-30-am'}]:
        with pytest.raises((psycopg.errors.InvalidParameterValue, psycopg.errors.DatetimeFieldOverflow)):
            post(api, key, chat, **kwargs)


def test_concurrent_retries_across_rotated_keys(api, worker, owner, team):  # noqa: F811
    agent, chat, key = setup_chat(api, team)
    rotated = uuid.uuid4()
    api.execute("select pulse.service_key_manage('issue',%s,%s,%s,'Rotated updates',%s)", (rotated, DIGEST, ['chats.post'], agent))

    def retry(key_id):
        with psycopg.connect(dsn('api'), autocommit=True, row_factory=dict_row) as connection:
            return post(connection, key_id, chat)

    with ThreadPoolExecutor(max_workers=2) as threads:
        results = list(threads.map(retry, [key, rotated]))
    assert sorted(r['replayed'] for r in results) == [False, True]
    assert results[0]['messageId'] == results[1]['messageId']
    assert owner_sql(owner, team, 'select count(*) n from pulse_priv.chat_file where channel_id=%s', (chat,))[0]['n'] == 1
