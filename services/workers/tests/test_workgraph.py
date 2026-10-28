from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

from pulse_workers.workgraph import WorkGraph

MAP_PERSON = uuid.UUID("00000000-0000-0000-0000-000000000001")
CONFIRMED_PERSON = uuid.UUID("00000000-0000-0000-0000-000000000002")
WHEN = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)


class _Connection:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))


def test_projector_confirmation_outside_eligibility_beats_account_map():
    graph = WorkGraph()
    graph.conn = _Connection()
    graph.org = uuid.uuid4()
    graph.ev = SimpleNamespace(tx="1", seq=2, time=WHEN)
    graph.ids = SimpleNamespace(
        person_for=lambda _actor, _when: SimpleNamespace(kind="account", person_id=MAP_PERSON, shared=False),
        account_person=lambda _provider, _handle, _when: MAP_PERSON,
    )
    graph._one = lambda _sql, _params=(): {"seq": 1, "time": WHEN, "actor": "account:google:synthetic@example.test",
                                           "data": {}}

    def events(sql, _params=()):
        if "attribution.confirmed" in sql:
            return [{"seq": 3, "type": "attribution.confirmed",
                     "data": {"person_ref": f"person:pulse:{CONFIRMED_PERSON}"}}]
        return []

    graph._all = events
    graph._candidates = lambda _kind, _when: {MAP_PERSON}
    # The explicit confirmation refers to a person outside the role candidate set.
    graph._eligible = lambda _people: {MAP_PERSON}
    graph._on_leave = lambda _people, _when: set()

    graph._attribute(
        {"id": uuid.uuid4(), "md5": None, "cid": None, "task_id": None, "version_no": 1,
         "deliverable_type": "unknown"},
        {"store_id": "synthetic-file", "parent_store_id": None, "name": "synthetic.mp4", "cid": None},
    )

    insert_params = graph.conn.calls[0][1]
    assert insert_params[3] == CONFIRMED_PERSON
    assert insert_params[5] == "declared"
    stored = insert_params[7].obj
    assert stored[0]["how"] == "confirmation"
    assert str(CONFIRMED_PERSON) not in json.dumps(stored)


def test_projector_persists_mapped_account_how_with_opaque_evidence():
    graph = WorkGraph()
    graph.conn = _Connection()
    graph.org = uuid.uuid4()
    graph.ev = SimpleNamespace(tx="1", seq=2, time=WHEN)
    graph.ids = SimpleNamespace(
        person_for=lambda _actor, _when: SimpleNamespace(kind="account", person_id=MAP_PERSON, shared=False),
        account_person=lambda _provider, _handle, _when: MAP_PERSON,
    )
    graph._one = lambda _sql, _params=(): {"seq": 1, "time": WHEN,
        "actor": "account:google:synthetic@example.test", "data": {}}
    graph._all = lambda _sql, _params=(): []
    graph._candidates = lambda _kind, _when: {MAP_PERSON}
    graph._eligible = lambda people: people
    graph._on_leave = lambda _people, _when: set()

    graph._attribute(
        {"id": uuid.uuid4(), "md5": None, "cid": None, "task_id": None, "version_no": 1,
         "deliverable_type": "unknown"},
        {"store_id": "synthetic-file", "parent_store_id": None, "name": "synthetic.mp4", "cid": None},
    )

    params = graph.conn.calls[0][1]
    assert params[3] == MAP_PERSON and params[5] == "evidence"
    evidence = params[7].obj
    assert evidence[0]["group"] == "account_map" and evidence[0]["how"] == "account map"
    assert str(MAP_PERSON) not in json.dumps(evidence)
