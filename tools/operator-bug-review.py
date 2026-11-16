#!/usr/bin/env python3
"""AGENT-OPERATOR (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 T4.2.2): the daily review of the problems AI employees filed.

When an AI employee's step on a person's screen does not work, Pulse files it as a bug with the AI employee as the
reporter (migration 2080; one report per problem, "happened again" notes on it). Once a day this job:
  1. reads the open groups with activity in the last day (pulse.operator_bug_groups, as the database's worker role);
  2. for each one not yet reviewed since its last activity, asks a model on this server to research the cause in
     Pulse's own code (read only: Read, Grep, Glob in the checkout) and answer with {cause, fix, lesson};
  3. writes the finding back (pulse.operator_bug_review): a note on the first report ("Likely cause … Proposed fix …
     Playbook …"), the group's other reports folded into it, and the lesson added to that AI employee's playbook
     (one of its standing rules, source "review", which every later run reads; an admin retires it on its profile).

What goes to the model: the screen's route pattern, the error, the AI employee's steps (action names and the words of
what it clicked or filled) and its own one-line report. Never the screenshot, a person's typed values, or any message.

    tools/operator-bug-review.py              review what is new
    tools/operator-bug-review.py --dry-run    print the groups and what the model says, change nothing
    tools/operator-bug-review.py --no-model   only list the groups

Environment: OPERATOR_REVIEW_DATABASE_URL (else PULSE_DATABASE_URL_WORKER from the unit's EnvironmentFile),
OPERATOR_REVIEW_CMD (default: claude -p with read-only tools), OPERATOR_REVIEW_REPO (the checkout the model reads,
default this file's repository), OPERATOR_REVIEW_MAX (groups per run, default 10), OPERATOR_REVIEW_HOURS (default 26).
"""
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

REPO = Path(os.environ.get('OPERATOR_REVIEW_REPO', Path(__file__).resolve().parents[1]))
CMD = os.environ.get('OPERATOR_REVIEW_CMD', 'claude -p --output-format text --allowedTools Read,Grep,Glob')
MAX = int(os.environ.get('OPERATOR_REVIEW_MAX', '10'))
HOURS = int(os.environ.get('OPERATOR_REVIEW_HOURS', '26'))
TIMEOUT = 420

PROMPT = """You review a problem an AI employee met while working the Pulse web app for a person (Pulse is a Next.js
app in apps/web and a Fastify API in services/api; the AI works pages through the screen tools in
apps/web/app/agent-ui: screen_read gives a map of the page, then screen_click / screen_fill by ids).

The problem (seen {times} times since {first_at}):
- Screen (route pattern): {route}
- What it reported: {words}
- Error: {error}
- Its steps before it (oldest first): {trail}

Research the likely cause in this repository (read only). Decide whether it is a product bug (the page or a tool is
wrong) or a playbook problem (the AI used the wrong words, ids or order). Then answer with ONE JSON object and nothing
else:
{{"cause": "<one or two plain sentences>", "fix": "<the change to make, naming the file when it is code; or 'none: playbook only'>",
 "lesson": "<one sentence, at most 300 characters, the AI employee should follow next time on this screen, starting with 'On <screen in plain words>,'; empty if there is no lesson>"}}
Plain words, no ids, no names of people or clients."""


def trail_text(trail) -> str:
    steps = []
    for s in (trail or [])[-12:]:
        if not isinstance(s, dict):
            continue
        status = {200: 'ok', 500: 'did not work', 403: 'refused'}.get(s.get('status'), 'waiting')
        name = re.sub(r'\s+', ' ', str(s.get('name') or ''))[:80]
        steps.append(f"{s.get('kind')}{f' “{name}”' if name else ''} ({status})")
    return '; '.join(steps) or 'none'


def ask_model(group: dict) -> dict | None:
    errors = group.get('errors') or []
    error = next((e.get('message') for e in errors if isinstance(e, dict) and e.get('message')), '') or 'unknown'
    prompt = PROMPT.format(times=group['times'], first_at=group['first_at'].strftime('%d %b %Y'), route=group['route'],
                           words=re.sub(r'\s+', ' ', group['words'] or '')[:400], error=error[:300], trail=trail_text(group.get('trail')))
    try:
        out = subprocess.run(shlex.split(CMD), input=prompt, capture_output=True, text=True, timeout=TIMEOUT, cwd=REPO)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f'operator-bug-review: the model did not answer ({type(e).__name__})', file=sys.stderr)
        return None
    found = re.findall(r'\{[^{}]*"cause"[^{}]*\}', out.stdout, re.S)
    if not found:
        print(f'operator-bug-review: no JSON in the model\'s answer (exit {out.returncode})', file=sys.stderr)
        return None
    try:
        got = json.loads(found[-1])
    except json.JSONDecodeError:
        return None
    clean = {k: re.sub(r'\s+', ' ', str(got.get(k) or '')).strip() for k in ('cause', 'fix', 'lesson')}
    clean['cause'], clean['fix'], clean['lesson'] = clean['cause'][:700], clean['fix'][:700], clean['lesson'][:300]
    if len(clean['lesson']) < 12:
        clean['lesson'] = ''
    return clean if clean['cause'] else None


def main() -> int:
    dry, no_model = '--dry-run' in sys.argv, '--no-model' in sys.argv
    url = os.environ.get('OPERATOR_REVIEW_DATABASE_URL') or os.environ.get('PULSE_DATABASE_URL_WORKER')
    if not url:
        print('operator-bug-review: no database address', file=sys.stderr)
        return 2
    with psycopg.connect(url, autocommit=True, row_factory=dict_row) as db:
        groups = db.execute("select * from pulse.operator_bug_groups(now() - make_interval(hours => %s))", (HOURS,)).fetchall()
        todo = [g for g in groups if not g['reviewed']][:MAX]
        print(f'operator-bug-review: {len(groups)} open group(s) with activity, {len(todo)} to review')
        done = 0
        for g in todo:
            print(f"- {g['org_name']}: #{g['first_number']} on {g['route']} ({g['times']}x, {g['agent_name']})")
            if no_model:
                continue
            finding = ask_model(g)
            if not finding:
                continue
            print(f"  cause: {finding['cause']}\n  fix: {finding['fix']}\n  lesson: {finding['lesson'] or '(none)'}")
            if dry:
                continue
            r = db.execute('select pulse.operator_bug_review(%s,%s,%s) r', (g['org_id'], g['fingerprint'], Jsonb(finding))).fetchone()['r']
            if r:
                done += 1
                print(f"  written on #{r['number']}: {r['folded']} folded in, playbook {'updated' if r.get('ruleId') else 'unchanged'}")
        print(f'operator-bug-review: {done} reviewed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
