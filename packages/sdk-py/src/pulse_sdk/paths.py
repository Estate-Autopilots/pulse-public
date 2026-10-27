"""Where the shared contract files live: packages/schemas in the repository (or PULSE_SCHEMAS_DIR in an image)."""

from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    """The monorepo root: PULSE_REPO_ROOT, else the nearest parent of this file with packages/schemas."""
    env = os.environ.get("PULSE_REPO_ROOT")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        if (parent / "packages" / "schemas" / "registry.yaml").is_file():
            return parent
    raise FileNotFoundError("cannot find the Pulse repository root (set PULSE_REPO_ROOT)")


def schemas_dir() -> Path:
    env = os.environ.get("PULSE_SCHEMAS_DIR")
    return Path(env) if env else repo_root() / "packages" / "schemas"


def migrations_dir() -> Path:
    env = os.environ.get("PULSE_MIGRATIONS_DIR")
    return Path(env) if env else repo_root() / "db" / "migrations"
