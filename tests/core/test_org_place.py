"""FIX-PEOPLE-MONEY C2 (1981): the org chart's top row and advisors band. HR and admins put someone at the top of the
company or make them an advisor (their manager and any pending manager proposal go); null takes them back into the
lines. Everyone else is refused. Each change is audited. Synthetic people only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def test_top_row_and_advisors_set_by_hr_and_admins(api, worker, team):  # noqa: F811
    w = team
    as_(api, w, w.lead, "select pulse.org_line_set(%s,%s)", (w.outsider, w.editor))
    # Someone without HR or admin is refused; a place that is not top or advisor is refused.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.org_place_set(%s,'top')", (w.outsider,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.org_place_set(%s,'boss')", (w.outsider,))
    # HR puts them at the top: no manager now.
    as_(api, w, w.lead, "select pulse.org_place_set(%s,'top')", (w.outsider,))
    row = one(api, w, w.lead, "select org_place, manager_id from pulse.people_profile where person_id=%s", (w.outsider,))
    assert row["org_place"] == "top" and row["manager_id"] is None
    # A pending manager proposal for an advisor is retired; an admin can make someone an advisor.
    one(api, w, w.lead, "select pulse.org_line_propose(%s) n", (Jsonb([{"kind": "manager", "personId": str(w.editor2), "managerId": str(w.manager), "confidence": 0.7, "evidence": ["Gives them tasks"]}]),))
    as_(api, w, w.manager, "select pulse.org_place_set(%s,'advisor')", (w.editor2,))
    assert one(api, w, w.lead, "select org_place from pulse.people_profile where person_id=%s", (w.editor2,))["org_place"] == "advisor"
    assert one(api, w, w.lead, "select count(*) n from pulse.org_line_proposal where person_id=%s and status='pending'", (w.editor2,))["n"] == 0
    # Back into the lines: the place goes, and a manager can be set again.
    as_(api, w, w.lead, "select pulse.org_place_set(%s,null)", (w.outsider,))
    as_(api, w, w.lead, "select pulse.org_line_set(%s,%s)", (w.outsider, w.editor))
    row = one(api, w, w.lead, "select org_place, manager_id from pulse.people_profile where person_id=%s", (w.outsider,))
    assert row["org_place"] is None and row["manager_id"] == w.editor
    with worker.transaction():
        set_tenant(worker, w.org)
        n = worker.execute("select count(*) n from pulse.audit_event where action='reporting_line' and resource_id=%s", (str(w.outsider),)).fetchone()["n"]
    assert n >= 4, "each line and place change is audited"
