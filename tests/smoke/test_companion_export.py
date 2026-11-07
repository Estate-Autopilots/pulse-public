"""DESKTOP-1: the public Companion export's own checks run in Pulse CI, so a client file the export leaves out fails here,
before the train ships it. From 12 Oct every public desktop build failed on four files that were never allowlisted."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_tests(loader, tests, pattern):
    for name in ('test_sync', 'test_release_sync'):
        spec = importlib.util.spec_from_file_location('companion_' + name, ROOT / 'tools/companion-public' / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        tests.addTests(loader.loadTestsFromModule(module))
    return tests
