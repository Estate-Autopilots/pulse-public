#!/usr/bin/env python3
"""Fail-closed client export. Only exact source→destination entries are copied.
Run `sync.py DEST` to prepare/scan, inspect the complete export, then run
`sync.py DEST --reviewed DIGEST` to record that manual review before pushing.
Never use a clone of the private repository as DEST.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name('allowlist.json')

def safe_path(value):
    p = PurePosixPath(value)
    if p.is_absolute() or '..' in p.parts or not p.parts or str(p) != value:
        raise ValueError('Unsafe export path')
    return p

def entries():
    values = json.loads(MANIFEST.read_text())
    destinations = set()
    for e in values:
        safe_path(e['source']); p = safe_path(e['destination'])
        if p.parts[0] not in {'apps','packages','.github','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.nvmrc','rust-toolchain.toml','README.md','LICENSE','.gitignore'}:
            raise ValueError('Path outside client export')
        if e['destination'] in destinations: raise ValueError('Duplicate destination')
        destinations.add(e['destination'])
    return values

def copy_entry(e, destination, allowed):
    if e not in allowed: raise ValueError('Non-allowlisted path cannot be copied')
    source = ROOT / e['source']
    if source.is_symlink() or not source.is_file(): raise ValueError('Only regular files can be copied: '+e['source'])
    if any(p.is_symlink() for p in source.parents if p != ROOT.parent): raise ValueError('Symlink source')
    out = destination / e['destination']
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, out)

# Repo scanner patterns; no secret values are printed and no scanner exceptions are exported.
SECRET = re.compile(r'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?<![\w-])sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[\w-]{35}|xox[abposr]-[\w-]{10,}|\b\d{8,10}:[\w-]{35}|(?:postgres(?:ql)?|mysql|redis)://[^\s:/]+:[^\s@]+@')
BAD_PATH = re.compile(r'(^|/)(?:\.env[^/]*|[^/]*\.(?:p12|p8|pem|key|jks|keystore)|services|db|research|ea-research)(/|$)')

# What an exported file loads must be exported too (DESKTOP-1: from 12 Oct the panel imported address.js and pairing.js
# and core declared `mod server; mod pairing;`, none of them allowlisted, so every public desktop build failed).
IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]''')
PAGE_ASSET = re.compile(r'''<(?:script|link)\b[^>]*\b(?:src|href)=["']((?!/)[^"':#?]+)["']''')
RUST_MOD = re.compile(r'^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;', re.M)
RUST_INCLUDE = re.compile(r'include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)')
BUILD_COPIES = {'apps/desktop/src/companion/': 'packages/companion/src/'}  # apps/desktop/build.mjs

def unresolved(read, names):
    """`file → reference` for each relative import, page script/style, Rust module or include that names a file the
    export lacks. read(name) is an exported file's text; names are the exported paths."""
    def shipped(path):
        return path in names or any(path.startswith(a) and b+path[len(a):] in names for a,b in BUILD_COPIES.items())
    missing=[]
    for name in sorted(names):
        folder,suffix=posixpath.dirname(name),posixpath.splitext(name)[1]
        if suffix not in {'.js','.mjs','.html','.rs'}: continue
        text=read(name)
        refs=IMPORT.findall(text) if suffix in {'.js','.mjs'} else PAGE_ASSET.findall(text) if suffix=='.html' else RUST_INCLUDE.findall(text)
        missing+=[name+' → '+r for r in refs if not shipped(posixpath.normpath(posixpath.join(folder,r)))]
        if suffix=='.rs':
            # `mod x;` in a crate root or mod.rs is x.rs or x/mod.rs beside it; in a.rs it is a/x.rs or a/x/mod.rs.
            root=posixpath.basename(name) in {'lib.rs','main.rs','mod.rs','build.rs'} or posixpath.basename(folder) in {'bin','tests','examples','benches'}
            base=folder if root else name[:-3]
            missing+=[name+' → mod '+m for m in RUST_MOD.findall(text) if not (shipped(posixpath.join(base,m+'.rs')) or shipped(posixpath.join(base,m,'mod.rs')))]
    return missing

def scan(destination, allowed):
    expected = {e['destination'] for e in allowed}
    digest = hashlib.sha256()
    actual = set()
    for p in sorted(destination.rglob('*')):
        relative = p.relative_to(destination).as_posix()
        if relative == '.git' or relative.startswith('.git/'): continue
        if p.is_symlink(): raise ValueError('Export contains symlink')
        if not p.is_file(): continue
        actual.add(relative)
        if relative not in expected or BAD_PATH.search(relative): raise ValueError('Export includes non-allowlisted/sensitive path: '+relative)
        data = p.read_bytes()
        if p.suffix not in {'.png','.ico','.icns'}:
            content = data.decode('utf-8')
            if SECRET.search(content): raise ValueError('Secret scanner rejected '+relative)
            # Only the public production host may refer to our deployment; dependency/documentation URLs are public.
            hosts = re.findall(r'https?://([\w.-]+)',content)
            if any(h.endswith('estateautopilots.com') and h != 'pulse.estateautopilots.com' for h in hosts): raise ValueError('Internal host in '+relative)
            if re.search(r'[\w.+-]+@estateautopilots\.com|/home/eadev|ea-research|pulse-dev\.estate|pulse-staging\.estate',content): raise ValueError('Internal identity/path in '+relative)
        digest.update(relative.encode()+b'\0'+hashlib.sha256(data).digest())
    if actual != expected: raise ValueError('Export missing allowlisted files')
    missing=unresolved(lambda name:(destination/name).read_text(),actual)
    if missing: raise ValueError('Export does not ship what its files load: '+', '.join(missing))
    # Run the repository's exact secret scanner against the candidate, with no private allowlist exceptions.
    script=(ROOT/'tools/check-secrets.sh').read_text()
    script='\n'.join('ROOT=${PULSE_COMPANION_SCAN_ROOT:?}' if line.startswith('ROOT=$(cd ') else line for line in script.splitlines())+'\n'
    result=subprocess.run(['bash','-s','--','--all'],input=script,text=True,capture_output=True,
        env={**os.environ,'PULSE_COMPANION_SCAN_ROOT':str(destination)})
    if result.returncode:raise ValueError('Repository secret scanner rejected public export')
    return digest.hexdigest()

def authorize_release(approved, root=ROOT):
    # Owner authorizes unattended client publication only from the exact accepted train result.
    receipt=json.loads((Path.home()/'.local/state/pulse-release/train.json').read_text())
    deployed=json.loads(Path('/var/lib/ea-watchdog/deploy-production.json').read_text())
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    dirty=subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=root,text=True).strip()
    if dirty or head!=approved or receipt.get('release_sha')!=head or deployed.get('sha')!=head or not deployed.get('healthy'): raise ValueError('Only a clean, healthy exact production release may authorize automatic export')

def release_message(destination):
    # Every export is a desktop-only release for the shared workflows: the phone app (apps/mobile, the Capacitor
    # shell) builds and releases in mobile.yml, and only its explicit promote step moves the Android channel.
    return 'Build reviewed Pulse Companion clients [desktop-only]'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('destination',type=Path);parser.add_argument('--reviewed');parser.add_argument('--release-approved');args=parser.parse_args()
    if args.reviewed and args.release_approved: raise ValueError('Choose manual review or accepted-release authorization')
    if args.release_approved:
        authorize_release(args.release_approved)
    destination=args.destination.resolve()
    if destination == ROOT or ROOT in destination.parents: raise ValueError('Export must be outside private checkout')
    allowed=entries()
    # Rebuild candidate in a separate directory; preserve only the public checkout .git during replacement.
    candidate=destination.with_name(destination.name+'-candidate')
    if candidate.exists(): shutil.rmtree(candidate)
    candidate.mkdir(parents=True)
    for e in allowed: copy_entry(e,candidate,allowed)
    digest=scan(candidate,allowed)
    if args.reviewed and args.reviewed != digest: raise ValueError('Manual review digest is stale')
    if destination.exists():
        remotes=subprocess.run(['git','-C',str(destination),'remote','-v'],capture_output=True,text=True).stdout
        if 'pulse.git' in remotes: raise ValueError('Private git history cannot be exported')
        # Only clean up files generated by the prior explicit manifest, never unrelated data.
        old=set(e['destination'] for e in allowed)
        previous=destination/'.git'/'pulse-export-paths.json'
        if previous.exists(): old.update(json.loads(previous.read_text()))
        for name in old:
            safe_path(name); p=destination/name
            if p.is_file() or p.is_symlink(): p.unlink()
    else: destination.mkdir(parents=True)
    for e in allowed: copy_entry(e,destination,allowed)
    scan(destination,allowed)
    shutil.rmtree(candidate)
    if (destination/'.git').exists():
        (destination/'.git'/'pulse-export-paths.json').write_text(json.dumps(sorted(e['destination'] for e in allowed)))
    print(json.dumps({'files':len(allowed),'sha256':digest,'manualReview':args.reviewed==digest,'releaseApproved':args.release_approved,'secretScan':'pass'}))
    if args.release_approved: authorize_release(args.release_approved)
    if args.reviewed or args.release_approved:
        if not (destination/'.git').exists(): subprocess.run(['git','-C',str(destination),'init','-b','main'],check=True)
        (destination/'.git'/'pulse-export-review.json').write_text(json.dumps({'sha256':digest,'authorization':'accepted production release '+args.release_approved if args.release_approved else 'manual review','checks':['exact allowlist','secret scan','public hosts, no staff identities/data, client code only, no keys']}))
if __name__=='__main__':main()
