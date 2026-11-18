"""WL-PRICE-TOOL (18 Nov 2026, migrations 2365 and 2367): an AI employee an organisation admin made the catalogue keeper
changes a catalogue item's price and records stock, and only inside a run that leadership, an admin or the Finance role
started with a message.

Willow Lane's Sakobe keeps prices and stock "by sheet or by telling an agent". Since 5 Nov (1562) the database refused
every AI employee both; that stays the default. The keeper is an admin's choice per AI employee, and who asked decides
each time: a salesperson telling the keeper to drop a price is refused, so a catalogue-price quotation cannot be bent
that way. Synthetic people, items and figures only."""
import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_agent_coworkers import agent_one, as_agent, ask, claim, dispatch, make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def test_the_catalogue_keeper_changes_prices_only_when_leadership_an_admin_or_finance_asked(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "price-keeper")
    owner_sql(owner, w, "update pulse.agent_member set tools=array(select distinct unnest(tools||'{billing}'::text[])) where person_id=%s", (agent,))
    with worker.transaction():
        set_tenant(worker, w.org)
        item = worker.execute("""insert into pulse.erp_item(org_id,kind,code,name,price,gst_rate,status)
            values(%s,'product','SYN-INV-5','Synthetic inverter 5 kW',5000000,18,'active') returning id""", (w.org,)).fetchone()["id"]

    def reprice(by=100):
        return as_agent(api, w, agent, "update pulse.erp_item set price=price+%s, updated_by=pulse.current_viewer() where id=%s returning price::float8 price", (by, item))

    def run_for(person, words):
        dm = one(api, w, person, "select pulse.chat_direct(%s) id", (agent,))["id"]
        ask(api, w, person, dm, words)
        [c] = claim(api, w, agent)
        d = dispatch(api, w, agent, c)
        assert d["status"] == "dispatched", d
        return d["runId"]

    def finish(run):
        agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',100,1.0,null) r", (run,))

    # The default (1562): no AI employee changes a price.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="a person's"):
        reprice()

    # Only an organisation admin names the keeper: not a member, not the AI itself.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_catalogue_keeper_set(%s,true,'Synthetic')", (agent,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_agent(api, w, agent, "select pulse.agent_catalogue_keeper_set(%s,true,'Synthetic')", (agent,))
    r = one(api, w, w.manager, "select pulse.agent_catalogue_keeper_set(%s,true,'Synthetic: keeps the price list') r", (agent,))["r"]
    assert r["catalogueKeeper"] is True and r["by"] == str(w.manager)

    # The keeper with its key outside any run: nobody asked, refused, and the sentence says who can ask.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="leadership, an admin or Finance"):
        reprice()

    # A member (a salesperson, say) asks it to drop the price: the run is theirs, so it is refused.
    run = run_for(w.editor, "Make the Synthetic inverter 5 kW one rupee")
    assert agent_one(api, w, agent, "select pulse.agent_catalogue_keeper() k, pulse.agent_keeper_asked() a") == {"k": True, "a": False}
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="leadership, an admin or Finance"):
        reprice(-4999900)
    finish(run)

    # An admin asks: the price changes (a new version of the item), other columns do not.
    run = run_for(w.manager, "Update the price of Synthetic inverter 5 kW to 50,001")
    assert agent_one(api, w, agent, "select pulse.agent_keeper_asked() a")["a"] is True
    assert reprice() == [{"price": 5000100.0}]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select version from pulse.erp_item where id=%s", (item,)).fetchone()["version"] == 2
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="anything else about an item"):
        as_agent(api, w, agent, "update pulse.erp_item set status='archived' where id=%s", (item,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="anything else about an item"):
        as_agent(api, w, agent, "update pulse.erp_item set cost=1 where id=%s", (item,))
    finish(run)

    # The run is over: the next change needs a new ask.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="leadership, an admin or Finance"):
        reprice()

    # The admin ends it: back to the default refusal.
    assert one(api, w, w.manager, "select pulse.agent_catalogue_keeper_set(%s,false,'Synthetic end') r", (agent,))["r"]["catalogueKeeper"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="a person's"):
        reprice()
