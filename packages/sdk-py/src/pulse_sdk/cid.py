"""Creative ids (CID, 02 §4.4): <tenant-code><project-reg>-<type-code><nn>[-v<version>][-<variant>].

Matched with a full match against the file's basename without extension, case-sensitive. The TypeScript side uses
the same expression and the same fixture list (packages/schemas/fixtures/cid.json).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

CID_RE = re.compile(
    r"(?P<tenant>[A-Z]{2,4})(?P<project>\d{4,6})-(?P<type>[A-Z]{2})(?P<num>\d{2,3})"
    r"(?:-v(?P<ver>\d{1,2}))?(?:-(?P<variant>[a-z0-9x]{1,8}))?"
)


@dataclass(frozen=True)
class Cid:
    tenant: str
    project: int          # the project's registry_no
    type_code: str
    num: int
    version: int | None
    variant: str | None
    base: str             # the asset part, e.g. EA0584-HK03 (as written in the name)

    def __str__(self) -> str:
        out = self.base
        if self.version is not None:
            out += f"-v{self.version}"
        if self.variant:
            out += f"-{self.variant}"
        return out


def stem(name: str) -> str:
    """Basename without directory and without the last extension."""
    base = os.path.basename(name.replace("\\", "/"))
    root, ext = os.path.splitext(base)
    return root if ext else base


def parse(value: str | None) -> Cid | None:
    """Parse a CID from a file name, a basename or a bare CID; None if it is not a well-formed CID."""
    if not isinstance(value, str) or not value:
        return None
    m = CID_RE.fullmatch(stem(value))
    if not m:
        m = CID_RE.fullmatch(value)
    if not m:
        return None
    base = f"{m['tenant']}{m['project']}-{m['type']}{m['num']}"
    return Cid(
        tenant=m["tenant"],
        project=int(m["project"]),
        type_code=m["type"],
        num=int(m["num"]),
        version=int(m["ver"]) if m["ver"] else None,
        variant=m["variant"],
        base=base,
    )


def parse_prefix(value: str | None) -> Cid | None:
    """Parse a leading CID from an ad or creative label, followed by whitespace, a middle dot, or end of string."""
    if not isinstance(value, str) or not value:
        return None
    match = CID_RE.match(value)
    if not match or (match.end() < len(value) and not (value[match.end()].isspace() or value[match.end()] == "·")):
        return None
    return parse(match.group(0))
