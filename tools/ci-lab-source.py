#!/usr/bin/env python3
"""Prepare a new lab source commit with the existing hosted gate, without moving any ref.

Both inputs must be full private commit SHAs. Select an already reviewed gate source;
the resulting exact head still needs independent review before export/publication.
This does not certify a source, publish it, run CI, or change a runtime or policy.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


# The complete EST-1582 execution closure, including both page cells and its tests.
# Product implementations, migrations, fixtures, lockfiles and configuration stay at lab_source.
GATE_FILES = (
    ".github/actions/ci-setup/action.yml",
    ".github/workflows/ci.yml",
    "services/api/test/page-matrix-runner.mjs",
    "tests/e2e/playwright.config.ts",
    "tests/smoke/test_hosted_ci.py",
    "tools/ci-db-shards.py",
    "tools/ci.sh",
    "tools/lane",
)


def git(repo, *args, env=None, data=None):
    return subprocess.run(
        ["git", "-C", str(repo), *args], input=data, capture_output=True,
        check=True, env={**os.environ, **(env or {})},
    ).stdout


def commit_sha(repo, value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("use a full immutable commit SHA, not a ref")
    if git(repo, "rev-parse", value + "^{commit}").decode().strip() != value:
        raise ValueError("not a commit SHA")
    return value


def prepare(repo, lab_source, gate_source):
    lab_source = commit_sha(repo, lab_source)
    gate_source = commit_sha(repo, gate_source)
    if lab_source == gate_source:
        raise ValueError("lab and gate sources must be distinct")
    entries = git(repo, "ls-tree", "-rz", gate_source, "--", *GATE_FILES).split(b"\0")
    blobs = {}
    for entry in filter(None, entries):
        header, path = entry.split(b"\t", 1)
        mode, kind, blob = header.split()
        if mode not in (b"100644", b"100755") or kind != b"blob":
            raise ValueError("gate files must be regular tracked files")
        blobs[path.decode()] = {"mode": mode.decode(), "blob": blob.decode()}
    if set(blobs) != set(GATE_FILES):
        raise ValueError("gate source is missing part of the execution closure")
    with tempfile.TemporaryDirectory(prefix="pulse-lab-source-") as scratch:
        env = {"GIT_INDEX_FILE": str(Path(scratch) / "index")}
        git(repo, "read-tree", lab_source, env=env)
        updates = b"".join(
            f"{blobs[path]['mode']} {blobs[path]['blob']}\t{path}\0".encode()
            for path in GATE_FILES
        )
        git(repo, "update-index", "-z", "--index-info", data=updates, env=env)
        tree = git(repo, "write-tree", env=env).decode().strip()
    changed = git(repo, "diff", "--no-renames", "--name-only", "-z", lab_source, tree)
    paths = [p.decode() for p in changed.split(b"\0") if p]
    if not paths or not set(paths) <= set(GATE_FILES):
        raise ValueError("expected changes only within the hosted gate closure")
    message = (
        "EST-2212: retain lab product source with the existing hosted gate\n\n"
        "New source commit; not equivalent to the original lab SHA.\n"
        f"Lab-Source: {lab_source}\nGate-Source: {gate_source}\n\n"
        "Co-Authored-By: Paperclip <noreply@org-e6af7d.example>\n"
    )
    # Stable dates make the same inputs/author repeatable; neither input's identity is borrowed.
    date = git(repo, "show", "-s", "--format=%cI", gate_source).decode().strip()
    source = git(repo, "commit-tree", tree, "-p", lab_source, data=message.encode(),
                 env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}).decode().strip()
    return {
        "lab_source_sha": lab_source, "gate_source_sha": gate_source,
        "replacement_source_sha": source, "replacement_tree": tree,
        "changed_paths": paths, "gate_blobs": blobs,
        "outside_gate_closure_unchanged": True,
        "refs_updated": False, "published": False, "hosted_receipt": None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--lab-source", required=True)
    parser.add_argument("--gate-source", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = prepare(args.repository, args.lab_source, args.gate_source)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
