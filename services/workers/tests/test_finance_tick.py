import io
import json
import zipfile
from datetime import datetime
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from pulse_workers.finance_tick import close_pack, tick


def test_close_pack_keeps_monthly_register_pdf_and_all_open_exceptions():
    records = [
        {"kind": "purchase", "body": {"date": "2026-09-01", "vendor": "Fixture", "fileKey": "sep"}},
        {"kind": "purchase", "body": {"date": "2026-10-01", "vendor": "Fixture", "fileKey": "oct"}},
        {"kind": "exception", "body": {"type": "missing_our_gstin", "key": "sep"}},
    ]
    files = [
        {"key": "sep", "name": "sep.pdf", "bytes": b"%PDF-fixture"},
        {"key": "oct", "name": "oct.pdf", "bytes": b"%PDF-fixture"},
    ]
    content, draft = close_pack(records, files, "2026-09")
    assert draft["invoiceCount"] == 1
    assert draft["status"] == "draft_founder_approval_required"
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert "Evidence/sep.pdf" in archive.namelist() and "Evidence/oct.pdf" not in archive.namelist()
        assert json.loads(archive.read("open-exceptions.json"))[0]["type"] == "missing_our_gstin"
    assert close_pack(records, files, "2026-09")[0] == content


def test_tick_sends_only_internal_founder_notifications_without_mail_provider():
    connection = Mock()
    snapshot = {
        "records": [],
        "founders": ["synthetic-founder"],
        "facts": {
            "deliveries": 3,
            "whoWorked": ["Synthetic Person"],
            "moneyIn": None,
            "moneyOut": None,
            "openApprovals": 2,
            "risks": ["Bank coverage unknown"],
        },
    }
    connection.execute.return_value.fetchone.return_value = {"data": snapshot}
    connection.execute.return_value.fetchall.return_value = []
    tick(connection, "synthetic-org", datetime(2026, 10, 9, 15, 30, tzinfo=ZoneInfo("UTC")))
    notifications = [call.args for call in connection.execute.call_args_list if "finance_desk_notify" in call.args[0]]
    assert len(notifications) == 1
    title = notifications[0][1][2]
    assert "Deliveries: 3" in title and "Money in: unknown" in title and "Who worked:" in title
    assert notifications[0][1][3] == "/finance/desk?view=brief"
    assert all("mail" not in call.args[0] for call in connection.execute.call_args_list)
