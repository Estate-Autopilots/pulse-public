"""The worker's schedule: projections continuously (woken by NOTIFY, polling as a fallback), partition maintenance
and retention once a day at fixed UTC times. State is the last run per job, kept in the worker's state file so a
restart does not repeat or skip a daily job.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class DailyJob:
    name: str
    at: time                     # UTC

    def due(self, now: datetime, last_run: datetime | None) -> bool:
        """Due once per UTC day, at or after ``at``; a job missed while the worker was down runs on start."""
        today_slot = datetime.combine(now.date(), self.at, tzinfo=UTC)
        slot = today_slot if now >= today_slot else today_slot - timedelta(days=1)
        return last_run is None or last_run < slot


DAILY = (
    DailyJob("maintain_partitions", time(0, 20)),   # 05:50 IST
    DailyJob("retention", time(0, 40)),             # 06:10 IST
)


class State:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = json.loads(path.read_text()) if path.is_file() else {}

    def last(self, job: str) -> datetime | None:
        v = self.data.get(job)
        return datetime.fromisoformat(v) if v else None

    def mark(self, job: str, when: datetime) -> None:
        self.data[job] = when.isoformat()
        self._write()

    def onboarding_due(self, org: str, now: datetime) -> bool:
        entry = self.data.get(f"onboard_sort:{org}", {})
        if not isinstance(entry, dict):
            entry = {}
        retry_after = datetime.fromisoformat(entry["retry_after"]) if entry.get("retry_after") else None
        if retry_after and now < retry_after:
            return False
        last_run = datetime.fromisoformat(entry["last_run"]) if entry.get("last_run") else None
        return last_run is None or now - last_run >= timedelta(hours=1)

    def onboarding_succeeded(self, org: str, when: datetime) -> None:
        self.data[f"onboard_sort:{org}"] = {"last_run": when.isoformat(), "failures": 0}
        self._write()

    def onboarding_failed(self, org: str, when: datetime) -> None:
        key = f"onboard_sort:{org}"
        entry = self.data.get(key, {})
        if not isinstance(entry, dict):
            entry = {}
        failures = int(entry.get("failures", 0)) + 1
        delay = min(60 * (2 ** min(failures - 1, 6)), 3600)
        self.data[key] = {
            "last_run": entry.get("last_run"), "failures": failures,
            "retry_after": (when + timedelta(seconds=delay)).isoformat(),
        }
        self._write()

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1))
        tmp.replace(self.path)


def due_jobs(now: datetime, state: State, jobs: tuple[DailyJob, ...] = DAILY) -> list[str]:
    return [j.name for j in jobs if j.due(now, state.last(j.name))]
