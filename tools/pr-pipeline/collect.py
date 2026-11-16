#!/usr/bin/env python3
"""PR-PIPELINE host collector: work signals that live on the server, not in Pulse's database, into each company's PR
pipeline; then the pipeline's tick and the creative renderer. Run every 6 hours by pulse-pr-pipeline@<env>.timer.

    collect.py --env dev|staging|production [--config FILE] [--org UUID] [--dry-run] [--no-render] [--render-only] [--since ISO]
    collect.py --url postgresql://... --config FILE        (a scratch database, for tests)

Signals (per company, from its config's sources; a repository that is not on this host is skipped, never cloned):
  * commits and merges (git log of the configured ref): one event each, attributed to the configured person (or an
    author map), its topic from the subject's prefix ("FEATURE-NAME: …" -> lane:FEATURE-NAME; the inner prefix when two);
  * releases: version tags (vX.Y.Z), and deploys: the reflog of a production ref, each joined to its nearest tag;
  * lane reports: *.md whose last line is "<NAME>: DONE|PARTIAL …" (BLOCKED is never told).
Every event carries a proof link (the commit URL when the config gives one, else git:<repo>@<sha>, report:<file>).
The database deduplicates (by key and by fingerprint, so a rebased commit is the same work), skips private-looking
lines and does nothing for a company whose pipeline is off (pulse.pr_work_ingest). Then pulse.pr_pipeline_tick(true)
groups, scores and turns new milestones into ideas, and the queued creatives are rendered and checked (render.mjs).

Config (outside the repo: ~/.config/pulse-pr-pipeline/<env>.json; example: tools/pr-pipeline/config.example.json):
  {"orgs": [{"org": uuid, "brand": uuid|null, "person": uuid|null, "authors": {"email or name": person uuid},
             "repos": [{"path", "name", "ref": "HEAD", "commitUrl": "https://host/x/commit/{sha}"|null, "brand": uuid|null,
                        "tags": true}],
             "laneReports": dir|null, "deploys": {"repo": path, "ref": "production", "name": "app"}|null}]}
Database URLs come from the env files (worker role; row security applies) and are never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENVS = {"dev": ("/etc/estate-autopilots/db/pulse_dev.env", "DATABASE_URL"),
        "staging": ("/etc/estate-autopilots/db/pulse_staging_worker.env", "PULSE_STAGING_DATABASE_URL"),
        "production": ("/etc/estate-autopilots/db/pulse.env", "PULSE_DATABASE_URL_WORKER")}
PREFIX = re.compile(r"^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*):\s+")
REPORT_END = re.compile(r"^\**([A-Z0-9][A-Z0-9-]*)\**:\s*\**(DONE|PARTIAL|BLOCKED)\**\b[\s:.,;—–-]*(.*)$")
TAG = re.compile(r"^v?\d+\.\d+(\.\d+)?$")
SAFE = re.compile(r"[^A-Za-z0-9._@:/-]+")


# ------------------------------------------------------------------------------------------------ pure helpers
def topic_of(subject: str) -> tuple[str, str]:
    """("lane:NAME", subject without prefixes) from "OUTER: NAME: words" (the inner prefix names the work)."""
    names, rest = [], subject.strip()
    while (m := PREFIX.match(rest)) and len(names) < 3:
        names.append(m.group(1))
        rest = rest[m.end():]
    return (f"lane:{names[-1]}" if names else ""), rest


def parse_report(text: str) -> tuple[str, str, str] | None:
    """(name, status, words) from a lane report's last non-empty line, or None."""
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    if not lines:
        return None
    m = REPORT_END.match(lines[-1])
    return (m.group(1), m.group(2), m.group(3).strip()) if m else None


def proof_for(repo: dict, sha: str) -> str:
    url = repo.get("commitUrl")
    if isinstance(url, str) and url.startswith("https://") and "{sha}" in url:
        return url.replace("{sha}", sha)
    return "git:" + SAFE.sub("-", repo.get("name") or Path(repo["path"]).name) + "@" + sha[:12]


def person_for(org: dict, email: str, name: str):
    authors = org.get("authors") or {}
    return authors.get(email.lower()) or authors.get(name) or org.get("person")


# ------------------------------------------------------------------------------------------------ signals
def git(path: str, *args: str) -> str:
    bare = path.endswith(".git") and not (Path(path) / ".git").exists()
    cmd = ["git", f"--git-dir={path}"] if bare else ["git", "-C", path]
    r = subprocess.run(cmd + list(args), capture_output=True, text=True, timeout=120, check=False)
    return r.stdout if r.returncode == 0 else ""


def repo_events(org: dict, repo: dict, since: datetime) -> list[dict]:
    path = repo["path"]
    if not Path(path).exists():
        return []
    name = repo.get("name") or Path(path).name.removesuffix(".git")
    out = []
    log = git(path, "log", repo.get("ref") or "HEAD", f"--since={since.isoformat()}", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1e")
    for rec in log.split("\x1e"):
        f = rec.strip("\n").split("\x1f")
        if len(f) != 6:
            continue
        sha, an, ae, at, parents, subject = f
        topic, words = topic_of(subject)
        merge = len(parents.split()) > 1
        out.append({"source": "merge" if merge else "commit", "key": f"git:{name}:{sha}", "at": at, "title": subject[:240],
                    "detail": words[:400], "proof": proof_for(repo, sha), "repo": name, "topic": topic, "actor": an[:120],
                    "person": person_for(org, ae, an), "brand": repo.get("brand") or org.get("brand")})
    if repo.get("tags", True):
        refs = git(path, "for-each-ref", "refs/tags", "--format=%(refname:short)%1f%(creatordate:iso-strict)%1f%(objectname)%1f%(*objectname)")
        for line in refs.splitlines():
            tag, at, obj, peeled = (line.split("\x1f") + ["", "", ""])[:4]
            if not TAG.match(tag) or not at or datetime.fromisoformat(at) < since:
                continue
            out.append({"source": "release", "key": f"tag:{name}:{tag}", "at": at, "title": f"{name} {tag} released",
                        "proof": proof_for(repo, peeled or obj), "repo": name, "topic": f"release:{tag}", "person": org.get("person"),
                        "brand": repo.get("brand") or org.get("brand")})
    return out


def deploy_events(org: dict, dep: dict, since: datetime) -> list[dict]:
    path, ref = dep.get("repo"), dep.get("ref") or "production"
    log = Path(path or "/nonexistent") / "logs/refs/heads" / ref
    if not log.is_file():
        return []
    out = []
    for line in log.read_text(errors="ignore").splitlines():
        head, _, msg = line.partition("\t")
        parts = head.split()
        if len(parts) < 4:
            continue
        new, ts = parts[1], parts[-2]
        if not ts.isdigit() or set(new) == {"0"}:
            continue
        at = datetime.fromtimestamp(int(ts), timezone.utc)
        if at < since:
            continue
        tag = git(path, "describe", "--tags", "--abbrev=0", new).strip()
        name = dep.get("name") or Path(path).name.removesuffix(".git")
        out.append({"source": "deploy", "key": f"deploy:{name}:{ref}:{new}", "at": at.isoformat(),
                    "title": f"{name} {tag or new[:8]} live in {ref}", "detail": msg[:200], "proof": proof_for({"name": name, **dep}, new),
                    "repo": name, "topic": f"release:{tag}" if tag else "", "person": org.get("person"), "brand": org.get("brand")})
    return out


def report_events(org: dict, folder: str, since: datetime) -> list[dict]:
    p = Path(folder or "/nonexistent")
    if not p.is_dir():
        return []
    out = []
    for f in sorted(p.glob("*.md")):
        at = datetime.fromtimestamp(f.stat().st_mtime, timezone.utc)
        if at < since:
            continue
        r = parse_report(f.read_text(encoding="utf-8", errors="ignore")[-4000:])
        if not r or r[1] == "BLOCKED":
            continue
        name, status, words = r
        out.append({"source": "lane_report", "key": f"report:{name}:{status}", "at": at.isoformat(),
                    "title": f"{name} {status.lower()}: {words}"[:240], "detail": f"{status} {words}"[:2000], "proof": f"report:{f.name}",
                    "topic": f"lane:{name}", "status": status, "person": org.get("person"), "brand": org.get("brand")})
    return out


def signals(org: dict, since: datetime) -> list[dict]:
    ev = []
    for repo in org.get("repos") or []:
        ev += repo_events(org, repo, since)
    if org.get("deploys"):
        ev += deploy_events(org, org["deploys"], since)
    if org.get("laneReports"):
        ev += report_events(org, org["laneReports"], since)
    return ev


# ------------------------------------------------------------------------------------------------ database
def env_url(env: str) -> str:
    path, key = ENVS[env]
    for line in Path(path).read_text().splitlines():
        if line.startswith(key + "="):
            return shlex.split(line.split("=", 1)[1])[0]
    raise SystemExit(f"{key} is missing from the {env} env file")


def connect(url: str):
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(url, row_factory=dict_row, application_name="pulse-pr-pipeline", autocommit=True)
    # An env file with one app login that is a member of every service role works as the worker (as pulse_sdk does).
    r = conn.execute("select current_user u, pg_has_role('pulse_worker','member') m").fetchone()
    if r["u"] != "pulse_worker" and r["m"]:
        conn.execute("set role pulse_worker")
    return conn


def tenant(conn, org: str):
    conn.execute("select set_config('pulse.org_id', %s, true), set_config('pulse.viewer_id', '', true)", (org,))


def ingest_and_tick(conn, org: str, events: list[dict]) -> dict:
    from psycopg.types.json import Jsonb
    added = 0
    with conn.transaction():
        tenant(conn, org)
        if conn.execute("select to_regprocedure('pulse.pr_work_ingest(jsonb)') is not null ok").fetchone()["ok"] is not True:
            return {"skipped": "the database has no PR pipeline yet"}
        for i in range(0, len(events), 2000):
            added += conn.execute("select pulse.pr_work_ingest(%s) n", (Jsonb(events[i:i + 2000]),)).fetchone()["n"]
        tick = conn.execute("select pulse.pr_pipeline_tick(true) r").fetchone()["r"]
    return {"added": added, "tick": tick}


def render_queue(conn, org: str, limit: int = 20) -> dict:
    """Render the company's queued creatives (render.mjs) and store each PNG with its checks."""
    import checks
    import fill
    from psycopg.types.json import Jsonb
    with conn.transaction():
        tenant(conn, org)
        if conn.execute("select to_regprocedure('pulse.pr_creative_queue(integer)') is not null ok").fetchone()["ok"] is not True:
            return {"rendered": 0}
        rows = conn.execute("select * from pulse.pr_creative_queue(%s)", (limit,)).fetchall()
    if not rows:
        return {"rendered": 0}
    with tempfile.TemporaryDirectory(prefix="pr-render-") as tmp:
        jobs, meta = [], {}
        for r in rows:
            cid = str(r["id"])
            job = {"id": cid, "layout": r["layout"], "size": r["size"], "theme": r["theme"], "slots": r["slots"], "slide": r["slide"], "of": r["slides"]}
            page, w, h, _kit = fill.render_job(job, r["brand"], r["mark"], r["mark_mime"])
            html = Path(tmp) / f"{cid}.html"
            html.write_text(page, encoding="utf-8")
            jobs.append({"id": cid, "html": str(html), "w": w, "h": h, "out": str(Path(tmp) / f"{cid}.png")})
            texts = fill.copy_text(r["slots"])
            meta[cid] = {"spelling": checks.spelling(texts, [r["brand"].get("name", ""), r["brand"].get("byline", "")]), "privacy": checks.privacy(texts)}
        (Path(tmp) / "jobs.json").write_text(json.dumps(jobs))
        res_file = Path(tmp) / "results.json"
        node = os.environ.get("PR_PIPELINE_NODE", "node")
        p = subprocess.run([node, str(HERE / "render.mjs"), str(Path(tmp) / "jobs.json"), str(res_file)], capture_output=True, text=True, timeout=900, check=False)
        results = json.loads(res_file.read_text()) if res_file.is_file() else {}
        done = failed = passed = 0
        for j in jobs:
            r = results.get(j["id"]) or {"ok": False, "error": (p.stderr or "render failed")[-300:]}
            with conn.transaction():
                tenant(conn, org)
                if r.get("ok") and Path(j["out"]).is_file():
                    c = {**r["checks"], **meta[j["id"]]}
                    ok = all(v.get("ok") for v in c.values())
                    conn.execute("select pulse.pr_creative_rendered(%s, %s, %s, %s, '')", (j["id"], Path(j["out"]).read_bytes(), Jsonb(c), ok))
                    done += 1
                    passed += ok
                    if os.environ.get("PR_PIPELINE_KEEP"):
                        keep = Path(os.environ["PR_PIPELINE_KEEP"])
                        keep.mkdir(parents=True, exist_ok=True)
                        (keep / f"{j['id']}.png").write_bytes(Path(j["out"]).read_bytes())
                        (keep / f"{j['id']}.json").write_text(json.dumps(c, indent=1))
                else:
                    conn.execute("select pulse.pr_creative_rendered(%s, null, '{}', false, %s)", (j["id"], str(r.get("error", ""))[:500]))
                    failed += 1
    return {"rendered": done, "passedChecks": passed, "failed": failed}


# ------------------------------------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env", choices=sorted(ENVS))
    ap.add_argument("--url", help="a database URL instead of --env (scratch databases)")
    ap.add_argument("--config")
    ap.add_argument("--state")
    ap.add_argument("--org")
    ap.add_argument("--since")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--render-only", action="store_true")
    a = ap.parse_args(argv)
    if not a.env and not a.url:
        ap.error("--env or --url")
    name = a.env or "scratch"
    cfg_path = Path(a.config or Path.home() / f".config/pulse-pr-pipeline/{name}.json")
    cfg = json.loads(cfg_path.read_text())
    state_path = Path(a.state or Path.home() / f".local/state/pulse-pr-pipeline/{name}.json")
    state = json.loads(state_path.read_text()) if state_path.is_file() else {}
    now = datetime.now(timezone.utc)
    conn = None if a.dry_run else connect(a.url or env_url(a.env))
    sys.path.insert(0, str(HERE))
    summary = {}
    for org in cfg.get("orgs") or []:
        oid = org["org"]
        if a.org and a.org != oid:
            continue
        since = datetime.fromisoformat(a.since) if a.since else (datetime.fromisoformat(state[oid]) - timedelta(days=1) if oid in state else now - timedelta(days=30))
        out = {}
        if not a.render_only:
            ev = signals(org, since)
            out["signals"] = {s: sum(1 for e in ev if e["source"] == s) for s in sorted({e["source"] for e in ev})}
            if conn is not None:
                out.update(ingest_and_tick(conn, oid, ev))
                state[oid] = now.isoformat()
        if conn is not None and not a.no_render:
            out["render"] = render_queue(conn, oid)
        summary[oid] = out
    if conn is not None and not a.render_only:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state))
    print(json.dumps({"env": name, "at": now.isoformat(), "orgs": summary}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
