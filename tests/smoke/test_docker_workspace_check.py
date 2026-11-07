import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / "tools" / "check-docker-uv-members.py"


class DockerWorkspaceCheckTests(unittest.TestCase):
    def test_fails_when_a_workspace_package_is_not_copied_and_passes_after_it_is(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for member in ("packages/sdk-py", "services/ml/pulse_rules"):
                package = root / member
                package.mkdir(parents=True)
                (package / "pyproject.toml").write_text("[project]\nname='fixture'\nversion='0.1.0'\n")

            (root / "pyproject.toml").write_text(
                '[tool.uv.workspace]\nmembers = ["packages/sdk-py", "services/ml/pulse_rules"]\n'
            )
            dockerfile = root / "Dockerfile"
            dockerfile.write_text(
                "FROM python:3.12-slim\nWORKDIR /app\n"
                "COPY packages/sdk-py packages/sdk-py\nRUN uv sync --locked --all-packages\n"
            )

            missing = subprocess.run(
                [sys.executable, str(CHECKER), str(root)], capture_output=True, text=True, check=False
            )
            self.assertEqual(missing.returncode, 1)
            self.assertIn("services/ml/pulse_rules: missing Dockerfile COPY", missing.stderr)

            dockerfile.write_text(
                dockerfile.read_text(encoding="utf-8").replace(
                    "RUN uv sync", "COPY services/ml/pulse_rules services/ml/pulse_rules\nRUN uv sync"
                )
            )
            present = subprocess.run(
                [sys.executable, str(CHECKER), str(root)], capture_output=True, text=True, check=False
            )
            self.assertEqual(present.returncode, 0, present.stderr)


if __name__ == "__main__":
    unittest.main()
