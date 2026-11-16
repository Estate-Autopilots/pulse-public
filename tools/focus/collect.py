#!/usr/bin/env python3
"""FOCUS collector (owner, 7 Nov 2026; Focus OS proposal §4): reads what each AI account on this machine has used and
posts the NUMBERS to Pulse (POST /api/v0/focus-ingest). Never a credential, a prompt or a file's text.

    python3 tools/focus/collect.py            # read and post (dry run without a key: prints counts only)
    python3 tools/focus/collect.py --show     # print what would be sent

Readers (each optional; a missing one is skipped):
  * Claude status-line taps: ~/.focus/claude-<account>.jsonl, written by tools/focus/statusline-tap.py on every reply
    (5-hour and weekly % used and reset times; official fields).
  * Claude usage logs: <config dir>/projects/**/*.jsonl token counts for the last hour (the burn), per config dir in
    FOCUS_CLAUDE_DIRS ("claude-ea=~/.claude,claude-team=~/.claude-team"); a lane log that ends on a usage limit marks the
    account "limited" (FOCUS_LANE_LOGS, default ~/ea-research/flow/logs).
  * Codex session logs: $CODEX_HOME/sessions/**/*.jsonl, the last token_count event's rate_limits (FOCUS_CODEX_ACCOUNT).
  * Balance APIs, only when their key is set (environment or FOCUS_KEYS_FILE, default ~/.config/focus/keys.env):
    OPENROUTER_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY.
  * Lanes: ~/work/lanes/*/.focus/state.json (the continuity files lane.sh writes).
Config: FOCUS_URL (default https://app.vitalsos.ai), FOCUS_KEY_FILE (default ~/.config/focus/ingest.key, mode 600).
"""
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
NOW = datetime.now(timezone.utc)


def iso(t):
    return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def when(x):
    """resets_at as epoch seconds, ISO text or None."""
    if x in (None, ""):
        return None
    try:
        return iso(datetime.fromtimestamp(float(x), timezone.utc))
    except (TypeError, ValueError):
        try:
            return iso(datetime.fromisoformat(str(x).replace("Z", "+00:00")))
        except ValueError:
            return None


def keys_file():
    out = {}
    path = os.path.expanduser(os.environ.get("FOCUS_KEYS_FILE", "~/.config/focus/keys.env"))
    try:
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\s*([A-Z_]+)\s*=\s*(.+?)\s*$", line)
            if m:
                out[m.group(1)] = m.group(2).strip("'\"")
    except OSError:
        pass
    return out


def secret(name, extra):
    return os.environ.get(name) or extra.get(name)


def statusline_taps():
    out = []
    for path in glob.glob(os.path.join(HOME, ".focus", "claude-*.jsonl")):
        account = os.path.basename(path)[:-6]
        try:
            last = open(path, encoding="utf-8").read().strip().splitlines()[-1]
            row = json.loads(last)
        except (OSError, IndexError, ValueError):
            continue
        at = row.get("at") or iso(NOW)
        for win, key in (("5h", "five_hour"), ("7d", "seven_day")):
            w = row.get(key) or {}
            if w.get("used_percentage") is not None:
                out.append({"account": account, "window": win, "usedPct": round(float(w["used_percentage"]), 1),
                            "resetsAt": when(w.get("resets_at")), "at": at, "source": "statusline"})
    return out


def claude_logs():
    out, dirs = [], os.environ.get("FOCUS_CLAUDE_DIRS", "claude-ea=~/.claude")
    since = time.time() - 3600
    for part in filter(None, dirs.split(",")):
        account, _, path = part.partition("=")
        tokens = 0
        for f in glob.glob(os.path.join(os.path.expanduser(path), "projects", "**", "*.jsonl"), recursive=True):
            try:
                if os.path.getmtime(f) < since:
                    continue
                for line in open(f, encoding="utf-8", errors="ignore"):
                    if '"usage"' not in line:
                        continue
                    try:
                        row = json.loads(line)
                        ts = datetime.fromisoformat(str(row.get("timestamp", "")).replace("Z", "+00:00")).timestamp()
                    except ValueError:
                        continue
                    if ts < since:
                        continue
                    u = (row.get("message") or {}).get("usage") or {}
                    tokens += int(u.get("input_tokens") or 0) + int(u.get("output_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
            except OSError:
                continue
        if tokens:
            out.append({"account": account.strip(), "window": "tokens", "amount": tokens, "at": iso(NOW), "source": "claude-logs"})
    return out


LIMIT = re.compile(r"(usage limit|limit reached|hit your limit|rate limit)", re.I)


def lane_limits():
    """A lane log whose last lines say it hit a limit marks its account limited (lane.sh runs on FOCUS_LANE_ACCOUNT)."""
    account = os.environ.get("FOCUS_LANE_ACCOUNT", "claude-ea")
    logs = os.path.expanduser(os.environ.get("FOCUS_LANE_LOGS", "~/ea-research/flow/logs"))
    newest = sorted(glob.glob(os.path.join(logs, "*.log")), key=lambda p: os.path.getmtime(p), reverse=True)[:6]
    for f in newest:
        if os.path.getmtime(f) < time.time() - 1800:
            break
        try:
            with open(f, "rb") as h:
                h.seek(max(0, os.path.getsize(f) - 2000))
                tail = h.read().decode("utf-8", "ignore").splitlines()[-3:]
        except OSError:
            continue
        if any(LIMIT.search(line) for line in tail):
            return [{"account": account, "window": "5h", "usedPct": 100, "status": "limited", "at": iso(NOW), "source": "lane-log"}]
    return []


def window_of(minutes, fallback):
    """'5h' for a window of up to a day, '7d' for a longer one; the fallback when the length is not sent."""
    try:
        m = float(minutes)
    except (TypeError, ValueError):
        return fallback
    return "5h" if m <= 24 * 60 else "7d"


def codex():
    account = os.environ.get("FOCUS_CODEX_ACCOUNT", "codex-ea")
    root = os.path.join(os.environ.get("CODEX_HOME", os.path.join(HOME, ".codex")), "sessions")
    files = sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True), key=os.path.getmtime, reverse=True)[:3]
    for f in files:
        last = None
        try:
            for line in open(f, encoding="utf-8", errors="ignore"):
                if '"rate_limits"' in line:
                    last = line
        except OSError:
            continue
        if not last:
            continue
        try:
            row = json.loads(last)
        except ValueError:
            continue
        payload = row.get("payload") or row
        rl = payload.get("rate_limits") or (payload.get("info") or {}).get("rate_limits") or {}
        at = row.get("timestamp") or iso(NOW)
        out, seen = [], set()
        for key in ("primary", "secondary"):
            w = rl.get(key) or {}
            if w.get("used_percent") is None:
                continue
            # UX-GAMIFY (9 Nov 2026): name the window by its length, not its place. Codex now sends its weekly window
            # (window_minutes 10080) as "primary", which the board showed as the 5-hour one.
            win = window_of(w.get("window_minutes"), "5h" if key == "primary" else "7d")
            if win in seen:
                continue
            seen.add(win)
            resets = w.get("resets_at")
            if resets is None and w.get("resets_in_seconds") is not None:
                try:
                    base = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
                except ValueError:
                    base = NOW
                resets = iso(base + timedelta(seconds=float(w["resets_in_seconds"])))
            out.append({"account": account, "window": win, "usedPct": round(float(w["used_percent"]), 1), "resetsAt": when(resets), "at": at, "source": "codex-logs"})
        if out:
            return out
    return []


def get(url, key, timeout=15):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "User-Agent": "focus-collector"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def balances():
    extra, out = keys_file(), []
    checks = [
        ("openrouter", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1/key",
         lambda d: ((d.get("data") or {}).get("limit_remaining"), "USD")),
        ("deepseek", "DEEPSEEK_API_KEY", "https://api.deepseek.com/user/balance",
         lambda d: next(((float(b.get("total_balance") or 0), b.get("currency") or "USD") for b in d.get("balance_infos") or []), (None, None))),
        ("kimi", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/users/me/balance",
         lambda d: ((d.get("data") or {}).get("available_balance"), "USD")),
    ]
    for account, name, url, read in checks:
        key = secret(name, extra)
        if not key:
            continue
        try:
            amount, currency = read(get(url, key))
        except Exception as error:  # noqa: BLE001  (the key never reaches the message)
            print(json.dumps({"focus": "balance_failed", "account": account, "error": type(error).__name__}), file=sys.stderr)
            continue
        if amount is not None:
            out.append({"account": account, "window": "balance", "amount": round(float(amount), 4), "currency": currency, "at": iso(NOW), "source": "api"})
    return out


def lanes():
    out = []
    for f in glob.glob(os.path.join(HOME, "work", "lanes", "*", ".focus", "state.json")):
        try:
            s = json.load(open(f, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not s.get("lane"):
            continue
        out.append({"key": str(s["lane"])[:60], "title": str(s.get("goal") or s["lane"])[:160], "company": str(s.get("company") or "").lower()[:32],
                    "status": {"in_progress": "running", "blocked": "running", "done": "done"}.get(s.get("status"), "running"),
                    "account": (s.get("account_history") or [{}])[-1].get("acct"), "blockedBy": ", ".join(s.get("blocked_by") or [])[:160] or None})
    return out


def main(argv):
    body = {"samples": statusline_taps() + claude_logs() + lane_limits() + codex() + balances(), "lanes": lanes()}
    if "--show" in argv:
        print(json.dumps(body, indent=1))
        return 0
    key_path = os.path.expanduser(os.environ.get("FOCUS_KEY_FILE", "~/.config/focus/ingest.key"))
    try:
        key = open(key_path, encoding="utf-8").read().strip()
    except OSError:
        print(json.dumps({"focus": "dry_run", "why": "no key file", "samples": len(body["samples"]), "lanes": len(body["lanes"])}))
        return 0
    url = os.environ.get("FOCUS_URL", "https://app.vitalsos.ai").rstrip("/") + "/api/v0/focus-ingest"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "content-type": "application/json", "User-Agent": "focus-collector"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(r.read().decode()[:300])
    except urllib.error.HTTPError as error:
        print(json.dumps({"focus": "post_failed", "status": error.code}), file=sys.stderr)
        return 1
    except OSError as error:
        print(json.dumps({"focus": "post_failed", "error": type(error).__name__}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
