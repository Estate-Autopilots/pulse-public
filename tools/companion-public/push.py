#!/usr/bin/env python3
"""Push only the exact scanned export with an up-to-date manual review receipt."""
import argparse
import json
from pathlib import Path
import subprocess
import sync
parser=argparse.ArgumentParser();parser.add_argument('destination',type=Path);parser.add_argument('--branch',default='main');args=parser.parse_args();
if args.branch not in {'main','validation/r15c-updater','validation/r15b-inbox-chats','validation/r15d-pulse-app','validation/mobile-shell','validation/r21-android-surfaces','validation/presence-onboard','validation/qa-e2e','validation/polish2','validation/desktop-1'}:raise SystemExit('Only main or isolated Companion validation branches are allowed')
dest=args.destination.resolve()
review=json.loads((dest/'.git/pulse-export-review.json').read_text())
digest=sync.scan(dest,sync.entries())
if review['sha256']!=digest:raise ValueError('Export changed since manual review')
repo='https://github.com/Estate-Autopilots/pulse-companion.git'
remotes=subprocess.run(['git','-C',str(dest),'remote','get-url','origin'],capture_output=True,text=True)
if remotes.returncode:subprocess.run(['git','-C',str(dest),'remote','add','origin',repo],check=True)
elif remotes.stdout.strip()!=repo:raise ValueError('Wrong destination repository')
roots=subprocess.check_output(['git','-C',str(dest),'rev-list','--max-parents=0','--all'],text=True).splitlines()
for root in roots:
 if subprocess.run(['git','-C',str(sync.ROOT),'cat-file','-e',root+'^{commit}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise ValueError('Private history found in public checkout')
for key,value in [('user.name','Pulse Companion build sync'),('user.email','companion-build@users.noreply.github.com')]:subprocess.run(['git','-C',str(dest),'config',key,value],check=True)
subprocess.run(['git','-C',str(dest),'add','--all'],check=True)
if subprocess.run(['git','-C',str(dest),'diff','--cached','--quiet']).returncode:
 subprocess.run(['git','-C',str(dest),'commit','-m',sync.release_message(dest)],check=True)
subprocess.run(['git','-C',str(dest),'-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push','origin','HEAD:'+args.branch],check=True)
print('Public sync pushed; exact allowlist, secret scan and authorization digest verified')
