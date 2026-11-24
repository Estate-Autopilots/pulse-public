#!/usr/bin/env python3
"""QA-2 (QA system stage 1, step 9; research §4.5 "AI employee task set"): 10 fixed tasks per AI employee, run on a dev
copy of it, checked by the tools it called (agent_run.tools_used), not by reading its prose.

    python3 tools/qa/vitals/ai-task-set.py --set tools/qa/vitals/ai-tasks/wl-bhrata.json [--only 1,2] [--max-tokens 600000]
    python3 tools/qa/vitals/ai-task-set.py --rotate        (the night's set: one set a night, in turn)

The copy: the source AI employee's settings (its brief, tools, lane, effort, autonomy, who it listens to, risk policy)
are read from production (read only) and given to an AI employee of the same name in the QA company on DEV
("<name> (QA copy)", owner and approver: the synthetic owner). Only the QA company's synthetic people are ever in its
chats, so nothing it does can reach a real person; dev has no mail, WhatsApp or Telegram either.
Each task is sent by a synthetic person (seller, owner, …) in their direct chat with the copy; the harness waits for
the copy's run to finish and checks:
  expect.tools     every one of these was called (any of a list in a nested list)
  expect.notTools  none of these was called (an AI employee never records payments, deletes without asking, …)
  expect.reply     the copy answered in the chat (a regex its last reply must match, case-insensitive)
Output: <out>/ai-tasks.json and a line per task; exit 0 all passed, 1 a task failed, 2 could not run.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = Path.home() / ".local/state/vitals-qa"
DEV = ("127.0.0.1", int(os.environ.get("QA_DEV_PORT", "3200")))
COPY_FIELDS = {"title": "title", "lane": "lane", "effort": "effort", "tools": "tools", "autonomy": "autonomy", "listens_to": "listensTo",
               "instructions": "instructions", "risk_policy": "riskPolicy", "provider": "provider",
               # WL-FLOWS (19 Nov 2026): what the AI employee may do, not only what it is told. Without these the copy was
               # "standard" while Willow Lane's bhrātā and Artha have operations access (Artha the Finance role, bhrātā the
               # catalogue keeper), so the copy posted a task card where the real one creates the task.
               "access": "access", "finance_role_at is not null as finance_role": "financeRole",
               "catalogue_keeper_at is not null as catalogue_keeper": "catalogueKeeper"}
# The source column each COPY_FIELDS key reads into (an expression's alias, else the column itself).
COLUMN = {k: k.rsplit(" as ", 1)[-1] for k in COPY_FIELDS}


class Dev:
    """HTTP to dev's web server on ea as dev.vitalsos.ai, signed in as one QA person."""

    def __init__(self, creds: dict, role: str):
        self.creds, self.role, self.cookie = creds, role, None
        self.host = creds["baseUrl"].split("//", 1)[1].rstrip("/")
        v = creds["logins"][role]
        for _ in range(4):
            st, body, jar = self.call("/api/v0/auth/account-sign-in", {"login": v["handle"], "password": v["password"]})
            if st not in (502, 503):
                break
            time.sleep(20)
        if st != 200 or "pulse_session" not in jar:
            raise RuntimeError(f"{role} sign-in {st}")
        self.cookie = jar["pulse_session"]
        st, me, _ = self.call("/api/v0/me")
        self.person = (me.get("person") or {}).get("id") if isinstance(me.get("person"), dict) else me.get("person") or me.get("personId")

    def call(self, path: str, body=None, method: str | None = None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"content-type": "application/json", "host": self.host, "origin": self.creds["baseUrl"].rstrip("/"), "x-forwarded-proto": "https",
             "user-agent": "vitals-qa-2-ai-tasks", "accept": "application/json"}
        if self.cookie:
            h["cookie"] = f"pulse_session={self.cookie}"
        req = urllib.request.Request(f"http://{DEV[0]}:{DEV[1]}{path}", data=data, method=method or ("POST" if data is not None else "GET"), headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                jar = {}
                for c in r.headers.get_all("set-cookie") or []:
                    k, _, v = c.split(";")[0].partition("=")
                    if v:
                        jar[k] = v
                raw = r.read()
                return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else {}), jar
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw), {}
            except Exception:
                return e.code, {"error": raw[:200].decode(errors="replace")}, {}

    def close(self):
        if self.cookie:
            self.call("/api/v0/auth/sign-out", {})


def source_settings(spec: dict) -> dict:
    """The production AI employee's settings, read only (its organisation's own row security)."""
    import psycopg
    from psycopg.rows import dict_row
    path, _, key = spec.get("dsnEnv", "/etc/estate-autopilots/db/pulse.env:PULSE_DATABASE_URL_MIGRATE").partition(":")
    dsn = next(l.split("=", 1)[1].strip().strip('"') for l in Path(path).read_text().splitlines() if l.startswith(key + "="))
    with psycopg.connect(dsn, row_factory=dict_row, autocommit=True, application_name="qa-2-ai-tasks") as conn:
        with conn.transaction(force_rollback=True):
            c = conn.cursor()
            c.execute("set transaction read only")
            c.execute("set local role pulse_owner")
            org = c.execute("select id from pulse.org where handle = %s", (spec["org"],)).fetchone()
            c.execute("select set_config('pulse.org_id', %s, true)", (str(org["id"]),))
            row = c.execute(f"""select {', '.join('m.' + k for k in COPY_FIELDS)} from pulse.agent_member m join pulse.person p on p.id = m.person_id
                                where p.display_name = %s and m.disabled_at is null""", (spec["name"],)).fetchone()
    if not row:
        raise RuntimeError(f"no AI employee {spec['name']} at {spec['org']}")
    names = {COLUMN[k]: COPY_FIELDS[k] for k in COPY_FIELDS}
    return {names[k]: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in row.items() if v is not None}


def ensure_copy(owner: Dev, tset: dict) -> str:
    src = tset["agent"]
    name = f"{src['name']} (QA copy)"
    settings = source_settings(src) if src.get("org") else {}
    settings.update(src.get("override", {}))
    st, lst, _ = owner.call("/api/v0/agents")
    found = next((a for a in (lst.get("agents") or []) if a.get("name") == name), None)
    if found:
        agent = found.get("id") or found.get("personId")
    else:
        body = {"name": name, "title": (settings.get("title") or "QA copy")[:120], "lane": settings.get("lane", "thinking"), "ownerId": owner.person}
        st, made, _ = owner.call("/api/v0/agents", body)
        if st != 200:
            raise RuntimeError(f"create the copy: {st} {made}")
        agent = made.get("id") or made.get("personId") or (made.get("agent") or {}).get("id")
    body = {k: v for k, v in settings.items() if k in ("title", "lane", "effort", "tools", "provider")}
    body.update({k: v for k, v in settings.items() if k in ("listensTo", "autonomy", "instructions", "riskPolicy")})
    body.update({"approverId": owner.person, "dailyTokenBudget": str(tset.get("dailyTokenBudget", 800000))})
    st, out, _ = owner.call(f"/api/v0/agents/{agent}/settings", body)
    if st != 200:
        raise RuntimeError(f"copy the settings: {st} {json.dumps(out)[:200]}")
    # WL-FLOWS: operations access, the Finance role and the catalogue keeper, each the admin's own switch (the synthetic
    # owner is an admin of the QA company), with a note for its record history.
    grants = {k: settings[k] for k in ("access", "financeRole", "catalogueKeeper") if k in settings}
    if grants:
        note = "QA copy: as the AI employee it copies (WL-FLOWS)"
        st, out, _ = owner.call(f"/api/v0/agents/{agent}/settings", {**grants, "financeRoleNote": note, "catalogueKeeperNote": note})
        if st != 200:
            raise RuntimeError(f"copy the access: {st} {json.dumps(out)[:200]}")
    st, _, _ = owner.call(f"/api/v0/agents/{agent}/activate", {})
    return agent


def prepare(names: list[str], creds: dict) -> int:
    """WL-FLOWS: the copies the Willow Lane journeys act as (journeys.mjs wl-*: the copy's own key on API v1, no model), with
    production's settings and access, and a dev key each. Written to dev-agent-keys/copies.json (600): set name ->
    {agentId, username, keyFile}. Exit 0 when every copy is ready, 2 when one could not be made."""
    keys = Path.home() / ".config/vitals-qa/dev-agent-keys"
    note = keys / "copies.json"
    owner = Dev(creds, "owner")
    try:
        have = json.loads(note.read_text()) if note.exists() else {}
        for name in [n.strip() for n in names if n.strip()]:
            tset = json.loads((HERE / "ai-tasks" / f"{name}.json").read_text())
            agent = ensure_copy(owner, tset)
            username, keyfile = dev_key(creds, owner.person, agent)
            have[name] = {"agentId": agent, "username": username, "keyFile": str(keyfile), "at": datetime.now(timezone.utc).isoformat()}
            print(f"prepared {name}: {username}")
    except Exception as e:  # noqa: BLE001
        print(f"ai-task-set --prepare: could not prepare: {e}")
        return 2
    finally:
        owner.close()
    fd = os.open(note, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(have, fh, indent=1)
    return 0


def dev_key(creds: dict, owner_person: str, agent: str) -> tuple[str, Path]:
    """A 7-day key for the copy, issued on DEV as the synthetic owner (as qa-org.py issues the QA agent's); kept in a 600
    file and reused while it lasts. Returns (username, key file)."""
    import psycopg
    import psycopg.sql
    keys = Path.home() / ".config/vitals-qa/dev-agent-keys"
    keys.mkdir(mode=0o700, parents=True, exist_ok=True)
    with psycopg.connect(dev_dsn(), application_name="qa-2-ai-tasks") as c:
        own = c.execute("""select pg_get_userbyid(n.nspowner), r.rolsuper from pg_namespace n, pg_roles r
                           where n.nspname = 'pulse' and r.rolname = session_user""").fetchone()
        if not own[1]:
            c.execute(psycopg.sql.SQL("set local role {}").format(psycopg.sql.Identifier(own[0])))
        c.execute("""select set_config('pulse.org_id', %s, true), set_config('pulse.viewer_id', %s, true),
                            set_config('pulse.actor_account', 'qa-2 ai-task-set', true), set_config('pulse.agent_session', '', true)""",
                  (creds["org"]["id"], owner_person))
        username = c.execute("select username from pulse.people_profile where person_id = %s", (agent,)).fetchone()[0]
        f = keys / f"{username}.key"
        if f.exists() and time.time() - f.stat().st_mtime < 6 * 86400 and c.execute("select pulse.agent_key_resolve(%s) = %s::uuid", (f.read_text().strip(), agent)).fetchone()[0]:
            return username, f
        key = c.execute("select pulse.agent_key_issue(%s, %s, 7)", (agent, "QA-2 task set")).fetchone()[0]
        c.commit()
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key)
    return username, f


def dev_dsn() -> str:
    return next(l.split("=", 1)[1].strip().strip('"') for l in Path("/etc/estate-autopilots/db/pulse_dev.env").read_text().splitlines()
                if l.startswith("MIGRATE_DATABASE_URL="))


def run_once(cfg: Path) -> None:
    """The AI employee runtime, once, for the copy alone (its own config; the shared dev runtime is not touched)."""
    import subprocess
    root = HERE.parents[2]
    home = str(Path.home())
    path = f"{home}/.local/opt/node/bin:{home}/.local/bin:{home}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"  # as pulse-dev-coworker's unit
    subprocess.run(["node", "services/coworker/runner.mjs"], cwd=root, env={**os.environ, "PATH": path, "PULSE_COWORKER_CONFIG": str(cfg), "PULSE_COWORKER_ONCE": "1"},
                   timeout=600, capture_output=True, text=True)


TERMINAL = ("done", "error", "failed", "cancelled")          # agent_run
EVENT_OVER = ("done", "failed", "uncertain")                # agent_event (0510)


def dev_read(creds: dict, sql: str, params: tuple) -> list[tuple]:
    """One read-only query on dev inside the QA company (its own row security)."""
    import psycopg
    with psycopg.connect(dev_dsn(), autocommit=True, application_name="qa-2-ai-tasks") as conn:
        with conn.transaction(force_rollback=True):
            c = conn.cursor()
            c.execute("set transaction read only")
            c.execute("select set_config('pulse.org_id', %s, true)", (creds["org"]["id"],))
            return c.execute(sql, params).fetchall()


def runs_for(creds: dict, agent: str, message: str) -> tuple[str | None, list[dict]]:
    """WL-AGENTS (19 Nov 2026): the copy's event for THIS message and its runs. Before, the harness took any new run as
    the task's: a backlog of older messages (folded at 0 tokens into a newer one, `chat.fold_newer`) ended the wait at
    once, and a run still `dispatching` was not counted as in progress; 3 of 10 tasks were judged on someone else's run."""
    ev = dev_read(creds, "select id, state, reason from pulse.agent_event where agent_id = %s and subject_id = %s order by created_at limit 1", (agent, message))
    if not ev:
        return None, []
    rows = dev_read(creds, "select id, state, tokens, tools_used, error_code from pulse.agent_run where event_id = %s order by started_at", (ev[0][0],))
    return f"{ev[0][1]}{':' + ev[0][2] if ev[0][2] else ''}", [{"id": str(r[0]), "state": r[1], "tokens": r[2], "tools": list(r[3] or []), "errorCode": r[4]} for r in rows]


def pending_events(creds: dict, agent: str) -> int:
    return dev_read(creds, "select count(*) from pulse.agent_event where agent_id = %s and state in ('queued', 'leased', 'dispatching')", (agent,))[0][0]


def drain(cfg: Path, creds: dict, agent: str, rounds: int = 6) -> int:
    """Messages the copy has not answered yet (an earlier run that stopped half way) are answered before the first task,
    so none of them is taken for a task's run. Returns how many were waiting."""
    waiting = pending_events(creds, agent)
    for _ in range(rounds):
        if not pending_events(creds, agent):
            break
        run_once(cfg)
    return waiting


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", type=Path)
    ap.add_argument("--rotate", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--max-tokens", type=int, default=600000)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--credentials", type=Path, default=Path.home() / ".config/vitals-qa/dev.json")
    ap.add_argument("--prepare", help="WL-FLOWS: only make sure these sets' copies and their dev keys exist (comma list of set "
                    "names, e.g. wl-bhrata,wl-artha) and note them in dev-agent-keys/copies.json for journeys.mjs; no task is run")
    args = ap.parse_args()
    if args.prepare:
        return prepare(args.prepare.split(","), json.loads(args.credentials.read_text()))
    sets = sorted((HERE / "ai-tasks").glob("*.json"))
    path = args.set or (sets[datetime.now(timezone.utc).timetuple().tm_yday % len(sets)] if args.rotate and sets else None)
    if not path:
        print("ai-task-set: give --set or --rotate")
        return 2
    tset = json.loads(path.read_text())
    out_dir = args.out or STATE / "ai-tasks" / f"{datetime.now(timezone.utc):%Y%m%dT%H%M}-{path.stem}"
    out_dir.mkdir(parents=True, exist_ok=True)
    creds = json.loads(args.credentials.read_text())
    people: dict[str, Dev] = {}
    results, tokens = [], 0
    try:
        owner = people.setdefault("owner", Dev(creds, "owner"))
        agent = ensure_copy(owner, tset)
        username, keyfile = dev_key(creds, owner.person, agent)
        cfg = out_dir / "coworker.json"
        qa_people = [v.get("handle") for v in creds["logins"].values() if v.get("kind") == "staff"]
        cfg.write_text(json.dumps({"pulse": f"http://127.0.0.1:{os.environ.get('QA_DEV_API_PORT', '3203')}", "agents": [{"username": username, "keyFile": str(keyfile)}],
                                   "poll": 3, "concurrency": 1, "askOnly": qa_people,
                                   "askOnlyNote": "QA-2: the copy asks the QA company's synthetic people only"}))
        backlog = drain(cfg, creds, agent)
        if backlog:
            print(f"answered {backlog} message(s) the copy had not answered yet, before the first task", flush=True)
        for i, task in enumerate(tset["tasks"], 1):
            if args.only and str(i) not in args.only.split(","):
                continue
            if tokens >= args.max_tokens:
                results.append({"n": i, "ok": None, "skipped": f"token cap {args.max_tokens} reached"})
                continue
            who = people.get(task.get("from", "seller")) or people.setdefault(task.get("from", "seller"), Dev(creds, task.get("from", "seller")))
            st, ch, _ = who.call("/api/v0/chats/direct", {"personId": agent})
            chat = ch.get("id")
            st, msgs0, _ = who.call(f"/api/v0/chats/{chat}/messages")
            seen = {m.get("id") for m in (msgs0 if isinstance(msgs0, list) else msgs0.get("messages") or msgs0.get("items") or [])}
            t0 = time.time()
            st, sent, _ = who.call(f"/api/v0/chats/{chat}/messages", {"body": task["text"], "clientId": str(uuid.uuid4())})
            mid = sent.get("id") if isinstance(sent, dict) else None
            if st != 200 or not mid:
                raise RuntimeError(f"task {i}: the message was not sent ({st})")
            run = None
            while time.time() - t0 < task.get("timeout", 300):
                run_once(cfg)
                ev_state, mine = runs_for(creds, agent, mid)
                if ev_state and ev_state.split(":")[0] in EVENT_OVER and all(r["state"] in TERMINAL for r in mine):
                    run = mine
                    break
            used = sorted({t for r in (run or []) for t in r["tools"]})
            spent = sum(int(r.get("tokens") or 0) for r in (run or []))
            tokens += spent
            st, msgs, _ = who.call(f"/api/v0/chats/{chat}/messages")
            items = msgs if isinstance(msgs, list) else msgs.get("messages") or msgs.get("items") or []
            # only a reply written after this task's message counts
            reply = next((str(m.get("body") or "") for m in reversed(items) if m.get("id") not in seen
                          and (m.get("authorId") or m.get("personId") or (m.get("author") or {}).get("id")) == agent), "")
            exp = task.get("expect", {})
            probs = []
            if run is None:
                probs.append(f"no finished run within {task.get('timeout', 300)} s")
            elif not run:
                probs.append(f"the message ended without a run ({ev_state})")
            for r in run or []:
                if r.get("state") != "done":
                    probs.append(f"the run failed ({r.get('errorCode') or r.get('state')})")
            for want in exp.get("tools", []):
                alts = want if isinstance(want, list) else [want]
                if not set(alts) & set(used):
                    probs.append(f"did not call {' or '.join(alts)}")
            for bad in exp.get("notTools", []):
                if bad in used:
                    probs.append(f"called {bad}")
            if exp.get("reply") and not re.search(exp["reply"], reply, re.I):
                probs.append(f"reply does not match /{exp['reply']}/")
            results.append({"n": i, "from": task.get("from", "seller"), "task": task["text"][:120], "ok": not probs, "problems": probs, "tools": used,
                            "tokens": spent, "seconds": round(time.time() - t0), "reply": reply[:300]})
            print(f"{'ok  ' if not probs else 'FAIL'} {i:2} {task['text'][:60]!r}: tools {','.join(used) or '-'}; {spent} tokens"
                  + (f"; {'; '.join(probs)}" if probs else ""), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"ai task set {path.stem}: could not run: {e}")
        (out_dir / "ai-tasks.json").write_text(json.dumps({"set": path.stem, "error": str(e), "results": results}, indent=1))
        return 2
    finally:
        for p in people.values():
            p.close()
    passed = sum(1 for r in results if r.get("ok"))
    print(f"ai task set {path.stem}: {passed}/{len(results)} passed, {tokens} tokens")
    (out_dir / "ai-tasks.json").write_text(json.dumps({"set": path.stem, "agent": tset["agent"], "at": datetime.now(timezone.utc).isoformat(), "tokens": tokens, "results": results}, indent=1))
    return 0 if passed == len([r for r in results if r.get("ok") is not None]) else 1


if __name__ == "__main__":
    sys.exit(main())
