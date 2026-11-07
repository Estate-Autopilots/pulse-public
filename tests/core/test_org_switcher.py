"""ORG-SWITCHER-UX (owner, 6 Nov 2026): the organisation switcher under the company name showed only the current
company's logo; every other company was the same grey initials tile, and its line read "Team · 2" (the seat's kind with
a shortcut number glued on). pulse.account_seat_looks (1601) gives the switcher each of the account's companies' own
logo (by version), brand colour and the person's access there, read inside each company under its own row security.
Synthetic organisations and people only; nothing is sent."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from psycopg.conninfo import conninfo_to_dict
from conftest import dsn
from helpers import build_world
from pulse_sdk.db import set_tenant
from test_my_day import _MARK, _account, _staff_ready, _token
from test_tasks_rt1 import as_

_MARK2 = (b'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
          b'<rect width="64" height="64" rx="14" fill="#c2410c"/><circle cx="32" cy="32" r="14" fill="none" stroke="#fff" stroke-width="6"/></svg>')
_ACCENT = "#7a3db8"
_LONG = "Synthetic Northgate Builders and Interiors Private Limited"


def _grant(owner, w, person, role, title=None):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,unit_id,is_manager_of_unit,valid_from) values(%s,%s,%s,null,false,current_date)",
                      (w.org, person, role))
        if title:
            owner.execute("update pulse.people_profile set role=%s where person_id=%s", (title, person))


def _world(worker, owner, api, name, mark=None, accent=None):
    w = build_world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.org set name=%s where id=%s", (name, w.org))
        if mark or accent:
            owner.execute("insert into pulse.org_brand(org_id,mark,mark_mime,accent,version) values(%s,%s,%s,%s,%s)",
                          (w.org, mark, 'image/svg+xml' if mark else None, accent, 3 if mark else 1))
    _staff_ready(api, worker, w, w.editor)
    return w


@pytest.fixture
def five(worker, owner, api):
    """One account in five companies: two with their own logos, one with only a brand colour, two with neither (one
    with a long name). The person is the owner (admin, founder) of the first and an admin of the second."""
    a = _world(worker, owner, api, "Synthetic Riverside Studio", mark=_MARK)
    b = _world(worker, owner, api, "Synthetic Harbour Sales", mark=_MARK2)
    c = _world(worker, owner, api, "Synthetic Lakeside Clinic", accent=_ACCENT)
    d = _world(worker, owner, api, "Synthetic Third Co")
    e = _world(worker, owner, api, _LONG)
    _grant(owner, a, a.editor, "admin", "Founder")
    _grant(owner, b, b.editor, "admin")
    _grant(owner, c, c.editor, "finance")
    _account(owner, *((w.org, w.editor) for w in (a, b, c, d, e)))
    return a, b, c, d, e


def test_each_company_in_the_switcher_has_its_own_look_and_the_persons_access(api, worker, owner, five):
    a, b, c, d, e = five
    other = build_world(worker, owner, api)
    rows = as_(api, a, a.editor, "select pulse.account_seat_looks() l, current_setting('pulse.org_id') o, current_setting('pulse.viewer_id') v")
    looks = {l["id"]: l for l in rows[0]["l"]}
    # Read inside each company and put back: the request's own organisation and viewer are unchanged afterwards.
    assert rows[0]["o"] == str(a.org) and rows[0]["v"] == str(a.editor)
    assert set(looks) == {str(w.org) for w in five}, "only the account's own companies"
    assert str(other.org) not in looks
    assert looks[str(a.org)] == {"id": str(a.org), "markVersion": 3, "accent": None, "access": "owner"}
    assert looks[str(b.org)]["markVersion"] == 3 and looks[str(b.org)]["access"] == "admin"
    assert looks[str(c.org)] == {"id": str(c.org), "markVersion": None, "accent": _ACCENT, "access": "finance"}
    assert looks[str(d.org)]["markVersion"] is None and looks[str(d.org)]["access"] == "member"
    # A colleague without a Pulse account: their own company only.
    assert [l["id"] for l in as_(api, a, a.editor2, "select pulse.account_seat_looks() l")[0]["l"]] == [str(a.org)]
    # Nobody signed in: nothing.
    assert as_(api, a, None, "select pulse.account_seat_looks() l")[0]["l"] == []


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_org_switcher_in_the_browser(api, worker, owner, five):
    """services/api/test/org-switcher-browser-runner.mjs: the sidebar switcher and the Ctrl+Shift+O dialog show each
    company's own logo, else its initials on its brand colour, else on a colour of its own; the line under each name is
    the person's access and the company's @handle, the shortcut a key cap; a long name wraps. 1440 and 390, light and
    dark. Screenshots with PULSE_OS_SCREENSHOTS (PULSE_OS_BEFORE=1: shots only, for the page before the change)."""
    a, b, c, d, e = five
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    with owner.transaction():
        set_tenant(owner, a.org)
        owner.execute("update pulse.account set purpose='Workspace account' where org_id=%s and handle=%s", (a.org, a.editor_handle))
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"token": _token(api, a, a.editor, a.org), "email": a.editor_handle, "orgs": [str(w.org) for w in five],
                                   "accent": _ACCENT, "long": _LONG})}
    p = subprocess.run(["node", "test/org-switcher-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1500, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
