import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_smoke_paths", ROOT / "tools" / "release_smoke_paths.py")
paths = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(paths)


class ReleaseSmokePathTests(unittest.TestCase):
    def test_browser_runtime_avoids_shared_tmp_and_removes_session_input_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report"
            with patch.dict(os.environ, {"TMPDIR": "/unavailable-shared-tmp"}):
                with self.assertRaisesRegex(RuntimeError, "synthetic browser failure"):
                    with paths.browser_runtime(report, {"sessions": {"person": "synthetic-only"}}) as (source, env):
                        self.assertEqual(source.parent.parent, report.resolve())
                        self.assertEqual(env["TMPDIR"], str(source.parent))
                        self.assertEqual(json.loads(source.read_text())["sessions"]["person"], "synthetic-only")
                        if os.name == "posix":
                            self.assertEqual(source.parent.stat().st_mode & 0o777, 0o700)
                            self.assertEqual(source.stat().st_mode & 0o777, 0o600)
                        raise RuntimeError("synthetic browser failure")
                self.assertFalse(source.exists())
                self.assertFalse(source.parent.exists())
                self.assertEqual(os.environ["TMPDIR"], "/unavailable-shared-tmp")

    def test_staging_accepts_only_the_refusal_for_a_value_sealed_by_another_environment(self):
        mismatch = {"error": "This file can’t be opened: it does not match its encryption key. HR: ask the Pulse administrator."}
        unknown = {"error": "This file was sealed with document key “doc-2026-10”, which this Pulse server’s keyring no longer lists. HR: ask the Pulse administrator to restore that key."}
        missing = {"error": "Pay can’t be saved or shown yet: the document encryption key isn’t installed on this Pulse server. Nothing was saved."}
        self.assertTrue(paths.sealed_elsewhere("staging", 503, mismatch))
        self.assertTrue(paths.sealed_elsewhere("staging", 503, unknown))
        self.assertFalse(paths.sealed_elsewhere("production", 503, mismatch))
        self.assertFalse(paths.sealed_elsewhere("staging", 503, missing))
        self.assertFalse(paths.sealed_elsewhere("staging", 500, mismatch))
        self.assertFalse(paths.sealed_elsewhere("staging", 503, None))
        self.assertFalse(paths.sealed_elsewhere("staging", 503, {"error": 503}))

    def test_sealed_elsewhere_matches_the_api_refusals(self):
        source = (ROOT / "services" / "api" / "src" / "document-keys.ts").read_text()
        for text in paths.SEALED_ELSEWHERE:
            self.assertIn(text, source)

    def test_api_dist_must_exist_inside_the_smoke_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            checkout = base / "smoke-checkout"
            external = base / "other-checkout" / "services" / "api" / "dist"

            with self.subTest("missing build"):
                with self.assertRaisesRegex(SystemExit, "built services/api/dist inside this checkout"):
                    paths.require_api_dist_in_checkout(checkout)

            (checkout / "services" / "api").mkdir(parents=True)
            external.mkdir(parents=True)
            (external / "app.js").write_text("// synthetic build\n")
            (checkout / "services" / "api" / "dist").symlink_to(external, target_is_directory=True)

            with self.subTest("cross-checkout symlink"):
                with self.assertRaisesRegex(SystemExit, "outside this checkout"):
                    paths.require_api_dist_in_checkout(checkout)
