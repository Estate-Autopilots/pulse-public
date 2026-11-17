#!/usr/bin/env python3
"""SPEED-TELEMETRY (owner, 14 Nov 2026): the daily speed report. For every company: the owner's targets (screen change
p90 under 1 s, an API call p90 under 500 ms as people waited, a full page load p90 under 3 s; SPEED-2) for the last 24 hours
beside the 7 days before, the worst screens and calls, and what got slower (regressions). Screens, routes and counts
only: no person, no content. Movements the page spent partly hidden (x.bg) are left out, as on /telemetry.

Read-only: the API login (row security per company, as the app), every transaction READ ONLY. Writes one Markdown file.
Proposed with tools/systemd/pulse-speed-report.{service,timer}; NOT installed or enabled by the lane that wrote it.

Usage: PULSE_DATABASE_URL_API=... tools/speed-report.py [--out DIR] [--date YYYY-MM-DD]
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

TARGETS = {'route': 1000, 'api': 500, 'load': 3000}  # SPEED-2 (owner, 15 Nov 2026); were 1.5 s / 800 ms / 4 s
FG = "not coalesce(e.detail ? 'bg', false)"
CUR = "e.at >= now() - interval '24 hours'"
WIN = "e.at >= now() - interval '8 days' and e.source = 'client' and e.duration_ms is not null and " + FG


def psql(url, sql, org=None):
    opts = '-c default_transaction_read_only=on -c statement_timeout=120000'
    if org:
        opts += f' -c pulse.org_id={org}'
    out = subprocess.run(['psql', url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], capture_output=True, text=True,
                         env={**os.environ, 'PGOPTIONS': opts}, timeout=300)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip().splitlines()[-1] if out.stderr.strip() else 'psql failed')
    return out.stdout.strip()


def rows(url, sql, org):
    text = psql(url, f'select coalesce(json_agg(x), \'[]\') from ({sql}) x', org)
    return json.loads(text or '[]')


def p90(where):
    return f"round(percentile_cont(0.9) within group (order by e.duration_ms) filter (where {where}))::int"


def company(url, org):
    name = psql(url, 'select name from pulse.org where id = pulse.current_org()', org) or org
    head = rows(url, f"""select {p90(f"e.kind = 'nav.route' and {CUR}")} route, {p90(f"e.kind = 'nav.route' and not {CUR}")} route_before,
        {p90(f"e.kind = 'nav.load' and {CUR}")} load, {p90(f"e.kind = 'nav.load' and not {CUR}")} load_before,
        {p90(f"e.kind = 'api' and {CUR}")} api, {p90(f"e.kind = 'api' and not {CUR}")} api_before,
        count(distinct e.person_id) filter (where {CUR})::int people, count(*) filter (where e.kind in ('nav.route','nav.load') and {CUR})::int views
      from pulse.telemetry_event e where {WIN} and e.kind in ('nav.route','nav.load','api')""", org)[0]
    per = lambda kinds, min_n: rows(url, f"""select e.name, count(*) filter (where {CUR})::int n, {p90(CUR)} p90, {p90(f'not {CUR}')} before,
        count(*) filter (where not {CUR})::int n_before
      from pulse.telemetry_event e where {WIN} and e.kind in ({kinds}) and e.name is not null
      group by e.name having count(*) filter (where {CUR}) >= {min_n} order by p90 desc nulls last limit 40""", org)
    return name, head, per("'nav.route','nav.load'", 2), per("'api'", 3)


def regressions(items):
    """Slower than the week before by 25% and 300 ms or more, seen often enough both times to mean it."""
    out = [i for i in items if i['p90'] and i['before'] and i['n_before'] >= 5 and i['p90'] - i['before'] >= 300 and i['p90'] >= i['before'] * 1.25]
    return sorted(out, key=lambda i: i['p90'] - i['before'], reverse=True)[:8]


def ms(x):
    if x is None:
        return '–'
    return f'{x} ms' if x < 1000 else f'{x / 1000:.1f} s'


def verdict(x, target):
    return '–' if x is None else ('on target' if x <= target else f'{x / target:.1f}× target')


def report(url, day):
    orgs = psql(url, 'select * from pulse.list_active_orgs()').split()
    lines = [f'# Pulse speed report, {day}', '',
             'Last 24 hours against the 7 days before, per company. p90 = the slowest 1 in 10. Targets: screen change '
             '< 1 s, API call < 500 ms (as people waited), full page load < 3 s. Background time left out.', '']
    for org in orgs:
        try:
            name, h, pages, api = company(url, org)
        except RuntimeError as e:
            lines += [f'## {org}', '', f'Could not read: {e}', '']
            continue
        if not h.get('views') and not api:
            continue
        n_people = h.get('people') or 0
        lines += [f"## {name} ({n_people} {'person' if n_people == 1 else 'people'}, {h.get('views') or 0} screens opened)", '',
                  '| Target | Now | Week before | |', '|---|---|---|---|',
                  f"| Screen change p90 | {ms(h.get('route'))} | {ms(h.get('route_before'))} | {verdict(h.get('route'), TARGETS['route'])} |",
                  f"| API call p90 | {ms(h.get('api'))} | {ms(h.get('api_before'))} | {verdict(h.get('api'), TARGETS['api'])} |",
                  f"| Full load p90 | {ms(h.get('load'))} | {ms(h.get('load_before'))} | {verdict(h.get('load'), TARGETS['load'])} |", '']
        lines += ['Worst screens: ' + ('; '.join(f"`{p['name']}` {ms(p['p90'])} ({p['n']})" for p in pages[:5]) or 'none'), '',
                  'Worst API calls: ' + ('; '.join(f"`{a['name']}` {ms(a['p90'])} ({a['n']})" for a in api[:5]) or 'none'), '']
        worse = regressions(pages) + regressions(api)
        lines += ['Slower than the week before: ' + ('; '.join(f"`{w['name']}` {ms(w['before'])} → {ms(w['p90'])}" for w in worse) or 'nothing'), '']
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(Path.home() / 'ea-research/flow/reports/speed-daily'))
    ap.add_argument('--date', default=dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).date().isoformat())
    a = ap.parse_args()
    url = os.environ.get('PULSE_DATABASE_URL_API')
    if not url:
        sys.exit('PULSE_DATABASE_URL_API is not set')
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f'speed-{a.date}.md').write_text(report(url, a.date))
    print(out / f'speed-{a.date}.md')


if __name__ == '__main__':
    main()
