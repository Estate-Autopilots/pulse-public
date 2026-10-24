"""Impact selection protects cross-runtime paths and deleted packages from incomplete PR CI."""
import importlib.util,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('affected',ROOT/'tools/ci-affected.py');affected=importlib.util.module_from_spec(spec);spec.loader.exec_module(affected)
class ImpactTests(unittest.TestCase):
 def test_docs_only_avoids_builds(self):
  self.assertEqual(affected.plan(['docs/ops.md'],ROOT)['groups'],[])
 def test_shared_contracts_and_lockfiles_are_full(self):
  for path in ['db/migrations/0100.sql','packages/schemas/registry.yaml','pnpm-lock.yaml','uv.lock','tools/ci.sh','unknown/new.js','apps/web/AGENTS.md']:
   with self.subTest(path=path):self.assertEqual(affected.plan([path],ROOT)['mode'],'full')
 def test_ui_dependency_closure_retains_integration(self):
  p=affected.plan(['packages/design-system/src/index.ts'],ROOT)
  self.assertIn('...{./packages/design-system}...',p['js_filters'])
  self.assertTrue({'js','e2e','db','smoke'}.issubset(p['groups']))
 def test_deleted_package_falls_back(self):
  with tempfile.TemporaryDirectory() as d:self.assertEqual(affected.plan(['apps/web/src/old.ts'],Path(d))['mode'],'full')
 def test_rust_only_and_mixed_change(self):
  self.assertEqual(affected.plan(['apps/desktop/core/src/lib.rs'],ROOT)['groups'],['rust'])
  self.assertEqual(affected.plan(['apps/desktop/core/src/lib.rs','config/privacy.json'],ROOT)['mode'],'full')
 def test_path_never_becomes_shell_input(self):
  self.assertEqual(affected.plan(['apps/web/$(echo bad)/index.ts','strange\nfile'],ROOT)['mode'],'full')
if __name__=='__main__':unittest.main()
