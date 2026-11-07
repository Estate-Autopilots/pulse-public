"""Generated code: fresh (CI also runs `pulse-codegen --check`), valid, and as strict as the validator."""

from __future__ import annotations

import shutil
import subprocess
import uuid
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from pulse_sdk import codegen
from pulse_sdk.generated import events as gen


def test_generated_files_are_fresh():
    for path, text in codegen.generate().items():
        assert path.read_text(encoding="utf-8") == text, f"{path} is stale: run `uv run pulse-codegen`"


def envelope(**over):
    ev = {"specversion": "1.0", "id": "01JA2Q8W6Y3T6M1V8Z0K4C5R7N", "source": f"/agent/{uuid.UUID(int=1)}",
          "type": "agent.render.detected", "time": datetime(2026, 10, 5, tzinfo=UTC).isoformat(),
          "subject": "file:local:EA0584-HK03-v2.mp4", "orgid": str(uuid.UUID(int=2)), "purpose": "delivery",
          "sensitivity": 1, "visibility": "team",
          "data": {"name": "EA0584-HK03-v2.mp4", "size": 10, "md5": "0" * 32, "sha256": "0" * 64}}
    ev.update(over)
    return ev


def test_envelope_and_typed_data():
    e = gen.Envelope.model_validate(envelope())
    assert e.type == "agent.render.detected" and isinstance(e.typed_data(), gen.AgentRenderDetectedData)
    assert set(gen.DATA_MODELS) == set(gen.EventType.__args__)


@pytest.mark.parametrize("bad", [
    {"title": "Bank statement.pdf"},                                    # undeclared envelope attribute
    {"sensitivity": 3},
    {"visibility": "public"},
    {"purpose": "marketing"},
    {"type": "agent.keystrokes.logged"},
])
def test_envelope_rejections(bad):
    with pytest.raises(ValidationError):
        gen.Envelope.model_validate(envelope(**bad))


def test_data_models_forbid_undeclared_fields():
    with pytest.raises(ValidationError):
        gen.Envelope.model_validate(envelope(data={"name": "a", "size": 1, "md5": "x", "sha256": "y",
                                                   "url": "https://x"})).typed_data()
    with pytest.raises(ValidationError):
        gen.AgentUsageHourlyData.model_validate({"hour_start": "2026-10-05T10:00:00Z", "active_s": 10, "idle_s": 0,
                                                  "categories": {"editing": 10, "window_title": 1}})
    with pytest.raises(ValidationError):
        gen.AgentCommandsHourlyData.model_validate({"hour_start": "2026-10-05T10:00:00Z", "app": "notepad",
                                                     "source": "keyboard", "counts": {}})
    ok = gen.LeaveDeclaredData.model_validate({"from": "2026-10-01", "to": "2026-10-02"})
    assert ok.model_dump(by_alias=True, mode="json") == {"from": "2026-10-01", "to": "2026-10-02"}


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_typescript_output_parses(tmp_path):
    ts = next(p for p in codegen.outputs() if p.suffix == ".ts")
    copy = tmp_path / "events.mts"                      # Node strips types from .mts without a package.json
    copy.write_text(ts.read_text(encoding="utf-8"), encoding="utf-8")
    subprocess.run(["node", "--check", str(copy)], check=True, capture_output=True)
