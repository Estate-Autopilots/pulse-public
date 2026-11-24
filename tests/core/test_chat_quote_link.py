"""WL-DAY (22 Nov 2026, the 3rd day): a quotation link in Chats that no longer opens (its draft was replaced or is not
the person's) must lead to the chat's newest quotation, or say plainly why not, never "not allowed" (403). The route
(GET /api/v0/erp/documents/:id/latest?chat=…) runs through services/api/test/chat-quote-link-runner.mjs as a Billing
person who is not a superuser, on real PostgreSQL and row security. Synthetic data only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def test_a_chat_link_finds_the_chats_newest_quotation(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    chat, other = uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) as r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        for cid, key in ((chat, "zz-quote-chat"), (other, "zz-other-chat")):
            owner.execute("insert into pulse.chat_channel(id,org_id,key,name,kind) values(%s,%s,%s,%s,'group')", (cid, w.org, key, key))
        owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, chat, w.finance))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "domain": w.domain, "chat": str(chat), "other": str(other), "finance": str(w.finance)})}
    # The quotation kept for the chat, written as an AI employee's runtime does (erp_quote_chat_keep needs an AI viewer).
    def keep(doc):
        with owner.transaction():
            owner.execute(f"set local role {role}")
            set_tenant(owner, w.org)
            owner.execute("insert into pulse.erp_quote_chat(org_id,document_id,channel_id,agent_id) values(%s,%s,%s,%s)", (w.org, doc, chat, w.finance))
    env["TEST_KEEP"] = "1"
    proc = subprocess.Popen(["node", "test/chat-quote-link-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api",
                            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    # The runner prints the quotation to keep, waits, then checks the route.
    line = proc.stdout.readline().strip()
    assert line.startswith("KEEP "), line + proc.stderr.read()
    keep(line.split()[1])
    proc.stdin.write("kept\n"); proc.stdin.flush()
    out, err = proc.communicate(timeout=180)
    assert proc.returncode == 0, out + err
    assert "CHAT-QUOTE-LINK runner: all checks passed" in out
