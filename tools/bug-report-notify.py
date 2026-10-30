#!/usr/bin/env python3
"""BUG-REPORT (owner, 27 Oct 2026): tell the owner on Telegram when someone reports a bug in Pulse.

Run every minute by the eadev user timer pulse-bug-notify.timer (tools/systemd/). Reads the newest reports through
pulse.reported_bug_feed() (migration 1201) as the database's worker role, read only, and sends one short note per report
through the host's ea-notify (the ea-bot queue: levels, dedupe, quiet hours). The note carries the organisation, the
number, the first 200 characters of what the person wrote, the screen, the severity and a link; never the screenshot,
errors, calls or steps. What was last sent is kept in a small state file, so a restart neither repeats nor floods: the
first run only remembers "now".

    tools/bug-report-notify.py              send what is new
    tools/bug-report-notify.py --dry-run    print what would be sent, change nothing

Environment: BUG_NOTIFY_DATABASE_URL (else PULSE_DATABASE_URL_WORKER from the unit's EnvironmentFile),
BUG_NOTIFY_LINK (default https://pulse.estateautopilots.com), BUG_NOTIFY_STATE (default
~/.local/state/pulse-bug-notify/last), BUG_NOTIFY_LABEL (a prefix such as "dev", default none).
"""
import datetime as dt
import os
import subprocess
import sys
from pathlib import Path

import psycopg

STATE = Path(os.environ.get('BUG_NOTIFY_STATE', Path.home() / '.local/state/pulse-bug-notify/last'))
LINK = os.environ.get('BUG_NOTIFY_LINK', 'https://pulse.estateautopilots.com').rstrip('/')
LABEL = os.environ.get('BUG_NOTIFY_LABEL', '').strip()
SEVERITY = {'blocker': 'Blocker', 'high': 'High', 'medium': 'Medium', 'low': 'Low'}


def main() -> int:
    dry = '--dry-run' in sys.argv
    url = os.environ.get('BUG_NOTIFY_DATABASE_URL') or os.environ.get('PULSE_DATABASE_URL_WORKER')
    if not url:
        print('bug-report-notify: no database address', file=sys.stderr)
        return 2
    now = dt.datetime.now(dt.timezone.utc)
    if not STATE.exists():
        if not dry:
            STATE.parent.mkdir(parents=True, exist_ok=True)
            STATE.write_text(now.isoformat())
        print('bug-report-notify: first run, starting from now')
        return 0
    after = dt.datetime.fromisoformat(STATE.read_text().strip())
    with psycopg.connect(url, autocommit=True) as db:
        if db.execute("select to_regprocedure('pulse.reported_bug_feed(timestamptz,integer)') is null as missing").fetchone()[0]:
            print('bug-report-notify: migration 1201 is not applied here yet')
            return 0
        rows = db.execute('select id, org_name, number, words, route, blocks_work, severity, platform, reporter, signed_out, created_at'
                          ' from pulse.reported_bug_feed(%s, 20)', (after,)).fetchall()
    for (rid, org, number, words, route, blocks, severity, platform, reporter, signed_out, created) in rows:
        level = 'important' if blocks or severity in ('blocker', 'high') else 'info'
        tags = [t for t in [SEVERITY.get(severity or ''), 'stops their work' if blocks else None, platform, 'signed out' if signed_out else None] if t]
        title = f"{LABEL + ' ' if LABEL else ''}Bug #{number} · {org}"
        text = f"{words}\n{reporter or 'Someone'} on {route} ({', '.join(tags)})\n{LINK}/bug-reports?id={rid}"
        if dry:
            print(f'[{level}] {title}\n{text}\n')
        else:
            subprocess.run(['ea-notify', '-l', level, '-k', f'pulse-bug:{rid}', '-t', title, text], check=True, timeout=30)
            STATE.write_text(created.isoformat())
    return 0


if __name__ == '__main__':
    sys.exit(main())
