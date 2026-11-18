#!/usr/bin/env python3
"""Counts-only baseline of the installed company, to prove a change left EA unchanged (EST-652).

Read-only: one read-only transaction that is rolled back. It refuses to run unless current_database() is
pulse_staging or pulse, then sets pulse.org_id to the install's company (pulse.install_org()). The connection URL
comes from PULSE_RELEASE_TEST_URL (the root release broker passes it; never printed). The output holds counts and
configuration only: no people's names, emails or ids.

  tools/qa/ea-baseline.py                      # baseline JSON on stdout
  tools/qa/ea-baseline.py --diff old.json      # only the keys that changed: {"key": [old, new]}; {} when unchanged
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

ALLOWED_DATABASES = ('pulse_staging', 'pulse')
URL_ENV = 'PULSE_RELEASE_TEST_URL'
# Row identity, actors and timestamps are not company configuration; generic config rows drop these columns.
NOT_CONFIG = re.compile(r'^(id|slug)$|_id$|_by$|_at$')
PRIVATE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[^@\s]+@[^@\s]+\.[^@\s]+', re.IGNORECASE)
CURRENT = "current_date between valid_from and coalesce(valid_to, 'infinity')"


class Refused(Exception):
    pass


def config_row(row: dict | None) -> dict | None:
    return None if row is None else {k: v for k, v in sorted(row.items()) if not NOT_CONFIG.search(k)}


def counts(conn: psycopg.Connection, query: str) -> dict:
    return {str(r['k']): r['n'] for r in conn.execute(query).fetchall()}


def baseline(conn: psycopg.Connection) -> dict:
    """Counts and configuration of the company in pulse.org_id. The caller sets the tenant."""
    org = conn.execute('select to_jsonb(o) j from pulse.org o where o.id = pulse.current_org()').fetchone()
    if not org:
        raise Refused('the install company is not visible: pulse.org_id is not set')
    policy = conn.execute('select to_jsonb(h) j from pulse.hr_policy h where h.org_id = pulse.current_org()').fetchone()
    hr_policy = config_row(policy and policy['j'])
    if hr_policy is not None:
        hr_policy['confirmed'] = policy['j'].get('confirmed_at') is not None
    pods = conn.execute("""select count(p.id) filter (where p.status = 'active') n from pulse.unit u
        left join pulse.project p on p.org_id = u.org_id and p.unit_id = u.id
        where u.org_id = pulse.current_org() and u.kind = 'pod' and u.valid_to is null group by u.id""").fetchall()
    people = counts(conn, """select side k, count(*)::int n from pulse.person
        where org_id = pulse.current_org() and status = 'active' group by side order by side""")
    return {
        'org': config_row(org['j']),
        'people': {'active': sum(people.values()), 'active_by_side': people},
        'roles': {
            'assigned': counts(conn, f"""select role_key k, count(distinct person_id)::int n from pulse.role_assignment
                where org_id = pulse.current_org() and {CURRENT} group by role_key order by role_key"""),
            'profile': counts(conn, """select pp.role k, count(*)::int n from pulse.people_profile pp
                join pulse.person p on p.id = pp.person_id and p.status = 'active'
                where pp.org_id = pulse.current_org() group by pp.role order by pp.role"""),
        },
        'projects': {
            'by_status': counts(conn, """select status k, count(*)::int n from pulse.project
                where org_id = pulse.current_org() group by status order by status"""),
            'active_without_pod': conn.execute("""select count(*)::int n from pulse.project p
                where p.org_id = pulse.current_org() and p.status = 'active' and not exists (select 1 from pulse.unit u
                  where u.id = p.unit_id and u.kind = 'pod' and u.valid_to is null)""").fetchone()['n'],
        },
        'clients': {
            'by_status': counts(conn, """select coalesce(status, 'none') k, count(*)::int n from pulse.client
                where org_id = pulse.current_org() group by 1 order by 1"""),
        },
        # Pod names can name people, so pods are a count and their active-project counts, largest first.
        'pods': {'current': len(pods), 'active_projects': sorted((r['n'] for r in pods), reverse=True)},
        'tenant_config': {f"{r['doc_kind']}/{r['doc_key']}": r['version'] for r in conn.execute(
            """select doc_kind, doc_key, version from pulse.tenant_config
               where org_id = pulse.current_org() and is_active order by doc_kind, doc_key""").fetchall()},
        'hr_policy': hr_policy,
        'leave_requests_last_30_days': conn.execute("""select count(*)::int n from pulse.leave_request
            where org_id = pulse.current_org() and created_at >= now() - interval '30 days'""").fetchone()['n'],
    }


def assert_private_free(value) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            assert_private_free(key)
            assert_private_free(item)
    elif isinstance(value, list):
        for item in value:
            assert_private_free(item)
    elif isinstance(value, str) and PRIVATE.search(value):
        raise Refused('the baseline would contain an id or an email; nothing printed')


def read_baseline(url: str, allowed: tuple[str, ...] = ALLOWED_DATABASES) -> dict:
    with psycopg.connect(url, row_factory=dict_row, options='-c default_transaction_read_only=on') as conn:
        conn.execute('set transaction read only')
        database = conn.execute('select current_database() db').fetchone()['db']
        if database not in allowed:
            raise Refused(f'refusing to run on database {database!r}: only {", ".join(allowed)}')
        owner = conn.execute('select pg_get_userbyid(datdba) r from pg_database where datname = current_database()'
                             ).fetchone()['r']
        conn.execute(sql.SQL('set local role {}').format(sql.Identifier(owner)))
        org = conn.execute('select pulse.install_org() org').fetchone()['org']
        if not org:
            raise Refused('this Pulse install is not initialised')
        conn.execute("select set_config('pulse.org_id', %s, true)", (str(org),))
        result = baseline(conn)
        conn.rollback()
    result = {'meta': {'database': database, 'taken_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
              **json.loads(json.dumps(result, default=str))}
    assert_private_free(result)
    return result


def flatten(value, prefix: str = '') -> dict:
    if isinstance(value, dict) and value:
        out = {}
        for key, item in value.items():
            out.update(flatten(item, f'{prefix}.{key}' if prefix else str(key)))
        return out
    return {prefix: value}


def diff(old: dict, new: dict) -> dict:
    """Changed keys as {dotted.key: [old, new]}; a missing key is null. meta (database, time) is not compared."""
    before = flatten({k: v for k, v in old.items() if k != 'meta'})
    after = flatten({k: v for k, v in new.items() if k != 'meta'})
    return {k: [before.get(k), after.get(k)] for k in sorted(before.keys() | after.keys())
            if before.get(k) != after.get(k)}


def main(argv: list[str] | None = None, allowed: tuple[str, ...] = ALLOWED_DATABASES) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--diff', type=Path, metavar='OLD_JSON', help='print only the keys that changed since OLD_JSON')
    args = ap.parse_args(argv)
    url = os.environ.get(URL_ENV)
    if not url:
        print(f'ea-baseline: {URL_ENV} is not set', file=sys.stderr)
        return 2
    try:
        old = None
        if args.diff:
            old = json.loads(args.diff.read_text())
            assert_private_free(old)
        current = read_baseline(url, allowed)
        out = diff(old, current) if old is not None else current
        assert_private_free(out)
    except Refused as error:
        print(f'ea-baseline: {error}', file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError):
        print('ea-baseline: --diff input could not be read as JSON; nothing printed', file=sys.stderr)
        return 2
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
