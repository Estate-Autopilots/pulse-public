#!/usr/bin/env python3
"""Fail when a uv workspace member is not copied into the Docker build before `uv sync`."""

from __future__ import annotations

import glob
import json
import posixpath
import re
import shlex
import sys
import tomllib
from pathlib import Path, PurePosixPath


def logical_lines(text: str):
    pending = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = f"{pending} {line}".strip() if pending else line
        if line.endswith("\\"):
            pending = line[:-1].rstrip()
            continue
        pending = ""
        yield line
    if pending:
        yield pending


def normalized(path: str) -> str:
    result = posixpath.normpath(path.replace("\\", "/"))
    return "." if result in ("", ".") else result


def copy_sources(line: str) -> tuple[list[str], str] | None:
    payload = line.split(None, 1)[1] if len(line.split(None, 1)) > 1 else ""
    if payload.startswith("["):
        try:
            values = json.loads(payload)
        except json.JSONDecodeError:
            return None
        if not isinstance(values, list) or len(values) < 2:
            return None
        return [str(value) for value in values[:-1]], str(values[-1])

    try:
        values = shlex.split(payload)
    except ValueError:
        return None
    while values and values[0].startswith("--"):
        option = values.pop(0)
        if option == "--from" and values:
            values.pop(0)
        if option.startswith("--from="):
            return None
    if len(values) < 2:
        return None
    return values[:-1], values[-1]


def workspace_members(root: Path) -> set[str]:
    with (root / "pyproject.toml").open("rb") as file:
        workspace = tomllib.load(file).get("tool", {}).get("uv", {}).get("workspace")
    if not isinstance(workspace, dict):
        raise ValueError("root pyproject.toml has no [tool.uv.workspace] table")

    def expand(patterns) -> set[str]:
        paths = set()
        for pattern in patterns:
            for match in glob.glob(str(root / str(pattern))):
                path = Path(match)
                if path.is_dir():
                    paths.add(path.relative_to(root).as_posix())
        return paths

    return expand(workspace.get("members", [])) - expand(workspace.get("exclude", []))


def docker_copies_before_sync(root: Path) -> tuple[list[tuple[list[str], str]], str]:
    dockerfile = root / "Dockerfile"
    stage_copies: list[tuple[list[str], str]] = []
    workdir = "/"
    for line in logical_lines(dockerfile.read_text(encoding="utf-8")):
        instruction, _, rest = line.partition(" ")
        instruction = instruction.upper()
        if instruction == "FROM":
            stage_copies = []
            workdir = "/"
        elif instruction == "WORKDIR":
            workdir = posixpath.normpath(posixpath.join(workdir, rest.strip()))
        elif instruction == "COPY":
            parsed = copy_sources(line)
            if parsed:
                stage_copies.append(parsed)
        elif instruction == "RUN" and re.search(r"\buv\s+sync\b", rest):
            return stage_copies, workdir
    raise ValueError("Dockerfile has no RUN instruction that invokes `uv sync`")


def copied_member(member: str, copies: list[tuple[list[str], str]], workdir: str) -> bool:
    for sources, destination in copies:
        if len(sources) != 1:
            continue
        source = normalized(sources[0])
        if destination.startswith("/"):
            if destination == workdir:
                target = "."
            elif destination.startswith(workdir.rstrip("/") + "/"):
                target = normalized(posixpath.relpath(destination, workdir))
            else:
                continue
        else:
            target = normalized(posixpath.join(workdir, destination))
            if target.startswith(workdir.rstrip("/") + "/"):
                target = normalized(posixpath.relpath(target, workdir))
            elif target == normalized(workdir):
                target = "."
            else:
                continue

        if source == "." and target == ".":
            return True
        if target == source and (member == source or member.startswith(source.rstrip("/") + "/")):
            return True
    return False


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else Path(__file__).resolve().parents[1]
    if len(sys.argv) > 2:
        print("usage: check-docker-uv-members.py [repository-root]", file=sys.stderr)
        return 2

    try:
        members = workspace_members(root)
        copies, workdir = docker_copies_before_sync(root)
    except (OSError, tomllib.TOMLDecodeError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    if not members:
        print("[tool.uv.workspace] resolves to no member directories", file=sys.stderr)
        return 1

    missing = sorted(member for member in members if not copied_member(member, copies, workdir))
    if missing:
        for member in missing:
            print(f"{member}: missing Dockerfile COPY before `uv sync`", file=sys.stderr)
        return 1

    print(f"Dockerfile copies all {len(members)} uv workspace member(s) before `uv sync`")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
