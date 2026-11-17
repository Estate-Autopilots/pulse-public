#!/usr/bin/env python3
"""Conservative PR impact plan. Full suites for unknown paths, lockfiles, shared contracts and missing refs.
Release/main/nightly CI ignores affected mode. Renames/deletions include both paths.
"""
import argparse,json,re,subprocess
from pathlib import Path
GROUPS=('js','python','schemas','rust','e2e','db','smoke')
def plan(paths,root):
    selected=set();filters=set()
    for path in paths:
        if path.startswith('docs/') or path in {'README.md','CHANGELOG.md','LICENSE'}:continue
        if path.endswith('.md'):
            return {'mode':'full','groups':list(GROUPS),'js_filters':[],'reason':'runtime or agent Markdown change'}
        if path.startswith('apps/desktop/core/') and Path(path).suffix in {'.rs','.toml','.lock'}:
            selected.add('rust');continue
        if path.startswith('apps/desktop/'):
            return {'mode':'full','groups':list(GROUPS),'js_filters':[],'reason':'native application change'}
        if path.startswith(('apps/web/','services/api/','packages/ui-shell/','packages/design-system/','packages/sdk-ts/','infra/web/','tests/e2e/')):
            selected.update(('js','e2e','db','smoke'))
            if path.startswith('tests/e2e/'):directory='tests/e2e'
            else:directory='/'.join(path.split('/')[:2])
            # Explicit directories, never evaluate git paths as shell code. Include dependents AND dependencies.
            if not re.fullmatch(r'[a-zA-Z0-9_/.-]+',directory) or not (root/directory/'package.json').is_file():
                return {'mode':'full','groups':list(GROUPS),'js_filters':[],'reason':'package deletion or unsafe path'}
            filters.add('...{./'+directory+'}...');continue
        # Python/schema/database/tools/config/root lockfiles affect cross-runtime contracts.
        return {'mode':'full','groups':list(GROUPS),'js_filters':[],'reason':'shared or unclassified change: '+path}
    return {'mode':'affected','groups':sorted(selected),'js_filters':sorted(filters),'reason':'known package impact closure; secrets and tool checks always run'}
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base',required=True);ap.add_argument('--head',default='HEAD');ap.add_argument('--output',required=True);a=ap.parse_args();root=Path(__file__).resolve().parent.parent
    # SHAs only from workflow environment, never interpolate branch/user input into a shell.
    if not re.fullmatch(r'[0-9a-f]{7,40}',a.base) or not re.fullmatch(r'(HEAD|[0-9a-f]{7,40})',a.head):result={'mode':'full','groups':list(GROUPS),'js_filters':[],'reason':'invalid base/head'}
    else:
        r=subprocess.run(['git','diff','--name-only','--no-renames','-z',a.base+'...'+a.head],cwd=root,capture_output=True,timeout=30)
        result=plan([p.decode('utf-8',errors='replace') for p in r.stdout.split(b'\0') if p],root) if r.returncode==0 else {'mode':'full','groups':list(GROUPS),'js_filters':[],'reason':'missing merge base'}
    Path(a.output).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
if __name__=='__main__':main()
