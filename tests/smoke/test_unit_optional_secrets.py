"""POLISH-2: a unit never fails because an optional provider (Telegram) is not configured on this server.

pulse-dev-notifications.service required /etc/estate-autopilots/secrets/telegram.env; when the file was absent the
dev minute tick (presence, reminders, HR copies) failed every minute from 8 to 10 Oct 2026.
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OPTIONAL = ('secrets/telegram.env',)


class OptionalSecretsTests(unittest.TestCase):
    def test_optional_provider_files_are_loaded_with_a_dash(self):
        units = [p for p in (ROOT / 'tools').rglob('*.service')]
        self.assertTrue(units)
        for unit in units:
            for line in unit.read_text().splitlines():
                if line.startswith('EnvironmentFile=') and any(name in line for name in OPTIONAL):
                    self.assertTrue(line.startswith('EnvironmentFile=-'), f'{unit.relative_to(ROOT)}: {line}')


if __name__ == '__main__':
    unittest.main()
