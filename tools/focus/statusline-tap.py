#!/usr/bin/env python3
"""FOCUS status-line tap: Claude Code runs a status-line command after each reply with the session as JSON on stdin
(rate_limits.five_hour / .seven_day: used_percentage, resets_at; Claude Code 2.1.80+). This keeps the last 300 readings
in ~/.focus/claude-<account>.jsonl for tools/focus/collect.py and prints a short line ("5h 34% · week 12%").

Set it in the account's settings.json (its own CLAUDE_CONFIG_DIR):
    "statusLine": {"type": "command", "command": "python3 /path/to/tools/focus/statusline-tap.py"}
The account is FOCUS_ACCOUNT, else the config directory's name (".claude-team" -> claude-team; ".claude" -> claude-ea).
Only the two windows' numbers are written; nothing else from the session is kept.
"""
import json
import os
import sys
from datetime import datetime, timezone


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    rl = data.get("rate_limits") or {}
    account = os.environ.get("FOCUS_ACCOUNT")
    if not account:
        base = os.path.basename(os.path.normpath(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"))).lstrip(".")
        account = "claude-ea" if base == "claude" else base
    row = {"at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "account": account}
    for key in ("five_hour", "seven_day"):
        w = rl.get(key) or {}
        if w.get("used_percentage") is not None:
            row[key] = {"used_percentage": w.get("used_percentage"), "resets_at": w.get("resets_at")}
    parts = []
    if "five_hour" in row:
        parts.append(f"5h {round(float(row['five_hour']['used_percentage']))}%")
    if "seven_day" in row:
        parts.append(f"week {round(float(row['seven_day']['used_percentage']))}%")
    if parts:
        folder = os.path.expanduser("~/.focus")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"claude-{account.removeprefix('claude-')}.jsonl")
        try:
            lines = open(path, encoding="utf-8").read().splitlines()[-299:]
        except OSError:
            lines = []
        lines.append(json.dumps(row))
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, path)
    print(" · ".join(parts) or (data.get("model") or {}).get("display_name") or "")


if __name__ == "__main__":
    main()
