#!/usr/bin/env python3
"""tests/core in parallel shards, each on a fresh copy of one migrated template database (OPS-2, 15 Oct 2026).

tools/ci-db.sh runs this when PULSE_CI_DATABASE_URL is a superuser on a throwaway server (tools/pg-scratch.sh, the CI
service container); before, one pytest ran the whole suite (30 minutes on a quiet server, 80 when it was busy).

  1. Template: the database the suite's session fixture builds (bootstrap_scratch, every migration, the event
     registry) is built once per content of db/, packages/schemas, pulse_sdk, the suite's conftest and this file, and
     kept as pulse_ci_tmpl_<hash> for the next run (the newest two are kept).
  2. Shards: the test files are split into PULSE_CI_DB_SHARDS groups (default 2: the owner's two-worker cap; one when
     the runner's cgroup allows under 6 GiB of memory, as pulse-local-ci's MemoryMax=4G does) by their
     measured seconds in tests/core/ci-shards.json. Each shard is one pytest over its files in name order, on its own
     copy of the template (CREATE DATABASE ... TEMPLATE) and its own TMPDIR; the shards run side by side. Files listed
     under "alone" run afterwards with nothing beside them: R47/R48/R49 start `next dev` servers (they rewrite
     apps/web/tsconfig.json), and R47's import history did not appear beside another shard (2 of 2 runs on 15 Oct)
     while it passed alone in 16 s.
  3. A browser test that fails in a parallel shard is retried once alone after all of that (conftest's
     PULSE_CI_RETRY_LATER): R47 and UX-5B failed beside the other shard, immediate retries included, and passed
     alone. A shard whose only failures pass alone counts as passed, and those tests are listed as flaky; anything
     else that failed fails the run.
  4. The copies are dropped, also when a shard fails or the run is stopped. Exit 1 when any shard failed. Every
     output line carries "[db N]"; the summary names each shard's files, time and result and the slowest files.
  5. RAM cluster (EST-1575, PULSE_PG_TMPFS=1, which tools/ci.sh sets for strict local runs such as the release train):
     the run starts its own PostgreSQL with its data in /dev/shm/pulse-pg-<uid>/run-<pid>-<time> (mode 0700, Unix
     socket only, inside that directory) and fsync, synchronous_commit and full_page_writes off: settings that are
     safe only because the data is thrown away. It is admitted only while MemAvailable covers its cap
     (PULSE_PG_TMPFS_MB, default 1536 MiB) plus 3 GiB per parallel shard, /dev/shm has the cap free and the runner's
     memory limit allows both; a run that grows past the cap is stopped and fails. A flock owned by this process
     marks the cluster as live; the next RAM run first stops and removes clusters whose owner died (before its own
     admission, so a dead run's cluster cannot keep every later run out), signalling only a process that its
     postmaster.pid names with that directory and that runs postgres with -D on it. The cluster is stopped and
     removed when the run ends, fails or is stopped, also during its start; a write error in the evidence never
     strands it nor changes the run's result. When it is refused or cannot start, the run uses the disk scratch
     server it was given and says so; PULSE_PG_TMPFS=require fails instead. The shared disk server is never
     restarted or changed.
  6. Evidence (EST-1575): the storage, SHOW of the durability settings, each shard's CPU seconds, CPU and memory
     pressure, the lowest MemAvailable and highest swap seen, pytest --durations=10 per shard and the ten slowest
     individual tests with setup, call and teardown apart. The JUnit files, the phase times and summary.json outlive
     tools/ci.sh's temporary directory in PULSE_CI_DB_REPORT_DIR (default ~/.local/state/pulse-ci/db/<time>-<sha>,
     the newest 30 kept).

  uv run --all-packages python tools/ci-db-shards.py
  PULSE_CI_PYTEST_ARGS="-x -k chats"        extra pytest arguments for every shard
  PULSE_CI_DURATIONS_OUT=<file>             write the measured seconds per file (to refresh tests/core/ci-shards.json)
  PULSE_PG_TMPFS=0|1|require                the RAM cluster (5); PULSE_PG_TMPFS_MB its cap in MiB
  PULSE_CI_DB_REPORT_DIR=<dir>              where the evidence (6) goes
The database URL is never printed. Leftover run databases of runs that died (pulse_ci_run_<time>_<pid>[_s<n>], older
than 12 hours, process gone) are dropped: they are throwaway copies, never data.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import select
import shlex
import shutil
import signal
import stat
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from pulse_sdk import migrate

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests/core"
PLAN = TESTS / "ci-shards.json"
HASHED = ("db", "packages/schemas", "packages/sdk-py/src/pulse_sdk", "tests/core/conftest.py", "tools/ci-db-shards.py")
KEEP_TEMPLATES = 2
LEFTOVER = re.compile(r"^pulse_ci_run_(\d{10})_(\d+)(?:_s\d+)?$")
LOCK_KEY = 0x5055_4C53  # serialises template builds on one server
SHARD_MEMORY = 6 * 2**30  # two shards each run a browser, a web server and an API at their peaks
RAM_ROOT = Path("/dev/shm")
RAM_CAP_MIB = 1536  # measured 16-19 Oct: template 40 MB, run copies 40-91 MB each, WAL capped at 256 MB below
RAM_PORT = 5432  # names the socket inside the private directory only
RAM_CONF = """jit = off
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 120
shared_buffers = 64MB
max_wal_size = 256MB
min_wal_size = 32MB
listen_addresses = ''
unix_socket_permissions = 0700
"""
SHOWN = ("fsync", "synchronous_commit", "full_page_writes", "wal_level", "shared_buffers", "max_wal_size")
# One sample of /proc/meminfo, /proc/pressure and this cgroup's memory files every 10 s while the shards run (a few
# small reads; in RAM mode also one walk of the cluster directory, about 20k entries): bounded to this run.
SAMPLE_S = 10
REPORT_ROOT = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "pulse-ci/db"
KEEP_REPORTS = 30
PRINT = threading.Lock()


def with_db(url: str, name: str) -> str:
    """The admin URL pointed at another database, in the same form (tests read URLs and conninfo strings alike)."""
    if "://" in url:
        return urlunsplit(urlsplit(url)._replace(path="/" + name))
    return make_conninfo(url, dbname=name)


def ident(name: str) -> sql.Identifier:
    assert re.fullmatch(r"pulse_ci_[a-z0-9_]+", name), name
    return sql.Identifier(name)


def template_key() -> str:
    digest = hashlib.sha256()
    for base in HASHED:
        top = ROOT / base
        for path in sorted([top] if top.is_file() else top.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                digest.update(str(path.relative_to(ROOT)).encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def tidy(admin: psycopg.Connection, keep: str) -> None:
    """Older templates beyond the newest two, half-built templates and run copies whose run died."""
    templates = [r[0] for r in admin.execute(
        r"select datname from pg_database where datname ~ '^pulse_ci_tmpl_[0-9a-f]{16}$' order by oid desc")]
    stale = [t for t in templates if t != keep][KEEP_TEMPLATES - 1:]
    for name, in admin.execute(r"select datname from pg_database where datname ~ '^pulse_ci_tmpl_[0-9a-f]{16}_build_\d+$'"):
        if not alive(int(name.rsplit("_", 1)[1])):
            stale.append(name)
    for name, in admin.execute(r"select datname from pg_database where datname ~ '^pulse_ci_run_\d{10}_\d+(_s\d+)?$'"):
        m = LEFTOVER.match(name)
        if m and time.time() - int(m[1]) > 12 * 3600 and not alive(int(m[2])):
            stale.append(name)
    for name in stale:
        admin.execute(sql.SQL("drop database if exists {} with (force)").format(ident(name)))
    if stale:
        print(f"dropped {len(stale)} old template or leftover run database(s)", flush=True)


def ensure_template(admin_url: str) -> tuple[str, float | None]:
    """(template name, build seconds or None when an earlier run's template was reused)."""
    name = f"pulse_ci_tmpl_{template_key()}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute("select pg_advisory_lock(%s)", (LOCK_KEY,))
        try:
            if admin.execute("select 1 from pg_database where datname = %s", (name,)).fetchone():
                tidy(admin, name)
                return name, None
            started = time.monotonic()
            building = f"{name}_build_{os.getpid()}"
            admin.execute(sql.SQL("drop database if exists {} with (force)").format(ident(building)))
            admin.execute(sql.SQL("create database {}").format(ident(building)))
            try:
                # Exactly what tests/core/conftest.py's session fixture does in superuser mode.
                with psycopg.connect(with_db(admin_url, building), autocommit=True) as conn:
                    migrate.bootstrap_scratch(conn)
                migrator = make_conninfo(with_db(admin_url, building), user="pulse_migrator_login", password=None)
                with psycopg.connect(migrator, autocommit=True) as conn:
                    migrate.migrate(conn, owner="pulse_owner", verbose=False)
                    migrate.sync_registry(conn, owner="pulse_owner")
            except BaseException:
                admin.execute(sql.SQL("drop database if exists {} with (force)").format(ident(building)))
                raise
            admin.execute(sql.SQL("alter database {} rename to {}").format(ident(building), ident(name)))
            tidy(admin, name)
            return name, time.monotonic() - started
        finally:
            admin.execute("select pg_advisory_unlock(%s)", (LOCK_KEY,))


def plan(files: list[str], shards: int, *, isolated: bool = False
         ) -> tuple[list[tuple[float, list[str]]], tuple[float, list[str]]]:
    """(the parallel shards, the files that run alone afterwards). Longest first onto the least-loaded shard; each
    shard then runs its files in name order."""
    data = json.loads(PLAN.read_text()) if PLAN.exists() else {}
    seconds = data.get("seconds", {})
    default = statistics.median(seconds.values()) if seconds else 10.0
    alone = sorted(f for f in files if f in data.get("alone", [])) if not isolated else []
    files = [f for f in files if f not in alone]
    units, grouped = [], set()
    for group in data.get("together", []):
        members = [f for f in files if f in group]
        if members:
            units.append((sum(seconds.get(f, default) for f in members), members))
            grouped.update(members)
    units += [(seconds.get(f, default), [f]) for f in files if f not in grouped]
    loads: list[list] = [[0.0, []] for _ in range(shards)]
    for weight, members in sorted(units, key=lambda u: (-u[0], u[1])):
        target = min(loads, key=lambda load: load[0])
        target[0] += weight
        target[1].extend(members)
    unknown = [f for f in files if f not in seconds]
    if unknown:
        print(f"no measured time yet for {', '.join(unknown)} (counted as {default:.0f} s; refresh {PLAN.name})",
              flush=True)
    shards_planned = [(load, sorted(members)) for load, members in loads if members]
    return shards_planned, (sum(seconds.get(f, default) for f in alone), alone)


def hosted_plan(files: list[str], cell: str):
    """One isolated hosted cell; the page matrix owns its complete file, including API assertions."""
    if cell in ("page", "page1", "page2"):
        return plan(["test_access_matrix.py"], 1, isolated=True)
    if cell not in {f"{n:02}" for n in range(1, 11)}:
        raise ValueError("PULSE_CI_DB_CELL must be 01..10 or page")
    cells, alone = plan([f for f in files if f != "test_access_matrix.py"], 10, isolated=True)
    if len(cells) != 10:
        raise ValueError("expected ten nonempty database cells")
    return [cells[int(cell) - 1]], alone


def file_seconds(junit: Path) -> dict[str, float]:
    out: dict[str, float] = {}
    try:
        root = ET.parse(junit).getroot()
    except (OSError, ET.ParseError):
        return out
    for case in root.iter("testcase"):
        stem = next((part for part in (case.get("classname") or "").split(".") if part.startswith("test_")), None)
        if stem:
            out[stem + ".py"] = out.get(stem + ".py", 0.0) + float(case.get("time") or 0)
    return out


def failed_tests(junit: Path) -> set[str]:
    """Node ids of the test cases that failed or errored in a junit report."""
    out: set[str] = set()
    try:
        root = ET.parse(junit).getroot()
    except (OSError, ET.ParseError):
        return out
    for case in root.iter("testcase"):
        if case.find("failure") is None and case.find("error") is None:
            continue
        parts = (case.get("classname") or "").split(".")
        at = next((i for i, part in enumerate(parts) if part.startswith("test_")), None)
        if at is None:
            out.add(case.get("name") or "")
            continue
        out.add("::".join(["/".join(parts[:at + 1]) + ".py", *parts[at + 1:], case.get("name") or ""]))
    return out


def run_shard(number: int, targets: list[str], url: str, tmp: Path, extra: list[str], result: dict,
              env_extra: dict | None = None) -> None:
    shard_tmp = tmp / f"shard{number}"
    shard_tmp.mkdir()
    plugins = str(ROOT / "tools/pytest_plugins")
    env = {**os.environ, "PULSE_CI_DATABASE_URL": url, "PULSE_CI_PREMIGRATED": "1", "PULSE_CI_SHARD": str(number),
           "TMPDIR": str(shard_tmp), "PULSE_CI_PHASES_OUT": str(tmp / f"phases{number}.jsonl"),
           "PYTHONPATH": os.pathsep.join(filter(None, [plugins, os.environ.get("PYTHONPATH")])), **(env_extra or {})}
    cmd = [sys.executable, "-m", "pytest", *targets, "-q", "-p", "no:cacheprovider", "-p", "pulse_phase_times",
           "--durations=10", "-W", "ignore::DeprecationWarning", f"--junitxml={tmp}/shard{number}.xml", *extra]
    started = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            errors="replace", bufsize=1)
    result["proc"] = proc
    for line in proc.stdout:
        with PRINT:
            sys.stdout.write(f"[db {number}] {line}")
            sys.stdout.flush()
    try:  # wait4: the CPU seconds of pytest and of the processes it waited for (browsers, servers)
        _, status, usage = os.wait4(proc.pid, 0)
        proc.returncode = os.waitstatus_to_exitcode(status)
        result["cpu"] = usage.ru_utime + usage.ru_stime
    except ChildProcessError:  # already reaped by the cleanup in main()
        proc.wait()
    result.update(rc=proc.returncode, seconds=time.monotonic() - started)


def memory_limit() -> int | None:
    """The tightest cgroup v2 memory.max above this process (pulse-local-ci runs with MemoryMax=4G), or None."""
    try:
        path = Path("/proc/self/cgroup").read_text().split("::", 1)[1].strip().splitlines()[0]
    except (OSError, IndexError):
        return None
    limits, node = [], Path("/sys/fs/cgroup" + path)
    while node != Path("/sys/fs/cgroup").parent:
        try:
            value = (node / "memory.max").read_text().strip()
            if value.isdigit():
                limits.append(int(value))
        except OSError:
            pass
        node = node.parent
    return min(limits) if limits else None


# --- evidence (EST-1575) ------------------------------------------------------------------------------------------

def own_cgroup() -> Path | None:
    try:
        path = Path("/proc/self/cgroup").read_text().split("::", 1)[1].strip().splitlines()[0]
    except (OSError, IndexError):
        return None
    node = Path("/sys/fs/cgroup" + path)
    return node if node.is_dir() else None


def pressure(path: Path) -> dict[str, dict[str, float]]:
    """{"some": {"avg10": .., "total": ..}, "full": {...}} from a PSI file, {} when it cannot be read."""
    out: dict[str, dict[str, float]] = {}
    try:
        for line in path.read_text().splitlines():
            kind, *fields = line.split()
            out[kind] = {k: float(v) for k, v in (f.split("=", 1) for f in fields)}
    except (OSError, ValueError):
        return {}
    return out


def keyed(path: Path) -> dict[str, int]:
    """A "key value" file (cpu.stat, memory.stat) or /proc/meminfo (kB values turned into bytes)."""
    out: dict[str, int] = {}
    try:
        for line in path.read_text().splitlines():
            parts = line.replace(":", " ").split()
            if len(parts) >= 2 and parts[1].isdigit():
                out[parts[0]] = int(parts[1]) * (1024 if parts[2:3] == ["kB"] else 1)
    except OSError:
        pass
    return out


def read_int(path: Path) -> int | None:
    try:
        value = path.read_text().strip()
    except OSError:
        return None
    return int(value) if value.isdigit() else None


def fs_type(path: str) -> str:
    """The filesystem type of the mount that holds path (/proc/self/mountinfo, longest mount point wins)."""
    best, kind = "", "unknown"
    if not os.path.isdir(path):
        return "not on this machine"  # a service container's data directory
    try:
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            left, _, right = line.partition(" - ")
            point = left.split()[4].replace("\\040", " ")
            if (path == point or path.startswith(point.rstrip("/") + "/")) and len(point) > len(best):
                best, kind = point, right.split()[0]
    except (OSError, IndexError):
        pass
    return kind


def settings(admin_url: str) -> dict[str, str]:
    with psycopg.connect(admin_url, autocommit=True) as conn:
        shown = {name: conn.execute(sql.SQL("show {}").format(sql.Identifier(name))).fetchone()[0] for name in SHOWN}
        shown["data_directory_fs"] = fs_type(conn.execute("show data_directory").fetchone()[0])
    return shown


def gib(value: float) -> str:
    return f"{value / 2**30:.1f} GiB"


def mib(value: float) -> str:
    return f"{value / 2**20:.0f} MiB"


class Sampler(threading.Thread):
    """Memory, swap and pressure while the shards run; in RAM mode also the cluster's size against its cap."""

    def __init__(self, ram: RamCluster | None):
        super().__init__(daemon=True)
        self.ram, self.done = ram, threading.Event()
        self.cgroup = own_cgroup()
        self.min_available: int | None = None
        self.max_swap = 0
        self.max_cgroup = 0
        self.max_shmem = 0
        self.max_psi: dict[str, float] = {}
        self.samples = 0

    def sample(self) -> None:
        mem = keyed(Path("/proc/meminfo"))
        if "MemAvailable" in mem:
            self.min_available = min(self.min_available or mem["MemAvailable"], mem["MemAvailable"])
        self.max_swap = max(self.max_swap, mem.get("SwapTotal", 0) - mem.get("SwapFree", 0))
        for resource in ("cpu", "memory", "io"):
            for kind, values in pressure(Path("/proc/pressure") / resource).items():
                key = f"{resource}_{kind}_avg10"
                self.max_psi[key] = max(self.max_psi.get(key, 0.0), values.get("avg10", 0.0))
        if self.cgroup:
            self.max_cgroup = max(self.max_cgroup, read_int(self.cgroup / "memory.current") or 0)
            self.max_shmem = max(self.max_shmem, keyed(self.cgroup / "memory.stat").get("shmem", 0))
        if self.ram:
            self.ram.measure()
        self.samples += 1

    def run(self) -> None:
        self.sample()
        while not self.done.wait(SAMPLE_S):
            self.sample()

    def stop(self) -> dict:
        self.done.set()
        self.join(SAMPLE_S + 30)
        self.sample()
        return {"samples": self.samples, "min_mem_available_bytes": self.min_available,
                "max_swap_used_bytes": self.max_swap, "max_cgroup_memory_bytes": self.max_cgroup,
                "max_cgroup_shmem_bytes": self.max_shmem, "max_psi_avg10": self.max_psi}


class CpuWindow:
    """CPU time and CPU pressure of this cgroup and the host between start() and stop()."""

    def __init__(self):
        self.cgroup = own_cgroup()
        self.start = self.read()

    def read(self) -> dict[str, float]:
        out = {"wall": time.monotonic()}
        host = pressure(Path("/proc/pressure/cpu")).get("some", {})
        if "total" in host:
            out["host_some_us"] = host["total"]
        if self.cgroup:
            usage = keyed(self.cgroup / "cpu.stat").get("usage_usec")
            if usage is not None:
                out["cgroup_usage_us"] = usage
            for kind, values in pressure(self.cgroup / "cpu.pressure").items():
                if "total" in values:
                    out[f"cgroup_{kind}_us"] = values["total"]
        return out

    def stop(self) -> dict:
        end = self.read()
        wall = end["wall"] - self.start["wall"]
        out = {"wall_seconds": round(wall, 1), "cgroup": str(self.cgroup) if self.cgroup else None,
               "allowed_cpus": sorted(os.sched_getaffinity(0))}
        for key in ("host_some_us", "cgroup_usage_us", "cgroup_some_us", "cgroup_full_us"):
            if key in end and key in self.start and wall > 0:
                share = (end[key] - self.start[key]) / 1e6 / wall
                out[key.removesuffix("_us") + ("_cores" if key == "cgroup_usage_us" else "_share")] = round(share, 3)
        return out


def phase_table(files: list[Path]) -> list[dict]:
    """Every test's setup, call and teardown seconds from the shards' phase files, slowest total first."""
    tests: dict[tuple[str, str], dict] = {}
    for path in files:
        shard = path.stem.removeprefix("phases")
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            try:  # a line cut short by a write error in the plugin is skipped
                row = json.loads(line)
                nodeid, when, seconds, outcome = row["nodeid"], row["when"], float(row["seconds"]), row["outcome"]
            except (ValueError, KeyError, TypeError):
                continue
            entry = tests.setdefault((shard, nodeid), {"nodeid": nodeid, "shard": int(shard), "setup": 0.0,
                                                       "call": 0.0, "teardown": 0.0, "outcome": "passed"})
            entry[when] = round(entry.get(when, 0.0) + seconds, 3)
            if outcome != "passed" and not (outcome == "skipped" and entry["outcome"] == "failed"):
                entry["outcome"] = outcome
    for entry in tests.values():
        entry["total"] = round(entry["setup"] + entry["call"] + entry["teardown"], 3)
    return sorted(tests.values(), key=lambda e: (-e["total"], e["nodeid"]))


def report_dir() -> Path | None:
    """This run's evidence directory (6), or None when it cannot be made: the suite then runs without evidence."""
    try:
        explicit = os.environ.get("PULSE_CI_DB_REPORT_DIR")
        if explicit:
            path = Path(explicit)
            path.mkdir(parents=True, exist_ok=True)
            return path
        sha = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short=12", "HEAD"], capture_output=True,
                             text=True).stdout.strip() or "nogit"
        REPORT_ROOT.mkdir(parents=True, exist_ok=True)
        old = sorted(p for p in REPORT_ROOT.iterdir()
                     if p.is_dir() and re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-z]+-\d+", p.name))
        for stale in old[:max(0, len(old) - (KEEP_REPORTS - 1))]:
            shutil.rmtree(stale, ignore_errors=True)
        path = REPORT_ROOT / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{sha}-{os.getpid()}"
        path.mkdir()
        return path
    except OSError as exc:
        print(f"evidence: no report directory ({exc}); the suite runs without it", flush=True)
        return None


# --- RAM cluster (EST-1575) ---------------------------------------------------------------------------------------

class Refused(Exception):
    """The RAM cluster is not used; the message says why."""


def postmaster_of(data: Path) -> int | None:
    """The live postmaster of a data directory, if it is ours: the pid file's first two lines name the process and
    the directory, and that process is this user's postgres executable started with `-D <data>`."""
    try:
        lines = (data / "postmaster.pid").read_text().split("\n")
        pid = int(lines[0])
        argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        exe = os.readlink(f"/proc/{pid}/exe").removesuffix(" (deleted)")
        owner = os.stat(f"/proc/{pid}").st_uid
    except (OSError, ValueError):
        return None
    target = str(data).encode()
    started_on = any(argv[i] == b"-D" and argv[i + 1] == target for i in range(len(argv) - 1))
    if owner != os.getuid() or lines[1:2] != [str(data)] or Path(exe).name != "postgres" or not started_on:
        return None
    return pid


def kill_postmaster(data: Path) -> None:
    """SIGQUIT (immediate shutdown: the data is thrown away), then SIGKILL if it is still up after 10 s. Before each
    signal the process is checked again, through a pidfd, to be data's postmaster, so a reused pid is never hit."""
    for sig, wait_s in ((signal.SIGQUIT, 10), (signal.SIGKILL, 5)):
        pid = postmaster_of(data)
        if pid is None:
            return
        try:
            fd = os.pidfd_open(pid)
        except OSError:
            return  # gone since
        try:
            if postmaster_of(data) != pid:
                return
            signal.pidfd_send_signal(fd, sig)
            poller = select.poll()
            poller.register(fd, select.POLLIN)  # readable once the process has exited
            if poller.poll(wait_s * 1000):
                return
        except ProcessLookupError:
            return
        except OSError as exc:
            print(f"RAM cluster: could not signal its postmaster ({exc})", flush=True)
            return
        finally:
            os.close(fd)


def tree_bytes(top: Path) -> int:
    total, stack = 0, [str(top)]
    while stack:
        try:
            with os.scandir(stack.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            total += entry.stat(follow_symlinks=False).st_blocks * 512
                    except OSError:
                        pass
        except OSError:
            pass
    return total


class RamCluster:
    """A private PostgreSQL 17 for this run, its data on tmpfs (5 in the module docstring)."""

    def __init__(self, cap: int):
        self.cap = cap
        self.base = RAM_ROOT / f"pulse-pg-{os.getuid()}"
        self.data = self.base / f"run-{os.getpid()}-{int(time.time())}"
        self.lock = self.data.with_name(self.data.name + ".lock")
        self.url = f"postgresql://postgres@/pulse_ci?host={self.data}&port={RAM_PORT}"
        self.lock_fd: int | None = None
        self.bin: Path | None = None
        self.proc: subprocess.Popen | None = None
        self.peak = 0
        self.over: str | None = None
        self.swept = 0
        self.full: list[str] = []

    def admit(self, need: int) -> None:
        mem = keyed(Path("/proc/meminfo"))
        available = mem.get("MemAvailable", 0)
        if available < self.cap + need:
            raise Refused(f"MemAvailable {gib(available)} is below the cap {mib(self.cap)} plus {gib(need)} for the "
                          "shards")
        vfs = os.statvfs(RAM_ROOT)
        if vfs.f_bavail * vfs.f_frsize < self.cap:
            raise Refused(f"{RAM_ROOT} has {mib(vfs.f_bavail * vfs.f_frsize)} free, below the cap {mib(self.cap)}")
        limit = memory_limit()
        if limit is not None and limit < self.cap + need:
            raise Refused(f"this runner may use {gib(limit)}, below the cap {mib(self.cap)} plus {gib(need)}")

    def own_base(self) -> None:
        try:
            self.base.mkdir(mode=0o700)
        except FileExistsError:
            pass
        st = os.lstat(self.base)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise Refused(f"{self.base} is not a private directory of this user")

    def sweep(self) -> None:
        """Clusters whose owning run died (its lock is free) are stopped and removed. Caller holds the base lock."""
        for lock in sorted(self.base.glob("run-*.lock")):
            try:
                fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
            except OSError:
                continue
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                continue  # its run is alive
            data = lock.with_name(lock.name.removesuffix(".lock"))
            kill_postmaster(data)
            shutil.rmtree(data, ignore_errors=True)
            lock.unlink(missing_ok=True)
            os.close(fd)
            self.swept += 1
        for data in self.base.glob("run-*"):
            if data.is_dir() and not data.is_symlink() and not data.with_name(data.name + ".lock").exists():
                kill_postmaster(data)
                shutil.rmtree(data, ignore_errors=True)
                self.swept += 1

    def start(self, need: int) -> None:
        self.own_base()
        base_fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(base_fd, fcntl.LOCK_EX)  # one sweep, admission and claim at a time
            self.sweep()  # first: a dead run's cluster may hold the memory or /dev/shm space admission needs
            self.admit(need)
            self.lock_fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # Python fds are not inherited: dies with us
            self.data.mkdir(mode=0o700)
        finally:
            os.close(base_fd)
        found = subprocess.run(["bash", str(ROOT / "tools/pg-scratch.sh"), "bindir"], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL, timeout=600)
        lines = found.stdout.strip().splitlines() if found.returncode == 0 else []
        self.bin = Path(lines[-1]) if lines else None
        if self.bin is None or not (self.bin / "postgres").is_file():
            raise Refused("tools/pg-scratch.sh bindir found no PostgreSQL 17 binaries")
        initdb = subprocess.run([str(self.bin / "initdb"), "-D", str(self.data), "-U", "postgres", "--auth-local=trust",
                                 "--auth-host=reject", "-E", "UTF8", "--locale=C.UTF-8", "--no-sync",
                                 "--no-instructions"], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                                timeout=300)
        if initdb.returncode != 0:
            raise Refused("initdb failed: " + ((initdb.stderr or initdb.stdout).strip().splitlines() or ["?"])[-1])
        with open(self.data / "postgresql.conf", "a", encoding="utf-8") as conf:
            conf.write(RAM_CONF + f"unix_socket_directories = '{self.data}'\nport = {RAM_PORT}\n")
        # The postmaster is this process's child (not pg_ctl's), so stop() holds it from the moment it exists, also
        # before it has written postmaster.pid.
        with open(self.data / "server.log", "ab") as log:
            self.proc = subprocess.Popen([str(self.bin / "postgres"), "-D", str(self.data)], stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 120
        while True:
            if self.proc.poll() is not None:
                raise Refused("the RAM cluster did not start: " + self.log_tail(3).replace("\n", " | "))
            try:
                with psycopg.connect(with_db(self.url, "postgres"), autocommit=True, connect_timeout=5) as admin:
                    admin.execute("create database pulse_ci")
                break
            except psycopg.OperationalError:  # not accepting connections yet
                if time.monotonic() > deadline:
                    raise Refused("the RAM cluster did not accept connections within 120 s") from None
                time.sleep(0.2)
        self.measure()

    def measure(self) -> None:
        size = tree_bytes(self.data)
        self.peak = max(self.peak, size)
        if size > self.cap and self.over is None:
            self.over = f"the RAM cluster grew to {mib(size)}, past its cap {mib(self.cap)}; it was stopped"
            print(f"RAM cluster: {self.over}", flush=True)
            kill_postmaster(self.data)

    def log_tail(self, lines: int) -> str:
        try:
            return "\n".join((self.data / "server.log").read_text(errors="replace").splitlines()[-lines:])
        except OSError:
            return ""

    def stop(self, report: Path | None) -> list[str]:
        """Stop and remove the cluster, then release its lock; the lines of its log that name a full disk or quota.
        Each step runs whatever the one before did, and the log is kept only afterwards, so a postmaster that does
        not stop or an evidence error cannot strand the cluster. A second stop only returns those lines."""
        if not self.data.is_dir():
            self.release()
            return self.full
        tail = self.log_tail(400)  # read before the directory goes
        self.full = [line for line in tail.splitlines() if re.search(r"No space left|quota exceeded", line, re.I)]
        try:
            if self.proc is not None and self.proc.poll() is None:
                self.proc.send_signal(signal.SIGQUIT)  # immediate shutdown: the data is thrown away
                try:
                    self.proc.wait(10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(5)
        except (OSError, subprocess.SubprocessError) as exc:
            print(f"RAM cluster: its postmaster did not stop ({type(exc).__name__}); trying once more", flush=True)
        finally:
            try:
                kill_postmaster(self.data)  # validated; normally a no-op by now
            finally:
                shutil.rmtree(self.data, ignore_errors=True)
                self.release()
        if report is not None and tail:
            try:
                (report / "ram-postgres.log").write_text(tail + "\n")
            except OSError as exc:
                print(f"RAM cluster: its log was not kept ({exc})", flush=True)
        return self.full

    def release(self) -> None:
        if self.lock_fd is None:
            return
        fd, self.lock_fd = self.lock_fd, None
        try:
            self.lock.unlink(missing_ok=True)
        except OSError as exc:
            print(f"RAM cluster: lock file not removed ({exc}); the next run sweeps it", flush=True)
        finally:
            os.close(fd)


def main() -> int:
    cell = os.environ.get("PULSE_CI_DB_CELL")
    if cell and (os.environ.get("GITHUB_ACTIONS") != "true" or cell not in {"page", "page1", "page2", *[f"{n:02}" for n in range(1, 11)]}):
        raise ValueError("PULSE_CI_DB_CELL requires a GitHub runner and a cell 01..10 or page")
    admin_url = os.environ["PULSE_CI_DATABASE_URL"]
    shards = max(1, min(2, int(os.environ.get("PULSE_CI_DB_SHARDS") or 2)))  # owner's rule: at most two workers
    limit = memory_limit()
    if shards > 1 and limit is not None and limit < SHARD_MEMORY:
        print(f"one shard: this runner may use {limit / 2**30:.0f} GiB of memory, two need {SHARD_MEMORY / 2**30:.0f}",
              flush=True)
        shards = 1
    extra = shlex.split(os.environ.get("PULSE_CI_PYTEST_ARGS", ""))

    def stopped(*_):  # stopped: still drop the copies and the RAM cluster (finally below), once
        signal.signal(signal.SIGTERM, lambda *_: None)
        sys.exit(143)

    signal.signal(signal.SIGTERM, stopped)
    report = report_dir()
    mode = (os.environ.get("PULSE_PG_TMPFS") or "0").strip().lower()
    storage: dict = {"mode": mode}
    if mode not in ("0", "1", "require"):
        print(f"PULSE_PG_TMPFS={mode!r}: use 0, 1 or require", flush=True)
        return 2
    cluster = ram = None
    try:  # around the start too: a stop during initdb or the postmaster start still removes the cluster
        if mode != "0":
            cluster = RamCluster(int(os.environ.get("PULSE_PG_TMPFS_MB") or RAM_CAP_MIB) * 2**20)
            try:
                cluster.start(shards * SHARD_MEMORY // 2)
                ram = cluster
            except Exception as exc:  # noqa: BLE001 (any failure to start leaves the disk server; require fails)
                storage["refused"] = str(exc) if isinstance(exc, Refused) else f"{type(exc).__name__}: {exc}"
                cluster.stop(report)
                print(f"RAM cluster refused: {storage['refused']}"
                      + ("" if mode == "1" else " (PULSE_PG_TMPFS=require: failing)") + "; "
                      + ("using the disk scratch server" if mode == "1" else "the suite did not run"), flush=True)
                if mode == "require":
                    keep_evidence(report, None, {"storage": storage, "rc": 1})
                    return 1
        return run_suite(ram.url if ram else admin_url, shards, extra, report, ram, storage, cell)
    finally:
        if cluster is not None:
            cluster.stop(report)  # after a stop that ran, only returns its log lines


def keep_evidence(report: Path | None, tmp: Path | None, summary: dict) -> None:
    """summary.json and the shards' JUnit and phase files into the report directory. A failure is reported and the
    rest still kept; it never changes the run's result (the suite's exit code and a RAM cap failure stand)."""
    if report is None:
        return
    lost = []
    try:
        (report / "summary.json").write_text(json.dumps(summary, indent=1, default=str) + "\n")
    except (OSError, ValueError) as exc:
        lost.append(f"summary.json ({exc})")
    for path in [*tmp.glob("shard*.xml"), *tmp.glob("phases*.jsonl")] if tmp else []:
        try:
            shutil.copy2(path, report / path.name)
        except OSError as exc:
            lost.append(f"{path.name} ({exc})")
    if lost:
        print(f"  evidence: not kept: {'; '.join(lost)}; the result stands", flush=True)
    else:
        print(f"  evidence: {report} " + ("(JUnit, phase times, summary.json)" if tmp else "(summary.json)"), flush=True)


def run_suite(admin_url: str, shards: int, extra: list[str], report: Path | None, ram: RamCluster | None,
              storage: dict, cell: str | None) -> int:
    storage.update(kind="tmpfs" if ram else "disk", settings=settings(admin_url))
    if ram:
        storage.update(cap_bytes=ram.cap, swept_dead_clusters=ram.swept)
    shown = " ".join(f"{k}={v}" for k, v in storage["settings"].items())
    where = f"private RAM cluster, cap {mib(ram.cap)}" if ram else "disk scratch server"
    print(f"scratch PostgreSQL: {where}: {shown}", flush=True)
    sampler = Sampler(ram)
    sampler.start()
    cpu = CpuWindow()
    started = time.monotonic()
    template, built = ensure_template(admin_url)
    print(f"template {template}: " + (f"built in {built:.0f} s" if built is not None else "reused"), flush=True)

    files = sorted(p.name for p in TESTS.glob("test_*.py"))
    if cell:
        groups, alone = hosted_plan(files, cell)
    else:
        groups, alone = plan(files, shards)
    phases = groups + ([alone] if alone[1] else [])
    stamp, pid = int(time.time()), os.getpid()
    databases: list[str] = []
    results = [{"rc": None, "seconds": 0.0} for _ in phases]
    retry = {"rc": None, "seconds": 0.0}
    rescued: list[tuple[str, str]] = []
    tmp = Path(tempfile.mkdtemp(prefix="ci-db-shards."))
    later = tmp / "retry-later.txt"
    threads = []
    try:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            for number in range(1, len(phases) + 2):  # the phases, and one for a retry alone
                name = f"pulse_ci_run_{stamp}_{pid}_s{number}"
                admin.execute(sql.SQL("create database {} template {} owner pulse_owner")
                              .format(ident(name), ident(template)))
                databases.append(name)
        for number, ((load, members), name) in enumerate(zip(groups, databases), 1):
            print(f"[db {number}] {len(members)} files, about {load / 60:.0f} min measured: {' '.join(members)}",
                  flush=True)
            thread = threading.Thread(target=run_shard, daemon=True,
                                      args=(number, [f"tests/core/{f}" for f in members], with_db(admin_url, name),
                                            tmp, extra, results[number - 1], {"PULSE_CI_RETRY_LATER": str(later)}))
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join()
        if alone[1]:
            number = len(phases)
            print(f"[db {number}] {len(alone[1])} files alone, about {alone[0] / 60:.0f} min measured: {' '.join(alone[1])}",
                  flush=True)
            run_shard(number, [f"tests/core/{f}" for f in alone[1]], with_db(admin_url, databases[len(phases) - 1]),
                      tmp, extra, results[len(phases) - 1])
        first = dict(line.split("\t", 1) for line in later.read_text().splitlines() if "\t" in line) \
            if later.exists() else {}
        if first:
            number = len(phases) + 1
            print(f"[db {number}] {len(first)} browser test(s) that failed beside the other shard, once more alone",
                  flush=True)
            run_shard(number, sorted(first), with_db(admin_url, databases[-1]), tmp, extra, retry,
                      {"PULSE_CI_BROWSER_RETRY": "0"})
            if retry["rc"] == 0:
                for index, result in enumerate(results[:len(groups)]):
                    failed = failed_tests(tmp / f"shard{index + 1}.xml")
                    if result["rc"] not in (0, 5) and failed and failed <= set(first):
                        result["rc"] = 0
                rescued = [(nodeid, first[nodeid] + " (passed alone)") for nodeid in sorted(first)]
                flaky = os.environ.get("PULSE_CI_FLAKY_FILE")
                if flaky:
                    with open(flaky, "a", encoding="utf-8") as out:
                        out.writelines(f"{nodeid}\t{why}\n" for nodeid, why in rescued)
    finally:
        for result in [*results, retry]:
            proc = result.get("proc")
            if proc and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(30)
                except subprocess.TimeoutExpired:
                    proc.kill()
        if databases:
            try:
                with psycopg.connect(admin_url, autocommit=True) as admin:
                    for name in databases:
                        admin.execute(sql.SQL("drop database if exists {} with (force)").format(ident(name)))
            except psycopg.OperationalError:
                if not (ram and ram.over):  # a RAM cluster stopped at its cap takes its copies with it
                    raise

    window, memory = cpu.stop(), sampler.stop()
    if ram:
        storage.update(peak_bytes=ram.peak, over_cap=ram.over, full=ram.stop(report))
    measured: dict[str, float] = {}
    for number in range(1, len(phases) + 1):  # not the retry: its seconds are not a file's
        measured.update(file_seconds(tmp / f"shard{number}.xml"))
    tests = phase_table(sorted(tmp.glob("phases*.jsonl")))
    if os.environ.get("PULSE_CI_DURATIONS_OUT"):
        try:
            Path(os.environ["PULSE_CI_DURATIONS_OUT"]).write_text(
                json.dumps({k: round(v, 1) for k, v in sorted(measured.items())}, indent=1) + "\n")
        except OSError as exc:
            print(f"PULSE_CI_DURATIONS_OUT not written ({exc}); the result stands", flush=True)
    print(f"\ndb shards ({time.monotonic() - started:.0f} s wall, template "
          + (f"built in {built:.0f} s" if built is not None else "reused") + "):")
    for number, ((_, members), result) in enumerate(zip(phases, results), 1):
        state = "pass" if result["rc"] in (0, 5) else f"FAIL (exit {result['rc']})"
        how = "  (alone, after the shards)" if alone[1] and number == len(phases) else ""
        print(f"  [db {number}] {len(members):3d} files {result['seconds']:6.0f} s  {state}{how}")
    if retry["rc"] is not None:
        state = "pass" if retry["rc"] == 0 else f"FAIL (exit {retry['rc']})"
        print(f"  [db {len(phases) + 1}] retried alone {retry['seconds']:6.0f} s  {state}")
    for nodeid, why in rescued:
        print(f"  FLAKY {nodeid}: {why}")
    slow = sorted(measured.items(), key=lambda kv: -kv[1])[:8]
    if slow:
        print("  slowest files: " + ", ".join(f"{name} {secs:.0f} s" for name, secs in slow))
    rc = 0 if all(r["rc"] in (0, 5) for r in results) and retry["rc"] in (None, 0) else 1
    if ram and (ram.over or storage["full"]):
        rc = 1
    if tests:
        print("  ten slowest tests (seconds: total = setup + call + teardown):")
        for t in tests[:10]:
            print(f"    {t['total']:7.1f} = {t['setup']:6.1f} + {t['call']:7.1f} + {t['teardown']:5.1f}  "
                  f"[db {t['shard']}] {t['nodeid']}" + ("" if t["outcome"] == "passed" else f"  ({t['outcome']})"))
    shard_rows = [{"shard": n, "files": len(m), "seconds": round(r["seconds"], 1),
                   "cpu_seconds": round(r["cpu"], 1) if "cpu" in r else None, "rc": r["rc"]}
                  for n, ((_, m), r) in enumerate(zip(phases, results), 1)]
    print("  CPU: allowed " + ",".join(map(str, window["allowed_cpus"])) + "; "
          + ", ".join(f"[db {row['shard']}] {row['cpu_seconds']:.0f} s CPU in {row['seconds']:.0f} s"
                      for row in shard_rows if row["cpu_seconds"] is not None)
          + "".join(f"; {label} {window[key]:.0%}" for key, label in (("cgroup_some_share", "cgroup CPU pressure some"),
                                                                      ("cgroup_full_share", "full"),
                                                                      ("host_some_share", "host CPU pressure some"))
                    if key in window))
    if memory["min_mem_available_bytes"] is not None:
        print(f"  memory: MemAvailable min {gib(memory['min_mem_available_bytes'])}, swap used max "
              f"{gib(memory['max_swap_used_bytes'])}, this cgroup max {gib(memory['max_cgroup_memory_bytes'])} "
              f"(shmem {gib(memory['max_cgroup_shmem_bytes'])}), memory pressure full avg10 max "
              f"{memory['max_psi_avg10'].get('memory_full_avg10', 0):.2f}")
    if ram:
        print(f"  storage: private RAM cluster, peak {mib(ram.peak)} of {mib(ram.cap)}"
              + (f"; {ram.over}" if ram.over else "")
              + "".join(f"\n  RAM cluster log: {line}" for line in storage["full"][:5]))
    else:
        print("  storage: disk scratch server" + (f" (RAM cluster refused: {storage['refused']})"
                                                 if storage.get("refused") else ""))
    keep_evidence(report, tmp, {
        "rc": rc, "wall_seconds": round(time.monotonic() - started, 1), "template_build_seconds": built,
        "storage": storage, "shards": shard_rows, "retry": {"seconds": round(retry["seconds"], 1), "rc": retry["rc"]},
        "cpu": window, "memory": memory, "slowest_files": dict(slow), "slowest_tests": tests[:10],
    })
    return rc


if __name__ == "__main__":
    sys.exit(main())
