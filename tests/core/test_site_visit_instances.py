"""EST-2258: real Postgres visit persistence, synthetic tenants only; no routes/media in this slice."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from helpers import build_world
from pulse_sdk.db import set_tenant


@pytest.fixture
def visits(worker, owner, api):
    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    for world in (w, other):
        world.customer = uuid.uuid4()
        with worker.transaction():
            set_tenant(worker, world.org)
            worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic Customer')", (world.customer, world.org))
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2026-01-01')", (world.org, world.manager))
    return w, other


def create(api, w, person=None, **values):
    with api.transaction():
        set_tenant(api, w.org, person or w.manager)
        return api.execute("select pulse.site_visit_create(%s,%s,%s,%s) id", (values.get('customer', w.customer), values.get('type', 'survey'), values.get('assignee'), values.get('notes', ''))).fetchone()['id']


def rows(c, w, table='site_visit'):
    with c.transaction():
        set_tenant(c, w.org, w.manager)
        return c.execute(f"select * from pulse.{table} where org_id=%s", (w.org,)).fetchall()


def settings(api, w, version, fields):
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.site_visit_settings_save(%s,%s)", (version, Jsonb({'visitTypes': [{'key': 'survey', 'state': 'active'}], 'fields': fields, 'banner': {}})))


def test_repeat_visits_virtual_and_persisted_snapshots(api, visits):
    w, other = visits
    first, second = create(api, w), create(api, w, notes='x' * 4000, assignee=w.editor)
    assert first != second and {v['field_set_version'] for v in rows(api, w)} == {1}
    assert all(v['starting_fields'] == [] and v['created_by'] == w.manager and v['created_at'] for v in rows(api, w))
    assert next(v for v in rows(api, w) if v['id'] == second)['assigned_person_id'] == w.editor
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert api.execute('select count(*) n from pulse.site_visit_field_set').fetchone()['n'] == 0
    f = dict(key='roof', label='Roof', hint=None, exampleImageId=None, required=True, maxPhotos=6, position=0, state='active', appliesTo=None)
    settings(api, w, 1, [f, {**f, 'key': 'hidden', 'state': 'hidden'}, {**f, 'key': 'other_type', 'appliesTo': ['service']}])
    third = create(api, w)
    settings(api, w, 2, [{**f, 'label': 'Renamed', 'state': 'archived'}, {**f, 'key': 'hidden', 'state': 'archived'}, {**f, 'key': 'other_type', 'appliesTo': ['service']}, {**f, 'key': 'later'}])
    saved = next(v for v in rows(api, w) if v['id'] == third)
    assert saved['starting_fields'] == [f] and saved['field_set_version'] == 2
    assert next(v for v in rows(api, w) if v['id'] == first)['starting_fields'] == []
    fourth = create(api, w)
    assert next(v for v in rows(api, w) if v['id'] == fourth)['starting_fields'] == [{**f, 'key': 'later'}]
    assert rows(api, other) == [] and rows(api, other, 'site_visit_history') == []
    h = rows(api, w, 'site_visit_history')
    assert len(h) == 4 and all(r['action'] == 'visit_created' and r['actor_id'] == w.manager and r['at'] and r['to_value'] is None for r in h)


def test_untrusted_mutation_and_invalid_links(api, owner, visits):
    w, other = visits
    vid = create(api, w)
    for sql in [
        "update pulse.site_visit set starting_fields='[]'", 'delete from pulse.site_visit',
        'insert into pulse.site_visit select * from pulse.site_visit',
        'truncate pulse.site_visit_history', 'delete from pulse.site_visit_history',
        'insert into pulse.site_visit_history select * from pulse.site_visit_history',
        "update pulse.site_visit_history set actor_id=gen_random_uuid()",
        "insert into pulse.site_visit_field_note(org_id,visit_id,field_key,notes) values(pulse.current_org(),gen_random_uuid(),'roof','')",
    ]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute(sql)
    for kwargs in [dict(customer=other.customer), dict(assignee=other.editor), dict(customer=uuid.uuid4()), dict(type='missing'), dict(notes='x' * 4001)]:
        with pytest.raises(psycopg.Error):
            create(api, w, **kwargs)
    for person in (w.editor, other.manager):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            create(api, w, person=person)
    with pytest.raises(psycopg.errors.UndefinedFunction), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.site_visit_create(p_customer => %s,p_type => 'survey',p_actor => %s)", (w.customer, other.manager))
    for column, value in [('starting_fields', Jsonb([{'key': 'forged'}])), ('customer_id', other.customer), ('created_by', other.manager)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), owner.transaction():
            set_tenant(owner, w.org)
            owner.execute(f"update pulse.site_visit set {column}=%s where id=%s", (value, vid))
    with api.transaction():
        set_tenant(api, other.org, other.manager)
        assert api.execute("select count(*) n from pulse.site_visit where id=%s", (vid,)).fetchone()['n'] == 0


def test_storage_bounds_associations_and_audit_retention(api, owner, visits):
    w, other = visits
    vid = create(api, w)
    def write(sql, params=()):
        with owner.transaction():
            set_tenant(owner, w.org)
            return owner.execute(sql, params)
    write("insert into pulse.site_visit_field_note values(%s,%s,'roof',%s)", (w.org, vid, 'x' * 2000))
    with pytest.raises(psycopg.errors.CheckViolation):
        write("update pulse.site_visit_field_note set notes=%s where visit_id=%s", ('x' * 2001, vid))
    for sql, params in [("update pulse.site_visit set notes=%s where id=%s", ('x' * 4001, vid)), ("update pulse.site_visit set status='submitted',submitted_by=%s where id=%s", (w.manager, vid)), ("update pulse.site_visit set submitted_at=now() where id=%s", (vid,))]:
        with pytest.raises(psycopg.errors.CheckViolation):
            write(sql, params)
    for assignment, params in [
        ("assigned_person_id=%s,submitted_by=%s,status='submitted',submitted_at=now()", (other.editor, w.manager, vid)),
        ("submitted_by=%s,status='submitted',submitted_at=now()", (other.editor, vid)),
    ]:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            write(f"update pulse.site_visit set {assignment} where id=%s", params)
    for actor, action, value, error in [(other.manager, 'photo_deleted', '', psycopg.errors.ForeignKeyViolation), (w.manager, 'location_removed', '', psycopg.errors.CheckViolation), (w.manager, 'visit_notes_changed', 'x' * 4001, psycopg.errors.CheckViolation)]:
        with pytest.raises(error):
            write("insert into pulse.site_visit_history(org_id,visit_id,actor_id,action,to_value) values(%s,%s,%s,%s,%s)", (w.org, vid, actor, action, value))
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        write("insert into pulse.site_visit_field_note values(%s,%s,'roof','')", (w.org, uuid.uuid4()))
    for customer, creator in [(other.customer, w.manager), (w.customer, other.manager)]:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            write("insert into pulse.site_visit(org_id,customer_id,type_key,field_set_version,starting_fields,assigned_person_id,created_by) values(%s,%s,'survey',1,'[]',%s,%s)", (w.org, customer, w.manager, creator))
    photo = uuid.uuid4()
    write("insert into pulse.site_visit_history(org_id,visit_id,actor_id,action,photo_id) values(%s,%s,%s,'photo_purged',%s)", (w.org, vid, w.manager, photo))
    assert any(h['photo_id'] == photo for h in rows(api, w, 'site_visit_history'))
    for sql in ("delete from pulse.site_visit_history", "update pulse.site_visit_history set from_value='forged'"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            write(sql)


def test_history_failure_rolls_back_create(api, owner, visits):
    w, _ = visits
    with owner.transaction():
        owner.execute("create function pg_temp.reject_visit_history() returns trigger language plpgsql as $$ begin raise exception 'synthetic history failure' using errcode='23514'; end $$")
        owner.execute("create trigger reject_test_history before insert on pulse.site_visit_history for each row execute function pg_temp.reject_visit_history()")
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            create(api, w)
        assert rows(api, w) == [] and rows(api, w, 'site_visit_history') == []
    finally:
        with owner.transaction():
            owner.execute("drop trigger reject_test_history on pulse.site_visit_history")


def query(c, w, person, sql, params=()):
    with c.transaction():
        set_tenant(c, w.org, person)
        return c.execute(sql, params).fetchall() if sql.lstrip().startswith('select') else c.execute(sql, params).rowcount


def test_after_closing_binding_entitlement_and_tamper(api, owner, visits):
    w, other = visits
    def bind(person):
        return query(api, w, w.manager, 'update pulse.client set after_closing_person_id=%s where id=%s', (person, w.customer))
    assert query(api, w, w.manager, 'select after_closing_person_id p from pulse.client where id=%s', (w.customer,)) == [{'p': None}]
    query(api, w, w.manager, 'update pulse.client set relationship_owner_id=%s where id=%s', (w.editor, w.customer))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        create(api, w, person=w.editor)  # Relationship ownership alone grants nothing.
    assert query(api, w, w.editor, 'update pulse.client set after_closing_person_id=%s where id=%s', (w.editor, w.customer)) == 0
    assert query(api, w, w.manager, 'select after_closing_person_id p from pulse.client where id=%s', (w.customer,)) == [{'p': None}]
    for person in (other.editor, uuid.uuid4()):
        with pytest.raises(psycopg.Error):
            bind(person)
    query(owner, w, None, "update pulse.person set side='client' where id=%s", (w.editor2,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        bind(w.editor2)
    query(owner, w, None, "update pulse.person set side='staff',status='inactive' where id=%s", (w.editor2,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        bind(w.editor2)
    bind(w.editor)
    vid = create(api, w, person=w.editor)
    saved = next(v for v in rows(api, w) if v['id'] == vid)
    assert saved['assigned_person_id'] == saved['created_by'] == w.editor
    assert next(h for h in rows(api, w, 'site_visit_history') if h['visit_id'] == vid)['actor_id'] == w.editor
    for kwargs in [dict(assignee=w.manager), dict(customer=other.customer)]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            create(api, w, person=w.editor, **kwargs)
    second = uuid.uuid4()
    query(api, w, w.manager, "insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic second customer')", (second, w.org))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        create(api, w, person=w.editor, customer=second)
    for binding in (w.lead, None):
        bind(binding)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            create(api, w, person=w.editor)
    bind(w.editor)
    query(owner, w, None, "update pulse.person set status='inactive' where id=%s", (w.editor,))
    query(api, w, w.manager, "update pulse.client set notes='Binding retained' where id=%s", (w.customer,))
    assert query(api, w, w.manager, 'select after_closing_person_id p from pulse.client where id=%s', (w.customer,)) == [{'p': w.editor}]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        create(api, w, person=w.editor)
    assert len(rows(api, w)) == len(rows(api, w, 'site_visit_history')) == 1


def test_leadership_owner_history_and_hr_refusal(api, owner, visits):
    w, _ = visits
    for person, role in [(w.lead, 'leadership'), (w.editor2, 'hr')]:
        query(owner, w, None, "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2026-01-01')", (w.org, person, role))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            create(api, w, person=person)
        query(api, w, w.manager, 'update pulse.client set after_closing_person_id=%s where id=%s', (person, w.customer))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            create(api, w, person=person, assignee=w.editor)
    query(api, w, w.manager, 'update pulse.client set after_closing_person_id=%s where id=%s', (w.lead, w.customer))
    own = create(api, w, person=w.lead)
    create(api, w)
    assert len(query(api, w, w.lead, 'select visit_id from pulse.site_visit_history')) == 2
    query(owner, w, None, "update pulse.site_visit set status='submitted',submitted_by=%s,submitted_at=now() where id=%s", (w.manager, own))
    assert len(query(api, w, w.lead, 'select * from pulse.site_visit_history')) == 2
    assert query(api, w, w.editor2, 'select * from pulse.site_visit') == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        create(api, w, person=w.editor2)
    assert len(rows(api, w, 'site_visit_history')) == 2
