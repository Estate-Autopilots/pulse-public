#!/usr/bin/env python3
"""The owner-authorized frequent release train; no dev-to-prod data replay."""
import calendar
import fcntl
import json
import os
import re
import subprocess
import time
from pathlib import Path

state = Path.home() / '.local/state/pulse-release'
last_path = state / 'train.json'
ORIGIN = '/home/eadev/git/pulse.git'
WORKTREE_ROOT = Path('/home/eadev/work/pulse')
REPORT_ROOT = Path('/home/eadev/ea-research')
WORKBENCH_BASE = 'tools/train-workbench-base'
MERGE_MESSAGE = 'Merge committed workbench for scheduled Pulse release'
MIGRATION = re.compile(r'^(\d+)_[A-Za-z0-9_.-]+\.sql$')  # pulse_sdk/migrate.py _FILE
UP = re.compile(r'^--\s*migrate:up[^\n]*\n(.*?)(?=^--\s*migrate:down|\Z)', re.DOTALL | re.MULTILINE)  # up_section
# OPS-2 (15 Oct 2026): the timer checks every 10 minutes; a staging run waits for the watchdog's local CI to pass main.
CI_RESULTS = Path('/var/lib/ea-watchdog/ci/results')
GREEN_WAIT = 2 * 3600   # main without a local CI verdict this long: the train's own strict CI decides
INFRA_RETRY = 3600      # a failure outside the code (a server, deploy or root step): the same pair once more after an hour
STEP_WORDS = {'checkout': 'preparing a fresh copy of the code',
              'merge': "combining the owner's approved changes with the other finished work",
              'ci': 'the automated tests', 'staging-migrate': 'updating the staging database',
              'staging-deploy': 'starting the new version on staging', 'staging-smoke': 'the checks on staging',
              'production-migrate': 'updating the production database',
              'production-deploy': 'starting the new version in production',
              'production-smoke': 'the checks on production', 'publish': 'tagging and publishing the release'}
# DDL that can break older code on a schema that already ran it; redefining a policy, constraint or index is fine.
NOT_ADDITIVE = re.compile(r'\b(drop\s+(table|column|view|materialized\s+view|type|schema|function|sequence)|rename|truncate'
                          r'|alter\s+column\s+\S+\s+(set\s+data\s+)?type|set\s+not\s+null)\b', re.IGNORECASE)


def run(*args, cwd=None, env=None, log=None):
    if args and args[0] == 'git':
        args = ('git', '-c', 'user.name=Pulse release train', '-c', 'user.email=pulse-release@estateautopilots.com', *args[1:])
    if log:
        with open(log, 'w') as file: return subprocess.run(args,cwd=cwd,env=env,stdout=file,stderr=subprocess.STDOUT,check=True)
    return subprocess.run(args,cwd=cwd,env=env,capture_output=True,text=True,check=True)


def root(action, **args):
    (state/'root-action.json').write_text(json.dumps({'action':action,**args}))
    # ea-agent reports inactive for a successful oneshot; inspect the real service result afterward.
    subprocess.run(['sudo','-n','ea-agent','restart','pulse-release-v030.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    result=run('systemctl','show','pulse-release-v030.service','-p','Result','--value').stdout.strip()
    if result!='success': raise RuntimeError('Root operation failed: '+action)


def restart_deployer():
    subprocess.run(['sudo','-n','ea-agent','restart','pulse-local-deploy.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    result=run('systemctl','show','pulse-local-deploy.service','-p','Result','--value').stdout.strip()
    if result!='success': raise RuntimeError('Deployment service failed')


def move_staging(checkout,sha,staging,rewind):
    """Point origin's staging at `sha`. A fast-forward is a plain push. A rewind (EST-787) updates the ref in the bare
    repo with `staging` as the expected old value: the same guarantee as --force-with-lease, but receive.denyNonFastForwards
    (it guards main and production) refuses every non-fast-forward push, forced or not (EST-1268)."""
    if rewind:run('git','--git-dir',ORIGIN,'update-ref','-m','release train: staging rewind (EST-787)','refs/heads/staging',sha,staging)
    else:run('git','push',ORIGIN,'HEAD:staging',cwd=checkout)


def epoch(utc):
    return calendar.timegm(time.strptime(utc,'%Y-%m-%dT%H:%M:%SZ'))


def green(main,last):
    """The watchdog's local CI passed this main (it tests every main within minutes), or gave no verdict for GREEN_WAIT:
    then the train's own strict CI decides. A red main waits for the fix, which is a new main."""
    try:result=json.loads((CI_RESULTS/(main+'.json')).read_text())
    except (OSError,ValueError):result={}
    if result.get('status') in ('pass','fail'):return result['status']=='pass'
    # When this main was first seen waiting: its own file, so train.json (read by FIN-LIVE, the companion export and
    # the shipped-release launcher) keeps only what the train records.
    seen_path=state/'main-seen.json'
    try:seen=json.loads(seen_path.read_text())
    except (OSError,ValueError):seen={}
    if seen.get('sha')!=main:
        seen_path.write_text(json.dumps({'sha':main,'at':time.strftime('%FT%TZ')})+'\n')
        return False
    return time.time()-epoch(seen['at'])>=GREEN_WAIT


def due(snapshot,main,last):
    """'release' when design/home moved since the last release: owner workbench commits and RELEASE-n jobs (EST-760)
    go to staging and, once its smoke passed, to production. 'staging' when only main moved past the last release and
    the last staging run: lane merges reach staging only, never production (EST-761, CEO decision on EST-759); the next
    owner-approved design/home move carries them. None when nothing is due. `staging_main` is the main a staging run
    built on when it had to add production's workbench (EST-787).
    OPS-2 (15 Oct 2026): the timer checks every 10 minutes and a staging run starts as soon as main is green (green()),
    not up to 3 hours later. A failed pair is not retried (EST-321): the fix landing (a new main or design/home)
    starts a new attempt at once; the 6/12-hour back-off after repeated failures is gone, because a red main no longer
    starts a run. A failure outside the code (kind 'infra': a server, deploy or root step on staging) is retried once
    by itself after INFRA_RETRY. `touch ~/.local/state/pulse-release/force` skips one wait (the green check or the hour)."""
    failed=last.get('failed') or {}
    force=(state/'force').exists()
    if snapshot!=last.get('design_sha'):mode='release'
    elif main not in (last.get('release_sha'),last.get('staging_sha'),last.get('staging_main')):mode='staging'
    else:return None
    if failed.get('main')==main and failed.get('design_sha')==snapshot:
        if failed.get('kind')!='infra' or failed.get('retried'):return None
        if not force and time.time()-epoch(failed['at'])<INFRA_RETRY:return None
        failed['retried']=True
        last_path.write_text(json.dumps(last,indent=2)+'\n')
    elif mode=='staging' and not force and not green(main,last):return None
    (state/'force').unlink(missing_ok=True)
    return mode


def workbench_base(checkout,snapshot):
    """The design/home commit a reviewed lane change already carried into main, or None (EST-321).
    The watchdog squash-merges lanes, so that workbench commit never becomes part of main's history and git would
    replay the old conflicts; the train then merges only the workbench's work since that commit."""
    path=Path(checkout)/WORKBENCH_BASE
    lines=[line.strip() for line in path.read_text().splitlines()] if path.exists() else []
    base=next((line for line in lines if line and not line.startswith('#')),None)
    if base is None:return None
    ancestor=lambda older,newer:subprocess.run(['git','merge-base','--is-ancestor',older,newer],cwd=checkout).returncode==0
    if ancestor('HEAD',snapshot):return None  # a reconciled workbench already includes current main
    if ancestor(base,'HEAD'):return None  # a train merge already put it into main's history
    if not ancestor(base,snapshot):raise RuntimeError(WORKBENCH_BASE+' is not part of design/home')
    return base


def duplicate_migrations(checkout,tree):
    """Migration versions that occur more than once in a tree (EST-404).
    Git merges main's and the workbench's `0105_*.sql` without a conflict, but the migrator refuses them."""
    names=run('git','ls-tree','--name-only',tree,'db/migrations/',cwd=checkout).stdout.splitlines()
    versions=[match.group(1) for match in (MIGRATION.match(Path(name).name) for name in names) if match]
    return sorted({version for version in versions if versions.count(version)>1})


def ancestor(checkout,older,newer):
    return subprocess.run(['git','merge-base','--is-ancestor',older,newer],cwd=checkout).returncode==0


def rewound_migrations(checkout,staging,sha):
    """Migrations staging already ran that `sha` lacks and its older code may not survive (EST-787): DDL that is not
    additive, a version `sha` uses for another file (that file would never run on staging), or a file both have with
    other SQL (staging recorded the version, so `sha`'s SQL would never run either)."""
    blobs=lambda tree:dict(line.split(' ',2)[2].split('\t')[::-1] for line in
                           run('git','ls-tree',tree,'db/migrations/',cwd=checkout).stdout.splitlines())
    ours,theirs=blobs(sha),blobs(staging)
    versions={match.group(1) for match in (MIGRATION.match(Path(name).name) for name in ours) if match}
    bad=[Path(name).name for name in sorted(set(ours)&set(theirs)) if ours[name]!=theirs[name] and MIGRATION.match(Path(name).name)]
    for name in sorted(set(theirs)-set(ours)):
        match=MIGRATION.match(Path(name).name)
        if not match:continue
        sql=run('git','show',staging+':'+name,cwd=checkout).stdout
        up=UP.search(sql)
        if match.group(1) in versions or NOT_ADDITIVE.search(re.sub(r'--[^\n]*','',up.group(1) if up else sql)):bad.append(match.group(0))
    return bad


def merge_workbench(checkout,snapshot):
    """Merge the committed workbench into main; a no-op when main already contains it.
    False when the workbench conflicts with main: the run stops, main never ships alone (EST-786).
    Colliding migration versions count as a conflict (EST-404)."""
    if subprocess.run(['git','merge-base','--is-ancestor',snapshot,'HEAD'],cwd=checkout).returncode==0:return True
    base=workbench_base(checkout,snapshot)
    merged=subprocess.run(['git','merge-tree','--write-tree',*(['--merge-base',base] if base else []),'HEAD',snapshot],cwd=checkout,capture_output=True,text=True)
    # A conflict still writes a tree; bad input, hooks or I/O errors stop the train (EST-328 review).
    if merged.returncode==1 and re.fullmatch(r'[0-9a-f]{40,64}',(merged.stdout.splitlines() or [''])[0]):return False
    if merged.returncode:raise subprocess.CalledProcessError(merged.returncode,'git merge-tree',merged.stdout,merged.stderr)
    tree=merged.stdout.split()[0]
    if duplicate_migrations(checkout,tree):return False
    commit=run('git','commit-tree',tree,'-p','HEAD','-p',snapshot,'-m',MERGE_MESSAGE,cwd=checkout).stdout.strip()
    run('git','merge','--ff-only',commit,cwd=checkout)
    return True


def failure_kind(step,error):
    """'code' (a merge or the tests: a fix has to land), 'production' (never retried by itself) or 'infra'."""
    if step in ('merge','ci'):
        return 'infra' if isinstance(error,subprocess.CalledProcessError) and error.returncode==75 else 'code'
    if step.startswith('production') or step=='publish':return 'production'
    return 'infra'


def remember_failure(last,snapshot,main_sha,error,step):
    """Keep the failed pair so the timer does not retry it; True when this starts a run of failures (one heads-up)."""
    try:main_sha=run('git','--git-dir',ORIGIN,'rev-parse','refs/heads/main').stdout.strip()  # includes a train push
    except Exception:pass
    before=last.get('failed') or {}
    first=not last.get('failures')
    last['failures']=(last.get('failures') or 0)+1  # consecutive; a release or staging run resets it
    last['failed']={'design_sha':snapshot,'main':main_sha,'error':type(error).__name__,'at':time.strftime('%FT%TZ'),
                    'step':step,'kind':failure_kind(step,error),
                    'retried':before.get('retried',False) and (before.get('main'),before.get('design_sha'))==(main_sha,snapshot)}
    last_path.write_text(json.dumps(last,indent=2)+'\n')
    return first


def failure_words(step,error,report):
    """What stopped, in plain words, from the run's own receipts."""
    words=STEP_WORDS.get(step,'an early step')
    try:
        if step=='ci':
            failed=re.search(r'^CI result: FAIL \(\d+ failed: ([^;]*);',(report/'ci.log').read_text(errors='replace'),re.M)
            if failed:return words+' failed ('+failed[1]+')'
        if step.endswith('-smoke'):
            check=json.loads((report/(step.removesuffix('-smoke')+'-public-check.json')).read_text())
            if not check.get('passed'):
                detail=re.sub(r'(?:~|\B)/(?:[\w.@-]+/)+[\w.@-]*','',str(check.get('error') or 'no detail'))
                detail=re.sub(r'^\w+Error: ','',re.sub(r'\s+',' ',detail)).strip()[:160]
                return f"{words}: one failed after {len(check.get('checks') or [])} passed ({detail})"
    except (OSError,ValueError,TypeError):pass
    if isinstance(error,subprocess.CalledProcessError) and error.returncode==75:
        return words+' could not start: the server refused heavy work (its disk is nearly full or a hold is on)'
    return words+' failed'


def flaky_note(report):
    try:lines=[line.split('\t')[0] for line in (report/'flaky.txt').read_text().splitlines() if line.strip()]
    except OSError:return ''
    if not lines:return ''
    names='; '.join(line.rsplit('::',1)[-1].rsplit(' › ',1)[-1] for line in lines[:3])
    return f' {len(lines)} browser test(s) failed once and passed on the retry (flaky, worth a look): {names}.'


def moving_again(failures_before):
    """After a run of failures: the heads-up the first failure sent is answered (key train:stopped)."""
    if failures_before:
        subprocess.run(['ea-notify','--resolve','train:stopped','The release train is moving again: the latest changes passed CI and the staging checks.'],
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


def deployed(env,sha):
    deadline=time.monotonic()+2400
    while time.monotonic()<deadline:
        path=Path('/var/lib/ea-watchdog')/('deploy-'+env+'.json')
        data=json.loads(path.read_text()) if path.exists() else {}
        if data.get('sha')==sha and data.get('healthy'):return
        if (data.get('failed') or {}).get('sha')==sha:raise RuntimeError(env+' deployment failed')
        time.sleep(5)
    raise RuntimeError(env+' deployment timed out')


def main():
    state.mkdir(parents=True, exist_ok=True)
    lock = open(state / 'release.lock', 'a')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise SystemExit(0)
    last = json.loads(last_path.read_text()) if last_path.exists() else {}
    failures_before=last.get('failures') or 0
    snapshot=main_sha=None
    checkout=report=None
    outcome='failed'
    step='checkout'
    live_version=last.get('version')
    try:
        snapshot=run('git','-C','/home/eadev/work/pulse/strike','rev-parse','design/home').stdout.strip()
        main_sha=run('git','--git-dir',ORIGIN,'rev-parse','refs/heads/main').stdout.strip()
        mode=due(snapshot,main_sha,last)
        if not mode:raise SystemExit(0)
        stamp=time.strftime('%Y%m%dT%H%M%SZ')
        checkout=WORKTREE_ROOT/('release-train-'+stamp)
        run('/usr/local/bin/ea-heavy','git','--git-dir',ORIGIN,'worktree','add','--detach',str(checkout),'refs/heads/main')
        step='merge'
        tip=base=run('git','rev-parse','HEAD',cwd=checkout).stdout.strip()
        production=run('git','rev-parse','refs/heads/production',cwd=checkout).stdout.strip()  # every release fast-forwards it
        if mode=='release':
            run('git','fetch','/home/eadev/work/pulse/strike','design/home',cwd=checkout)
            # The exact snapshot observed at start is immutable even when the active round commits more work.
            if ancestor(checkout,production,snapshot):
                # Build on the main commit design/home already contains (the RELEASE-n merge), not main's tip: the release
                # is the snapshot, a fast-forward that cannot conflict with lane merges that landed during the job; they
                # wait for the next RELEASE merge (EST-787).
                base=run('git','merge-base','HEAD',snapshot,cwd=checkout).stdout.strip()
                if duplicate_migrations(checkout,snapshot):raise RuntimeError('Workbench repeats a migration version')
                run('git','checkout','-q','--detach',snapshot,cwd=checkout)
            # design/home lacks production (an older train's merge commit): only a main that has not moved since takes
            # the workbench; otherwise the next RELEASE-n merge of main comes first (EST-787).
            elif tip!=production:raise RuntimeError('design/home does not contain production')
            # A conflicting workbench stops before CI, migrate or any push: lane merges never ship without the owner's
            # release. The ops lane or the RELEASE-n job resolves it and moves design/home (EST-786).
            elif not merge_workbench(checkout,snapshot):raise RuntimeError('Workbench conflicts with main')
        elif not ancestor(checkout,production,'HEAD'):
            # Production carries a workbench main has not taken yet (EST-787): lane merges reach staging on top of it,
            # never without it, and main stays at its tip. A conflict waits for the next RELEASE-n merge.
            if not merge_workbench(checkout,production):raise RuntimeError('Workbench conflicts with main')
        # Staging may be ahead on lane merges; rewinding it keeps the schema only when what it ran is additive (EST-787).
        staging=run('git','rev-parse','refs/heads/staging',cwd=checkout).stdout.strip()
        rewind=not ancestor(checkout,staging,'HEAD')
        if rewind and (bad:=rewound_migrations(checkout,staging,'HEAD')):
            raise RuntimeError('Staging ran migrations this run lacks that are not additive: '+', '.join(bad))
        # Everything new since the last release: the workbench snapshot and lane merges alike.
        since=last.get('release_sha') or last.get('design_sha',snapshot)
        change_paths=run('git','diff','--name-only',since,'HEAD',cwd=checkout).stdout.splitlines()
        area_names={'dashboard':'Dashboard','people':'People','chats':'Chats','money':'Money','map':'Map','hr':'HR','projects':'Projects','tasks':'Tasks','settings':'Settings'}
        areas=sorted({label for key,label in area_names.items() if any('/'+key+'/' in path for path in change_paths)})
        changes=', '.join(areas) or 'API and workbench'
        tags=run('git','tag','--list','v0.3.*',cwd=checkout).stdout.split()
        versions=[int(tag.rsplit('.',1)[1]) for tag in tags if re.fullmatch(r'v0\.3\.\d+',tag)]
        version='v0.3.'+str(max(versions,default=0)+1)
        report=REPORT_ROOT/('release-'+version if mode=='release' else 'release-staging-'+stamp)
        report.mkdir(parents=True,exist_ok=True)
        env={**os.environ,'PATH':'/home/eadev/.cargo/bin:/home/eadev/.local/opt/node/bin:/home/eadev/.local/bin:/usr/local/bin:/usr/bin:/bin','PULSE_CI_STRICT':'1','PULSE_PG_DATA':'/home/eadev/.cache/pulse-pg/train','PULSE_PG_PORT':'55434','PULSE_PAGE_MATRIX':'1','PULSE_MATRIX_RECEIPT':str(report/'role-matrix.json'),'PULSE_CI_FLAKY_OUT':str(report/'flaky.txt')}
        step='ci'
        run('/usr/local/bin/ea-heavy','bash','tools/ci.sh',cwd=checkout,env=env,log=report/'ci.log')
        # Production builds generate local Next type paths; preserve committed framework configuration.
        run('git','restore','apps/web/next-env.d.ts','apps/web/tsconfig.json',cwd=checkout)
        sha=run('git','rev-parse','HEAD',cwd=checkout).stdout.strip()
        # main only fast-forwards, never forced, and staging runs leave it. A release that is the design/home snapshot
        # leaves main at its tip when lanes moved it past the base; the workbench reaches main with the next RELEASE
        # merge (EST-787). A train merge design/home lacks must land on main: a concurrent main update stops the run.
        main_now=run('git','--git-dir',ORIGIN,'rev-parse','refs/heads/main').stdout.strip()
        merged=mode=='release' and sha!=base and (main_now==base or sha!=snapshot)
        if merged:run('git','push',ORIGIN,'HEAD:main',cwd=checkout)
        step='staging-migrate'
        root('migrate-staging',sha=sha,report=str(report))
        # Only the staging sha observed before CI may be replaced; the next staging run brings lane work back (EST-787).
        step='staging-deploy'
        move_staging(checkout,sha,staging,rewind)
        restart_deployer()
        deployed('staging',sha)
        step='staging-smoke'
        root('smoke-staging',checkout=str(checkout),report=str(report))
        if mode=='staging':
            # Lane merges stop here: no production migration, push or tag; production waits for the owner (EST-761).
            for key in ('failures','failed'):last.pop(key,None)
            last.update(staging_sha=sha,staging_main=tip,staged_at=time.strftime('%FT%TZ'),staging_report=str(report))
            last_path.write_text(json.dumps(last,indent=2)+'\n')
            (report/'staging.json').write_text(last_path.read_text())
            outcome='staged'
            step='publish'
            run('git','push','git@github-pulse:Estate-Autopilots/pulse.git','+HEAD:staging',cwd=checkout)
            moving_again(failures_before)
            run('ea-notify','-l','info','-t','Pulse staging '+sha[:7],'Changes since the last release: '+changes+'. CI and the staging smoke passed on https://pulse-staging.estateautopilots.com. Production is unchanged until an owner-approved release.'+flaky_note(report))
            return
        # Production migrates only after staging smoked green on the same sha (EST-761).
        step='production-migrate'
        root('migrate-production',sha=sha,report=str(report))
        step='production-deploy'
        run('git','push',ORIGIN,'HEAD:production',cwd=checkout)
        restart_deployer()
        deployed('production',sha)
        step='production-smoke'
        root('smoke-production',checkout=str(checkout),report=str(report))
        step='publish'
        run('git','tag','-a',version,'-m','Pulse '+version,cwd=checkout)
        run('git','push',ORIGIN,version,cwd=checkout)
        # The GitHub mirror force-pushes main and staging every 10 minutes; a run that made no merge must not rewind main.
        run('git','push','git@github-pulse:Estate-Autopilots/pulse.git',*(['main'] if merged else []),'+HEAD:staging','HEAD:production',version,cwd=checkout)
        last_path.write_text(json.dumps({'design_sha':snapshot,'release_sha':sha,'version':version,'released_at':time.strftime('%FT%TZ')},indent=2)+'\n')
        (report/'release.json').write_text(last_path.read_text())
        outcome='released'
        held=' main stays at '+main_now[:7]+': lane merges after '+base[:7]+' wait for the next RELEASE merge, which also brings this workbench to main.' if sha!=base and not merged else ''
        moving_again(failures_before)
        run('ea-notify','-l','important','-t','Pulse '+version+' live','Changes: '+changes+'. CI, staging and production session/role/browser checks passed. https://pulse.estateautopilots.com — '+sha[:12]+'. No data replay; migrations only.'+held+flaky_note(report))
    except SystemExit:raise
    except Exception as error:
        if remember_failure(last,snapshot,main_sha,error,step):
            # OPS-2: one plain heads-up per run of failures (key train:stopped; the next good run resolves it).
            kind=last['failed']['kind']
            again=("It runs again by itself as soon as a fix lands and main's tests pass"
                   +(", and tries this same version once more in an hour in case the server was the cause." if kind=='infra'
                     else "." if kind=='code' else "; it never retries production steps by itself."))
            where=('Production may be part-way through this release, so a person needs to look' if kind=='production'
                   else 'Production is unchanged'+(' ('+live_version+')' if live_version else ''))
            try:run('ea-notify','-l','important','-k','train:stopped','-t','Pulse release train stopped',
                    'The next release stopped at '+failure_words(step,error,report or Path('/nonexistent'))+'. '
                    +where+'. '+again)
            except Exception:pass  # the failure itself is what matters; never mask it
        raise
    finally:
        if checkout and (checkout/'.git').exists():
            # Archive receipts on both success and failure; never mask the release result.
            helper = Path('/home/eadev/.local/lib/ea-sysops/worktrees.py')
            result = subprocess.run(['/usr/local/bin/ea-heavy', '/usr/bin/python3', str(helper),
                                     '--finish', str(checkout), '--outcome', outcome,
                                     *(['--report', str(report)] if report else [])],
                                    capture_output=True, text=True)
            if result.returncode:
                run('ea-notify','-l','important','-k','sysops:train-retention',
                    '-t','Train checkout retention needs inspection',
                    'Receipts/removal did not complete for '+checkout.name+'. Checkout preserved; see SysOps retention receipts.')


if __name__ == '__main__':
    main()
