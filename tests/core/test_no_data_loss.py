"""NO-DATA-LOSS (owner RED ALERT, 20 Nov 2026): "No data should be deleted. Not the call logs, not the recordings,
nothing." No database function may delete rows by age (a sweep or a TTL) except from the short-lived tables below:
sign-in codes, tokens, OAuth/OIDC/passkey attempts, caches, idempotency keys, the webhook outbox and call signalling.
NO-DATA-LOSS-4 (owner, 20 Nov 2026: "keep all the data forever"; texts approved the same evening): screen replays,
usage, the listening sound and the phone/desktop apps' raw readings are kept too (2494).
A new time-based delete of anything else fails here: keep the rows (archive or mark them) instead.
"""

import re

# table -> why removing it by age is not losing company history
SHORT_LIVED = {
    "account_webauthn": "passkey challenge", "auth_webauthn": "passkey challenge", "account_challenge": "sign-in challenge",
    "calendar_attempt": "OAuth attempt", "google_auth_attempt": "OAuth attempt", "google_link_attempt": "OAuth attempt",
    "google_invite_ticket": "one-time invite ticket", "mcp_connector_attempt": "OAuth attempt",
    "org_mailbox_attempt": "OAuth attempt", "sales_xray_attempt": "OAuth attempt", "oauth_device": "device code",
    "oidc_code": "OIDC code", "oidc_token": "expired/revoked token", "native_pair": "pairing code",
    "native_token": "expired refresh token", "runner_login_code": "login code", "runner_pair_code": "pairing code",
    "v1_replay": "idempotency key", "v1_event": "webhook outbox (the records stay in their own tables)",
    "insight_ops_cache": "cache", "chat_call_event": "call signalling (ringing), 10 minutes",
    "chat_refresh_state": "cache", "chat_file": "uploads never attached to any message (1 day)",
    "telemetry_daily": "rollup rebuilt from telemetry_event",
}
DELETE = re.compile(r"delete\s+from\s+(?:only\s+)?([a-z0-9_\.]+)([^;]*)", re.I | re.S)
BY_AGE = re.compile(r"now\(\)|clock_timestamp\(\)|current_date|current_timestamp|interval|expires_at|_days\b", re.I)


def test_no_function_deletes_company_history_by_age(admin):
    rows = admin.execute(
        "select n.nspname || '.' || p.proname as fn, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
        "where n.nspname in ('pulse', 'pulse_priv', 'privacy', 'pulse_route') and p.prosrc ~* 'delete\\s+from'").fetchall()
    found = []
    for r in rows:
        fn, src = (r["fn"], r["src"]) if isinstance(r, dict) else r
        for m in DELETE.finditer(src):
            table = m.group(1).split(".")[-1].lower()
            if BY_AGE.search(m.group(2)) and table not in SHORT_LIVED:
                found.append(f"{fn}: delete from {table}")
    assert not found, "time-based deletes of company history (NO-DATA-LOSS): " + "; ".join(sorted(set(found)))


def test_retention_functions_named_by_the_owner_keep_rows(admin):
    # The five sweeps 2491 changed keep messages, transcripts, call notes, readings and the connected apps' log.
    for fn, table in [("chat_prune", "chat_message"), ("listen_purge", "listen_session"), ("chat_call_note", "chat_call_quality"),
                      ("focus_ingest", "focus_sample"), ("connect_due", "connect_call")]:
        src = admin.execute("select prosrc from pg_proc where proname = %s", (fn,)).fetchone()
        src = src["prosrc"] if isinstance(src, dict) else src[0]
        assert not re.search(rf"delete\s+from\s+(pulse\.)?{table}\b", src, re.I), f"{fn} deletes {table} again"


def test_finance_sync_keeps_what_left_its_source(admin):
    # 2492: the live finance sync moves records and CA desk rows that left their source to the gone tables.
    for fn, gone in [("finance_live_retire", "finance_live_record_gone"), ("finance_desk_live_prune", "finance_desk_record_gone")]:
        src = admin.execute("select prosrc from pg_proc where proname = %s", (fn,)).fetchone()
        src = src["prosrc"] if isinstance(src, dict) else src[0]
        assert re.search(rf"insert\s+into\s+pulse_priv\.{gone}\b", src, re.I), f"{fn} no longer keeps what it retires"
    for table, privilege in [("finance_live_record", "delete"), ("finance_live_record_gone", "delete"), ("finance_live_record_gone", "update"),
                             ("finance_desk_record_gone", "delete"), ("finance_desk_record_gone", "update")]:
        row = admin.execute("select has_table_privilege('pulse_worker', %s, %s) ok", (f"pulse_priv.{table}", privilege)).fetchone()
        assert not (row["ok"] if isinstance(row, dict) else row[0]), f"pulse_worker may {privilege} {table} again"


def _src(admin, fn):
    row = admin.execute("select prosrc from pg_proc where proname = %s", (fn,)).fetchone()
    return row["prosrc"] if isinstance(row, dict) else row[0]


def test_replays_usage_sound_and_app_readings_are_kept(admin):
    # 2494 (NO-DATA-LOSS-4): nothing deletes replays or usage (by age, by the company budget or the server cap), the
    # listening sound stays once written down, and the apps' readings stay; readings under a withdrawn notice are
    # still erased and expired sign-in tokens still go.
    for fn in ("telemetry_retention", "telemetry_replay_room", "telemetry_maintain"):
        src = _src(admin, fn)
        for table in ("telemetry_replay", "telemetry_event"):
            assert not re.search(rf"delete\s+from\s+(pulse\.)?{table}\b", src, re.I), f"{fn} deletes {table} again"
    assert not re.search(r"bytes\s*=\s*null", _src(admin, "listen_chunk_done"), re.I), "listen_chunk_done drops the sound again"
    src = _src(admin, "native_prune")
    for table in ("native_ack", "native_batch"):
        assert not re.search(rf"delete\s+from\s+(pulse\.)?{table}\b", src, re.I), f"native_prune deletes {table} again"
    events = [m.group(2) for m in DELETE.finditer(src) if m.group(1).split(".")[-1].lower() == "native_event"]
    assert events and all("withdrawn_at is not null" in e and not BY_AGE.search(e) for e in events), events


def test_privacy_contact_named_in_the_notices(worker, owner, api):
    # 2497 (NO-DATA-LOSS-5, owner 20 Nov 2026, 18:15 UTC): "ask your company's privacy contact" names an e-mail: the one an
    # admin chose in Settings → Privacy, else the owner's (the first admin still holding the role); the platform's own
    # company (Vitals Technology) starts with admin@org-9912dc.example. Each company reads only its own.
    from pathlib import Path

    from helpers import build_world
    from pulse_sdk.db import set_tenant

    w, other = build_world(worker, owner, api), build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,email,evidence) values(%s,%s,'Owner','owner@example.test','{}')", (w.org, w.manager))

    def contact(org):
        with api.transaction():
            set_tenant(api, org)
            row = api.execute("select pulse.privacy_contact_of_org() p").fetchone()
            return row["p"] if isinstance(row, dict) else row[0]

    assert contact(w.org) == {"email": "owner@example.test", "chosen": False}
    assert contact(other.org) == {"email": None, "chosen": False}, "no admin with an e-mail: none is made up"
    with api.transaction():
        set_tenant(api, w.org)
        api.execute("insert into pulse.privacy_contact(org_id, email) values (%s, 'privacy@example.test')", (w.org,))
    assert contact(w.org) == {"email": "privacy@example.test", "chosen": True}
    assert contact(other.org)["email"] is None
    # The migration's seed, re-run as the owner, names admin@org-9912dc.example for a company called Vitals Technology… only.
    sql = (Path(__file__).resolve().parents[2] / "db/migrations/2497_privacy_contact.sql").read_text()
    seed = sql[sql.index("do $$"):sql.index("end $$;") + len("end $$;")]
    with owner.transaction():
        set_tenant(owner, other.org)
        owner.execute("update pulse.org set name = 'Vitals Technology Private Limited' where id = %s", (other.org,))
        owner.execute(seed)
    assert contact(other.org) == {"email": "admin@org-9912dc.example", "chosen": True}
    assert contact(w.org)["email"] == "privacy@example.test"
