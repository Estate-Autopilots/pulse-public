"""WL-PROMISES (CEO room msgs 140, 155, 171): what a company's install key and API tokens can do for the quotation cycle, on
real tenant RLS through services/api/test/wl-promises-runner.mjs: the issued quotation's PDF, site visits, quote history with
lines, workflow runs, the quotation's life as events and the activity read, quote revisions and cancel, and lead-create.
Synthetic people and data only; nothing leaves the machine."""
import base64
import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_erp_invoice import _seed_erp_world, draft, erp, one  # noqa: F401  (erp is a fixture)
from test_install_events import issued, mark
from test_service_key_own_org import _as_schema_owner
from test_sop import make_workflow


def _key(owner, org, scopes):
    """A key issued straight into one company; returns the bearer token the client would hold."""
    key_id, secret = uuid.uuid4(), base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
    with owner.transaction():
        _as_schema_owner(owner, org)
        owner.execute("insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label) values(%s,%s,%s,%s,'Synthetic WAS')",
                      (key_id, org, hashlib.sha256(secret.encode()).hexdigest(), list(scopes)))
    return f"psvc_{key_id}_{secret}"


def test_wl_promises(worker, owner, api, erp):  # noqa: F811
    w = erp
    seeded = _seed_erp_world(worker, w)   # Workspace accounts founder@, finance@ and member@ the domain
    other = build_world(worker, owner, api)
    item = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.erp_item(id,org_id,kind,name,price,gst_rate,status) values(%s,%s,'service','TEST Synthetic panel',10000,18,'active')", (item, w.org))
        # The manager runs the customer after closing, so may open a site visit (site_visit_create).
        worker.execute("update pulse.client set after_closing_person_id=%s where id=%s", (w.manager, w.client))
    # Events are recorded only for a company with a webhook or a recent listener.
    with owner.transaction():
        _as_schema_owner(owner, w.org)
        owner.execute("insert into pulse_priv.v1_event_listen(org_id) values(%s)", (w.org,))

    quote = issued(api, w, client=w.client)
    one(api, w, w.finance, "select pulse.erp_document_file_put(%s,%s)", (quote, b"%PDF-synthetic"))
    unissued = draft(api, w, w.finance, "quotation", client=w.client)
    invoice = draft(api, w, w.finance, "invoice", client=w.client)
    one(api, w, w.finance, "select pulse.erp_document_issue(%s) r", (invoice,))
    one(api, w, w.finance, "select pulse.erp_document_file_put(%s,%s)", (invoice, b"%PDF-invoice"))
    assert mark(api, w, quote, "sent") == "sent"
    assert mark(api, w, quote, "accepted") == "accepted"
    visit = one(api, w, w.manager, "select pulse.site_visit_create(%s,'survey',null,'Synthetic note') id", (w.client,))["id"]
    flow = make_workflow(api, w.org, w.founder, {"steps": [{"id": "go", "title": "Synthetic step", "assign": {"by": "starter"}}]})
    run = one(api, w, w.founder, "select pulse.workflow_start(%s,%s) id", (flow, Jsonb({"projectId": str(w.project)})))["id"]

    with owner.transaction():
        _as_schema_owner(owner, w.org)
        types = {(r["type"], r["subject_id"]) for r in owner.execute("select type,subject_id from pulse_priv.v1_event where org_id=%s", (w.org,)).fetchall()}
        known = owner.execute("select pulse.v1_event_types() t").fetchone()["t"]
    assert {("quotation.created", quote), ("quotation.issued", quote), ("quotation.sent", quote), ("quotation.accepted", quote), ("quotation.created", unissued)} <= types, types
    assert ("quotation.sent", unissued) not in types and not any(t == "quotation.created" and s == invoice for t, s in types)
    assert {"quotation.approval_requested", "quotation.declined", "quotation.cancelled"} <= set(known)

    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "founder": str(w.founder), "adminEmail": f"founder@{w.domain}", "memberEmail": f"member@{w.domain}",
                                 "quote": str(quote), "draft": str(unissued), "invoice": str(invoice), "customer": str(w.client), "otherClient": str(seeded["north"]),
                                 "otherPerson": str(other.manager), "visit": str(visit), "run": str(run), "item": str(item), "phone": "+12025550117",
                                 "filesKey": _key(owner, w.org, ["files.read"]), "visitsKey": _key(owner, w.org, ["site_visits.read"]),
                                 "quoteKey": _key(owner, w.org, ["quotes.draft.create"]),
                                 "narrowKey": _key(owner, w.org, ["clients.read"]), "otherFilesKey": _key(owner, other.org, ["files.read", "site_visits.read"])})}
    p = subprocess.run(["node", "test/wl-promises-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 80, out

    # The quote-lead is a prospect client the assistant added, owned by the salesperson; the phone is stored once.
    lead = one(api, w, w.founder, "select status,source,relationship_owner_id,phone,city from pulse.client where id=%s", (out["lead"],))
    assert (lead["status"], lead["source"], lead["relationship_owner_id"], lead["phone"], lead["city"]) == ("prospect", "assistant", w.founder, "+12025550117", "Synthetic Nagar")
    assert one(api, w, w.founder, "select count(*) n from pulse.client where phone=%s", ("+12025550117",))["n"] == 1
