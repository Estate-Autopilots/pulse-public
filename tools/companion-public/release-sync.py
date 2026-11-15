#!/usr/bin/env python3
"""Automatic client export from a healthy production train result; never exports a workbench."""
import fcntl
import json
from pathlib import Path
import subprocess
import sys

REPO='https://github.com/Estate-Autopilots/pulse-companion.git'
state=Path.home()/'.local/state/pulse-companion-sync'
state.mkdir(parents=True,exist_ok=True)
with (state/'lock').open('a') as lock:
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:raise SystemExit(0)
 train=json.loads((Path.home()/'.local/state/pulse-release/train.json').read_text())
 sha=train['release_sha']
 if not isinstance(sha,str) or len(sha)!=40 or any(c not in '0123456789abcdef' for c in sha):raise ValueError('Invalid accepted release SHA')
 previous=json.loads((state/'last.json').read_text()) if (state/'last.json').exists() else {}
 if previous.get('release_sha')==sha:raise SystemExit(0)
 checkout=Path('/home/eadev/work/pulse')/('companion-sync-'+sha)
 def run(*args,**kwargs):return subprocess.run(args,check=True,text=True,capture_output=True,**kwargs)
 if not checkout.exists():run('git','clone','--no-checkout','/home/eadev/git/pulse.git',str(checkout))
 run('git','checkout','--detach',sha,cwd=checkout)
 config=json.loads((checkout/'apps/desktop/src-tauri/tauri.conf.json').read_text())
 if config.get('plugins',{}).get('updater',{}).get('pubkey','UNPROVISIONED')=='UNPROVISIONED':raise SystemExit('Updater signing has not been provisioned; no public push')
 allowed=json.loads((checkout/'tools/companion-public/allowlist.json').read_text())
 if previous.get('release_sha'):
  changed=set(run('git','diff','--name-only',previous['release_sha'],sha,cwd=checkout).stdout.splitlines())
  if not changed.intersection(e['source'] for e in allowed):
   (state/'last.json').write_text(json.dumps({'release_sha':sha,'clientChanged':False})+'\n');raise SystemExit(0)
 destination=state/'public'
 if not destination.exists():run('git','clone',REPO,str(destination))
 else:
  run('git','fetch','origin','main',cwd=destination)
  # Reject conflicts; never reset or force-push an independently changed public repository.
  run('git','merge','--ff-only','origin/main',cwd=destination)
 sync=checkout/'tools/companion-public/sync.py';push=checkout/'tools/companion-public/push.py'
 scan=run('/usr/local/bin/ea-heavy',sys.executable,str(sync),str(destination),'--release-approved',sha).stdout
 # The push tool scans the same snapshot again and checks its exact authorization digest.
 run('/usr/local/bin/ea-heavy',sys.executable,str(push),str(destination))
 (state/'last.json').write_text(json.dumps({'release_sha':sha,'clientChanged':True,'scan':json.loads(scan)})+'\n')
 print('Accepted client release exported; public hosted build/publication starts automatically.')
