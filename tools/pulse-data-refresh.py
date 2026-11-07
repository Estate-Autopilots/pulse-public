#!/usr/bin/env python3
"""03:00 IST prod snapshots. Active dev rounds and local test edits are preserved.

OPS-2 (15 Oct 2026): on 14 Oct 21:30 UTC the refresh stopped staging, ea-heavy refused its dump (the disk was under its
16 GiB floor) and staging stayed stopped for 10 hours. Now the refresh does not start when the disk cannot hold the
dumps (staging keeps yesterday's data and keeps running), and afterwards staging must answer its health check: if it
does not within 5 minutes, root's pulse-staging-health.service is asked to start it, and the owner hears once."""
import fcntl
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

RESERVE = 16 * 2**30 + 3 * 2**30  # ea-heavy's floor plus room for the production and staging dumps
STAGING = 'http://127.0.0.1:4102/healthz'

state=Path.home()/'.local/state/pulse-release'
state.mkdir(parents=True,exist_ok=True)
lock=open(state/'release.lock','a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit(0)


def staging_up(wait=0):
    deadline=time.monotonic()+wait
    while True:
        try:
            with urllib.request.urlopen(STAGING,timeout=10) as answer:
                if answer.status==200:return True
        except OSError:pass
        if time.monotonic()>=deadline:return False
        time.sleep(15)


def bring_staging_back():
    if staging_up(300):return
    subprocess.run(['sudo','-n','ea-agent','restart','pulse-staging-health.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if staging_up(120):
        print('Staging did not answer after the refresh; its health check started it again.');return
    subprocess.run(['ea-notify','-l','important','-k','staging:down','-t','Staging is down',
                    'Staging did not come back after the nightly data refresh, so release checks cannot run. Production is not affected.'])


def action(name):
    (state/'root-action.json').write_text(json.dumps({'action':name}))
    subprocess.run(['sudo','-n','ea-agent','restart','pulse-release-v030.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    result=subprocess.check_output(['systemctl','show','pulse-release-v030.service','-p','Result','--value'],text=True).strip()
    if result!='success':
        bring_staging_back()
        raise SystemExit('Nightly '+name+' failed; previous data was retained')


disk=os.statvfs('/')
if disk.f_bavail*disk.f_frsize<RESERVE:
    print(f'Staging refresh skipped: {disk.f_bavail*disk.f_frsize/2**30:.0f} GiB free, the dumps need the 16 GiB floor plus 3. '
          'Staging keeps yesterday\'s data and keeps running.');raise SystemExit(0)
action('refresh-staging')
bring_staging_back()
if not (state/'dev-refresh-approved-idle').exists():
    print('Staging refreshed from production. Dev retained: no round-complete idle marker.');raise SystemExit(0)
# The root broker rechecks active engines and the tracked worktree immediately before stopping any dev writer.
action('refresh-dev')
print('Staging and idle dev refreshed from production snapshots; earlier databases and 0600 dumps retained.')
