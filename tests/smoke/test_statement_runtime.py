"""Statement preview's Python helper must be available in the production image."""
import base64
import fnmatch
import json
import shlex
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HELPER = "tools/statement-parse.py"


class StatementRuntimeTests(unittest.TestCase):
    def test_runtime_includes_helper_and_uses_installed_python(self):
        dockerfile = (ROOT / "Dockerfile").read_text().replace("\\\n", " ")
        runtime = dockerfile.split(" AS runtime\n", 1)[1]
        instructions = [shlex.split(line) for line in runtime.splitlines() if line and not line.startswith("#")]
        env = dict(value.split("=", 1) for parts in instructions if parts[0] == "ENV" for value in parts[1:])
        # The API's local fallback (.venv) does not exist in the runtime image.
        self.assertEqual(env.get("PULSE_WORKER_PYTHON"), f"{env['UV_PROJECT_ENVIRONMENT']}/bin/python")
        self.assertIn(["COPY", HELPER, HELPER], instructions)
        included = True
        for pattern in (ROOT / ".dockerignore").read_text().splitlines():
            if pattern and not pattern.startswith("#") and fnmatch.fnmatchcase(HELPER, pattern.lstrip("!")):
                included = pattern.startswith("!")
        self.assertTrue(included, "The statement helper must be included in Docker's build context")

    def test_helper_previews_a_statement_over_stdin(self):
        payload = {
            "format": "csv",
            "content": base64.b64encode(b"Date,Description,Debit,Credit\n2026-10-01,Synthetic office,25,\n").decode(),
        }
        result = subprocess.run(
            [sys.executable, str(ROOT / HELPER)], input=json.dumps(payload),
            text=True, capture_output=True, timeout=30, check=True,
        )
        preview = json.loads(result.stdout)
        self.assertEqual(len(preview["rows"]), 1)
        self.assertEqual(preview["rows"][0]["amount"], "25")
        self.assertEqual(preview["rows"][0]["direction"], "outflow")


if __name__ == "__main__":
    unittest.main()
