"""pulse-worker: projections, partition maintenance and retention.

    pulse-worker run [--state FILE] [--poll SECONDS]   # the service: projections continuously + daily jobs
    pulse-worker project [--org UUID] [--rebuild] [--fingerprint]
    pulse-worker rules check (--org UUID | --all)    # validate active tenant folder rules
    pulse-worker onboard (--org UUID | --all) [--step sort|fill] [--dry-run]
    pulse-worker maintain                              # create log partitions ahead (worker role)
    pulse-worker retention                             # drop/redact expired data (privacy role)

Database URLs come from PULSE_DATABASE_URL_WORKER and PULSE_DATABASE_URL_PRIVACY (never printed).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
from pulse_rules.folder_rules import check as check_folder_rules

from pulse_sdk.db import active_orgs, connect, tenant_tx
from pulse_sdk.paths import repo_root

from .deliveries import Deliveries
from .maintenance import maintain_partitions, run_retention
from .onboard import add_parser as add_onboard_parser
from .onboard import sort_org
from .projector import ProjectionRunner, fingerprint
from .scheduler import State, due_jobs
from .workgraph import WorkGraph

log = logging.getLogger("pulse.worker")


def _project(args) -> int:
    with connect("worker") as conn:
        conn.autocommit = True
        p = WorkGraph()
        runner = ProjectionRunner(conn, p)
        orgs = [uuid.UUID(args.org)] if args.org else active_orgs(conn)
        for org in orgs:
            n = runner.rebuild(org) if args.rebuild else runner.catch_up(org)
            out = {"org": str(org), "events": n}
            if args.fingerprint:
                out["fingerprint"] = fingerprint(conn, org, p.tables)
            print(json.dumps(out))
    return 0


def _maintain(_args) -> int:
    with connect("worker") as conn:
        conn.autocommit = True
        print(json.dumps(maintain_partitions(conn)))
    return 0


def _retention(_args) -> int:
    with connect("privacy") as conn:
        conn.autocommit = True
        r = run_retention(conn)
        print(json.dumps({"dropped_partitions": r.dropped_partitions, "redacted": r.redacted,
                          "raw_purged": r.raw_purged}))
    return 0


def _rules_check(args) -> int:
    with connect("worker") as conn:
        conn.autocommit = True
        orgs = active_orgs(conn) if args.all else [uuid.UUID(args.org)]
        valid = True
        for org in orgs:
            with tenant_tx(conn, org):
                summary = check_folder_rules(conn, org)
            print(json.dumps(summary, sort_keys=True))
            valid = valid and summary["valid"]
    return 0 if valid else 1


def _run(args) -> int:
    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    state = State(Path(args.state))
    backoff = 2.0
    while not stop:
        try:
            _serve(args, state, lambda: stop)
        except psycopg.OperationalError as exc:      # database down or unreachable: wait and reconnect
            log.error("database unavailable (%s); retrying in %.0f s", type(exc).__name__, backoff)
            waited = 0.0
            while waited < backoff and not stop:           # stays responsive to SIGTERM
                time.sleep(0.5)
                waited += 0.5
            backoff = min(backoff * 2, 60.0)
    log.info("worker stopped")
    return 0


def _serve(args, state: State, stopped) -> None:
    with connect("worker") as work, connect("worker") as listen:
        work.autocommit = True
        listen.autocommit = True
        listen.execute("listen pulse_events")
        runner = ProjectionRunner(work, WorkGraph())
        deliveries = ProjectionRunner(work, Deliveries())
        log.info("worker connected")
        next_onboarding_check = datetime.min.replace(tzinfo=UTC)
        next_relation_check = datetime.min.replace(tzinfo=UTC)
        while not stopped():
            now = datetime.now(UTC)
            for job in due_jobs(now, state):
                try:
                    if job == "maintain_partitions":
                        log.info("maintain_partitions: %s", maintain_partitions(work))
                    elif job == "retention":
                        with connect("privacy") as priv:
                            priv.autocommit = True
                            run_retention(priv)
                    state.mark(job, now)
                except (psycopg.OperationalError, psycopg.InterfaceError):
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.error("%s failed: %s: %s", job, type(exc).__name__, exc)
            try:
                deliveries.run_all()
                for org, n in runner.run_all().items():
                    if n:
                        log.info("workgraph %s: %d events", org, n)
            except (psycopg.OperationalError, psycopg.InterfaceError):
                raise
            except Exception as exc:  # noqa: BLE001 - never leave the loop for a non-database error
                log.error("projection round failed: %s: %s", type(exc).__name__, exc)
                time.sleep(5)
            if now >= next_onboarding_check:
                _run_onboarding_due(work, state, now)
                _run_workflow_tick(work)
                _run_flow_tick(work)
                _run_quote_followup_tick(work)
                _run_install_event_publish(work)
                _run_install_event_delivery()
                next_onboarding_check = now + timedelta(minutes=1)
            if now >= next_relation_check and relationships_on():
                _run_relation_refresh(work)
                next_relation_check = now + timedelta(hours=1)
            for _ in listen.notifies(timeout=args.poll, stop_after=1):
                pass


def _run_workflow_tick(conn) -> None:
    """SOP-WORKFLOW: once a minute per tenant, waits that are over, steps past their SLA and schedules that are due."""
    for org in active_orgs(conn):
        try:
            with tenant_tx(conn, org):
                ready = "select to_regprocedure('pulse.workflow_tick(timestamp with time zone)') is not null as ready"
                if not conn.execute(ready).fetchone()["ready"]:
                    return
                result = conn.execute("select pulse.workflow_tick() as r").fetchone()["r"]
            if any(result.values()):
                log.info("workflow tick org=%s %s", org, result)
        except (psycopg.OperationalError, psycopg.InterfaceError):
            raise
        except Exception as exc:  # noqa: BLE001 - one tenant's failure never stalls the others
            log.error("workflow tick org=%s failed: %s", org, type(exc).__name__)


def _run_flow_tick(conn) -> None:
    """FLOW-A: once a minute per tenant, Flow's timers that are up and its alert rules (each fires once per run, rule
    and step, to the roles it names, the doer or the data owner; 0800)."""
    for org in active_orgs(conn):
        try:
            with tenant_tx(conn, org):
                ready = "select to_regprocedure('pulse.flow_tick(timestamp with time zone)') is not null as ready"
                if not conn.execute(ready).fetchone()["ready"]:
                    return
                result = conn.execute("select pulse.flow_tick() as r").fetchone()["r"]
            if result.get("active"):
                log.debug("flow tick org=%s %s", org, result)
        except (psycopg.OperationalError, psycopg.InterfaceError):
            raise
        except Exception as exc:  # noqa: BLE001 - one tenant's failure never stalls the others
            log.error("flow tick org=%s failed: %s", org, type(exc).__name__)


def _run_quote_followup_tick(conn) -> None:
    """EST-1238: once a minute per tenant, unanswered quotations whose follow-up hour has come (at most 100 a tenant,
    skip-locked). Each tenant has its own transaction and a 20-second statement budget; a failure is logged and the
    next tenant goes on, and the next minute retries."""
    for org in active_orgs(conn):
        try:
            with tenant_tx(conn, org):
                proc = "pulse.quote_followup_tick(timestamp with time zone)"
                ready = f"select to_regprocedure('{proc}') is not null as ready"
                if not conn.execute(ready).fetchone()["ready"]:
                    return
                conn.execute("set local statement_timeout = '20s'")
                result = conn.execute("select pulse.quote_followup_tick() as r").fetchone()["r"]
            if result.get("due"):
                log.info("quote follow-up tick org=%s %s", org, result)
        except psycopg.errors.QueryCanceled:  # the 20-second budget (a subclass of OperationalError): next tenant
            log.error("quote follow-up tick org=%s timed out; the next minute retries", org)
        except (psycopg.OperationalError, psycopg.InterfaceError):
            raise
        except Exception as exc:  # noqa: BLE001 - one tenant's failure never stalls the others
            log.error("quote follow-up tick org=%s failed: %s", org, type(exc).__name__)


def _run_install_event_publish(conn) -> None:
    """EST-1259: once a minute, number the install's committed events (install-wide, gapless, one advisory lock; the
    function works on install_org() alone). Its own transaction and a 20-second budget; the next minute retries."""
    try:
        with conn.transaction():
            proc = "pulse.install_event_publish(integer)"
            if not conn.execute(f"select to_regprocedure('{proc}') is not null as ready").fetchone()["ready"]:
                return
            conn.execute("set local statement_timeout = '20s'")
            n = conn.execute("select pulse.install_event_publish() as n").fetchone()["n"]
        if n:
            log.info("install events published: %d", n)
    except psycopg.errors.QueryCanceled:
        log.error("install event publish timed out; the next minute retries")
    except (psycopg.OperationalError, psycopg.InterfaceError):
        raise
    except Exception as exc:  # noqa: BLE001 - publishing never stops the worker loop
        log.error("install event publish failed: %s", type(exc).__name__)


def _run_install_event_delivery() -> None:
    """One bounded drain on the existing minute tick; Node shares safe-outbound with the API admin routes."""
    try:
        script = repo_root() / "services/api/dist/install-event-delivery.js"
        result = subprocess.run(["node", str(script)], timeout=32, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, check=False)
        if result.returncode:
            log.error("install event delivery unavailable; next minute retries")
    except (OSError, subprocess.TimeoutExpired):
        log.error("install event delivery unavailable; next minute retries")


def relationships_on(env=os.environ) -> bool:
    """R46's hourly refresh runs only where the server switched relationships on (RELEASE-5: off until the owner's E14,
    as the API's relationships module; services/api/src/modules.ts SERVER_SWITCHED)."""
    return env.get("PULSE_RELATIONSHIPS") == "1"


def _run_relation_refresh(conn) -> None:
    """R46: once an hour per tenant, read the sources for relationship proposals (never a decision) and keep the named
    reviewers' tasks current."""
    for org in active_orgs(conn):
        try:
            with tenant_tx(conn, org):
                ready = "select to_regprocedure('pulse.relation_refresh()') is not null as ready"
                if not conn.execute(ready).fetchone()["ready"]:
                    return
                result = conn.execute("select pulse.relation_refresh() as r").fetchone()["r"]
            if result.get("added") or result.get("changed") or result.get("withdrawn"):
                log.info("relationship refresh org=%s %s", org, result)
        except (psycopg.OperationalError, psycopg.InterfaceError):
            raise
        except Exception as exc:  # noqa: BLE001 - one tenant's failure never stalls the others
            log.error("relationship refresh org=%s failed: %s", org, type(exc).__name__)


def _run_onboarding_due(conn, state: State, now: datetime) -> None:
    """Check each tenant once per loop; successful sorts run hourly and failures use bounded exponential backoff."""
    for org in active_orgs(conn):
        if not state.onboarding_due(str(org), now):
            continue
        try:
            with tenant_tx(conn, org):
                result = sort_org(conn, org)
            state.onboarding_succeeded(str(org), now)
            if "skipped" not in result:
                log.info("onboard sort org=%s groups=%d proposals=%d matched_existing=%d",
                         org, result["folders"], result["proposals"], result["matched_existing"])
        except (psycopg.OperationalError, psycopg.InterfaceError):
            raise
        except Exception as exc:  # noqa: BLE001 - retry this org later without stalling other tenants
            state.onboarding_failed(str(org), now)
            log.error("onboard sort org=%s failed: %s", org, type(exc).__name__)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=os.environ.get("PULSE_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ap = argparse.ArgumentParser(prog="pulse-worker", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--state", default=os.environ.get("PULSE_WORKER_STATE",
                                                     str(Path.home() / ".local/state/pulse/worker.json")))
    r.add_argument("--poll", type=float, default=5.0)
    p = sub.add_parser("project")
    p.add_argument("--org")
    p.add_argument("--rebuild", action="store_true")
    p.add_argument("--fingerprint", action="store_true")
    rules = sub.add_parser("rules")
    rule_sub = rules.add_subparsers(dest="rules_cmd", required=True)
    check = rule_sub.add_parser("check")
    target = check.add_mutually_exclusive_group(required=True)
    target.add_argument("--org", help="validate one organisation UUID")
    target.add_argument("--all", action="store_true", help="validate every active organisation")
    add_onboard_parser(sub)
    sub.add_parser("maintain")
    sub.add_parser("retention")
    args = ap.parse_args(argv)
    if args.cmd == "rules":
        return _rules_check(args)
    if args.cmd == "onboard":
        return args.handler(args)
    return {"run": _run, "project": _project, "maintain": _maintain, "retention": _retention}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
