import importlib.util
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('sync',Path(__file__).with_name('sync.py'));sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
class AllowlistTests(unittest.TestCase):
 def test_unlisted_path_is_never_copied(self):
  with tempfile.TemporaryDirectory() as d:
   with self.assertRaisesRegex(ValueError,'Non-allowlisted'):
    sync.copy_entry({'source':'services/api/src/server.ts','destination':'apps/desktop/server.ts'},Path(d),sync.entries())
   self.assertEqual(list(Path(d).rglob('*')),[])
 def test_unlisted_file_blocks_scan(self):
  with tempfile.TemporaryDirectory() as d:
   Path(d,'server.ts').write_text('server code')
   with self.assertRaisesRegex(ValueError,'non-allowlisted'):sync.scan(Path(d),[])
 def test_traversal_rejected(self):
  for path in ['../server.ts','/etc/passwd','apps/../db/x','apps//mobile/x']:
   with self.assertRaises(ValueError):sync.safe_path(path)
 def test_secret_and_private_host_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d,'README.md');allowed=[{'destination':'README.md'}]
   for value in ['https://pulse-dev.estateautopilots.com','ghp_'+'a'*40,'colleague@estateautopilots.com']:
    p.write_text(value)
    with self.assertRaises(ValueError):sync.scan(Path(d),allowed)
 def test_manifest_is_explicit_files(self):
  values=sync.entries();self.assertGreater(len(values),50)
  for v in values:
   self.assertNotIn('*',v['source']);self.assertTrue((sync.ROOT/v['source']).is_file())
 def test_public_phone_workflows_have_separate_templates_and_pass_scan(self):
  allowed=sync.entries()
  workflows=['mobile.yml','emulator-matrix.yml','phone-simulations.yml']
  with tempfile.TemporaryDirectory() as d:
   destination=Path(d);entries=[]
   for name in workflows:
    with self.subTest(workflow=name):
     matches=[e for e in allowed if e['destination']=='.github/workflows/'+name]
     self.assertEqual(matches,[{'source':'tools/companion-public/templates/'+name,
      'destination':'.github/workflows/'+name}])
     entry=matches[0];entries.append(entry)
     sync.copy_entry(entry,destination,allowed)
     self.assertEqual((destination/entry['destination']).read_bytes(),(sync.ROOT/entry['source']).read_bytes())
   self.assertEqual(len(sync.scan(destination,entries)),64)
 def test_a_file_the_export_lacks_blocks_scan(self):
  # DESKTOP-1: from 12 Oct the public panel imported ./address.js and ./pairing.js and core declared `pub mod server;`,
  # none of them exported; the panel never loaded and core never compiled on the hosted runners.
  files={'apps/desktop/src/panel.js':"import { place } from './pairing.js';\nimport { mountPanel } from './companion/panel.js';\nconst m = await import('./update-card.js');",
   'apps/desktop/src/update-card.js':'export {};','packages/companion/src/panel.js':'export function mountPanel() {}',
   'apps/desktop/src/index.html':'<link rel="stylesheet" href="panel.css"><script type="module" src="panel.js"></script><script src="https://example.com/x.js"></script>',
   'apps/desktop/core/src/lib.rs':'pub mod server;\npub mod startup;\n#[cfg(test)]\nmod tests {}\nconst ICON: &[u8] = include_bytes!("../icons/tray.png");',
   'apps/desktop/core/src/startup.rs':'mod clock;'}
  self.assertEqual(sync.unresolved(files.__getitem__,set(files)),['apps/desktop/core/src/lib.rs → ../icons/tray.png','apps/desktop/core/src/lib.rs → mod server',
   'apps/desktop/core/src/startup.rs → mod clock','apps/desktop/src/index.html → panel.css','apps/desktop/src/panel.js → ./pairing.js'])
  with tempfile.TemporaryDirectory() as d:
   Path(d,'apps/desktop/src').mkdir(parents=True);Path(d,'apps/desktop/src/panel.js').write_text(files['apps/desktop/src/panel.js'])
   with self.assertRaisesRegex(ValueError,'does not ship what its files load: apps/desktop/src/panel.js → ./pairing.js'):
    sync.scan(Path(d),[{'destination':'apps/desktop/src/panel.js'}])
 def test_allowlist_ships_what_its_files_load(self):
  names={e['destination']:e['source'] for e in sync.entries()}
  self.assertEqual(sync.unresolved(lambda name:(sync.ROOT/names[name]).read_text(),set(names)),[])
if __name__=='__main__':unittest.main()
