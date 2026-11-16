"""SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2; migration 2043): the owner's Focus opens in every company he works in,
not by switching to the one that keeps it. pulse.focus_enter_home() moves one transaction to the account's Focus
organisation as its admin seat (only where pulse.account_module_home('focus') finds one), so /api/v0/account/focus reads
the same board under that organisation's row security. Someone without a Focus, or not its admin, moves nowhere.
Synthetic tenants, fake companies and fake accounts only."""
import uuid

from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

from helpers import build_world
from test_focus import seed
from test_investor_metrics import admin, member, new_account


def test_focus_opens_in_another_company_on_the_same_board(worker, owner, api):
    home = build_world(worker, owner, api)  # the owner's own workspace, where Focus is switched on
    there = build_world(worker, owner, api)  # one of his companies, without the Focus module
    tag = uuid.uuid4().hex[:8]
    with worker.transaction():
        set_tenant(worker, home.org)
        worker.execute("""insert into pulse.tenant_config(org_id,doc_kind,doc_key,version,body,is_active)
                          values(%s,'tenant','modules',1,%s,true)""", (home.org, Jsonb({"off": [], "on": ["focus"]})))
    admin(worker, home.org, home.manager)
    admin(worker, there.org, there.manager)
    seed(owner, home)
    acct = new_account(owner, f"focus{tag}")
    member(owner, acct, home.org, home.manager)
    member(owner, acct, there.org, there.manager)

    with api.transaction(force_rollback=True):
        set_tenant(api, there.org, there.manager)
        assert api.execute("select count(*) n from pulse.focus_company").fetchone()["n"] == 0  # nothing of it here
        moved = api.execute("select pulse.focus_enter_home() h").fetchone()["h"]
        assert moved == {"id": str(home.org), "name": moved["name"], "seat": str(home.manager)}
        # The rest of this transaction reads the Focus organisation's board as its admin seat.
        assert api.execute("select pulse.current_org() o").fetchone()["o"] == home.org
        assert [r["key"] for r in api.execute("select key from pulse.focus_account").fetchall()] == ["fake-max"]
        assert sorted(r["key"] for r in api.execute("select key from pulse.focus_company").fetchall()) == ["alpha", "beta"]

    # Another person of that company (their own account, no Focus anywhere) and nobody signed in: nothing moves.
    member(owner, new_account(owner, f"other{tag}"), there.org, there.lead)
    for who in (there.lead, None):
        with api.transaction(force_rollback=True):
            set_tenant(api, there.org, who)
            assert api.execute("select pulse.focus_enter_home() h").fetchone()["h"] is None
            assert api.execute("select pulse.current_org() o").fetchone()["o"] == there.org

    # A seat in the Focus organisation that is no longer its admin: nothing moves.
    with worker.transaction():
        set_tenant(worker, home.org)
        worker.execute("update pulse.role_assignment set valid_to=current_date - 1 where person_id=%s and role_key='admin'", (home.manager,))
    with api.transaction(force_rollback=True):
        set_tenant(api, there.org, there.manager)
        assert api.execute("select pulse.focus_enter_home() h").fetchone()["h"] is None
