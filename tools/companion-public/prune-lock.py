#!/usr/bin/env python3
"""Generate the build-only lockfile from the existing client dependency graph (requires PyYAML)."""
import re
from pathlib import Path
import yaml
root=Path(__file__).resolve().parents[2]
x=yaml.safe_load((root/'pnpm-lock.yaml').read_text())
importers=['.','apps/desktop','apps/mobile','apps/chrome-extension','packages/companion','packages/design-system']
x['importers']={k:v for k,v in x['importers'].items() if k in importers}
pending=[]
for importer in x['importers'].values():
 for section in ['dependencies','devDependencies','optionalDependencies']:
  for name,value in importer.get(section,{}).items():
   version=value['version']
   if not version.startswith('link:'):pending.append(name+'@'+version)
seen=set()
while pending:
 key=pending.pop()
 if key in seen:continue
 if key not in x['snapshots']:raise ValueError('Missing locked client dependency '+key)
 seen.add(key)
 for section in ['dependencies','optionalDependencies']:
  for name,version in x['snapshots'][key].get(section,{}).items():
   if not version.startswith('link:'):pending.append(name+'@'+version)
x['snapshots']={k:v for k,v in x['snapshots'].items() if k in seen}
packages={re.sub(r'\(.*','',k) for k in seen}
x['packages']={k:v for k,v in x['packages'].items() if k in packages}
(root/'tools/companion-public/templates/pnpm-lock.yaml').write_text(yaml.safe_dump(x,sort_keys=False,width=1000))
print(f'Client lock: {len(importers)} importers, {len(packages)} dependencies')
