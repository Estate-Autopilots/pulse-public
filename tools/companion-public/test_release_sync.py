import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('sync',Path(__file__).with_name('sync.py'));sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
class AcceptedReleaseTests(unittest.TestCase):
 def test_dirty_stale_failed_and_unaccepted_heads_cannot_publish(self):
  sha='a'*40
  for dirty,head,accepted,deployed,healthy,passes in [('',sha,sha,sha,True,True),(' M apps/mobile/App.tsx',sha,sha,sha,True,False),('',sha,'b'*40,sha,True,False),('',sha,sha,'b'*40,True,False),('',sha,sha,sha,False,False),('','b'*40,sha,sha,True,False)]:
   with self.subTest(dirty=dirty,head=head,accepted=accepted,deployed=deployed,healthy=healthy):
    with patch.object(sync.subprocess,'check_output',side_effect=[head,dirty]),patch.object(sync.Path,'read_text',side_effect=[json.dumps({'release_sha':accepted}),json.dumps({'sha':deployed,'healthy':healthy})]):
     if passes:sync.authorize_release(sha)
     else:
      with self.assertRaisesRegex(ValueError,'clean, healthy exact production'):sync.authorize_release(sha)

class DesktopOnlyReleaseTests(unittest.TestCase):
 def test_no_export_advances_the_android_channel(self):
  # MOBILE-SHELL: the phone app releases from mobile.yml and moves its channel only by an explicit promote, so a
  # desktop patch, a newer phone version or equal versions all export as desktop-only.
  with tempfile.TemporaryDirectory() as d:
   dest=Path(d)
   for desktop,mobile in [('1.0.1','1.0.0'),('1.0.1','1.1.0'),('1.0.0','1.0.0')]:
    for platform,version in [('desktop',desktop),('mobile',mobile)]:
     p=dest/'apps'/platform/'package.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps({'version':version}))
    self.assertIn('[desktop-only]',sync.release_message(dest))

if __name__=='__main__':unittest.main()
