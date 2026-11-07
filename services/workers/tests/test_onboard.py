import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import pulse_workers.onboard as onboard
from pulse_workers.onboard import _finish_sort, fill_candidates, group_indexed_files, has_matching_project, sort_org

PROTECTED_FILES = [
    {"file_id": "nw-hr-1", "path": "HR/Offer Letters/offer.pdf"},
    {"file_id": "nw-fin-1", "path": "Finance/Payroll 2026/october.xlsx"},
    {"file_id": "nw-legal-1", "path": "Legal/Contracts/msa.pdf"},
    {"file_id": "nw-cred-1", "path": "Credentials/Social Logins/accounts.txt"},
    {"file_id": "protected-personal-1", "path": "Northwind Homes/Cedar Point/Personal/notes.pdf"},
    {"file_id": "protected-three-rivers-1", "path": "Three Rivers/Launch Film/final.mp4"},
    {"file_id": "protected-personality-1", "path": "Northwind Homes/Personality Shoot/cut.mp4"},
]


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class SortConnection:
    def __init__(self, body, files):
        self.body, self.files = body, files

    def execute(self, sql, params=()):
        if "advisory" in sql:
            return Rows([{"locked": True}])
        if "tenant_config" in sql:
            return Rows([{"doc_key": "northwind", "version": 1, "body": self.body}])
        if "index_file" in sql:
            return Rows(self.files)
        return Rows([])  # no projects and no prior review items


class ReceiptConnection:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))


def test_sort_receipt_keeps_only_counts_and_dry_run_does_not_write():
    conn = ReceiptConnection()
    result = {"folders": 5, "matched_existing": 5, "proposals": 0}

    assert _finish_sort(conn, "northwind", False, result) is result
    sql, params = conn.calls[0]
    assert "pulse.onboarding_sort_receipt" in sql
    assert "clock_timestamp()" in sql
    assert params == ("northwind", 5, 5, 0, None)

    _finish_sort(conn, "northwind", True, result)
    assert len(conn.calls) == 1


def test_northwind_fixture_covers_sort_and_fill_rules():
    fixture = json.loads((Path(__file__).parent / "fixtures/onboard_northwind.json").read_text())
    groups = group_indexed_files(fixture["files"], tuple(fixture["project_paths"]), "northwind@1")
    assert len(groups) == 3
    maple = next(group for group in groups if group.folder_path == "Northwind Homes/Maple Rise")
    assert maple.client_name == "Northwind Homes" and len(maple.sample_file_ids) == 5
    assert all(group.folder_path != "Northwind Homes/readme.pdf" for group in groups)
    assert has_matching_project(maple, [{"storage_root": "index-path:Northwind Homes/Maple Rise"}])
    assert has_matching_project(maple, [{"title": "Maple Rise", "client_name": "Northwind Homes"}])
    assert not has_matching_project(maple, [{"storage_root": "index-path:Elsewhere/Maple Rise",
                                            "title": "Maple Rise", "client_name": "Northwind Homes"}])
    assert not has_matching_project(maple, [{"title": "Maple Rise", "client_name": "Lakeview Group"}])

    rules = {key: fixture[key] for key in ("pods", "creative_types", "design_type_rules")}
    maple_files = [row for row in fixture["files"] if row["path"].startswith(maple.folder_path + "/")]
    empty_project = {"client_id": None, "unit_id": None, "deliverable_type": None, "locked": []}
    proposals = fill_candidates(maple, maple_files, empty_project, rules, "northwind@1")
    by_field = {proposal["field"]: proposal for proposal in proposals}
    assert {field: proposal["value"] for field, proposal in by_field.items()} == {
        "client": "Northwind Homes", "pod": "Northwind Pod", "deliverable_type": "model_video",
    }
    assert by_field["client"]["ruleId"] == "northwind@1:project_paths:0"
    assert len(by_field["deliverable_type"]["sampleFileIds"]) == 5

    cedar = next(group for group in groups if group.project_name == "Cedar Point")
    cedar_files = [row for row in fixture["files"] if row["path"].startswith(cedar.folder_path + "/")]
    existing_project = {**empty_project, "client_id": "existing-client", "unit_id": "existing-pod"}
    type_only = fill_candidates(cedar, cedar_files, existing_project, rules, "northwind@1")
    assert next(row["value"] for row in type_only if row["field"] == "deliverable_type") == "brochure"


@pytest.mark.parametrize("company_list", [None, [], ["board"]])
def test_sort_never_proposes_protected_folders_whatever_the_company_list(company_list):
    fixture = json.loads((Path(__file__).parent / "fixtures/onboard_northwind.json").read_text())
    body = {"project_paths": fixture["project_paths"]}
    if company_list is not None:
        body["protected_paths"] = company_list
    files = fixture["files"] + PROTECTED_FILES
    excluded = set()

    groups = group_indexed_files(files, tuple(fixture["project_paths"]), "northwind@1", tuple(company_list or ()),
                                 excluded)
    result = sort_org(SortConnection(body, files), "northwind", dry_run=True)

    assert {group.folder_path for group in groups} == {
        "Northwind Homes/Maple Rise", "Northwind Homes/Cedar Point", "Lakeview Group/Maple Rise",
        "Three Rivers/Launch Film", "Northwind Homes/Personality Shoot",
    }
    assert len(excluded) == 4
    cedar = next(group for group in groups if group.folder_path == "Northwind Homes/Cedar Point")
    assert cedar.sample_file_ids == ["nw-file-003", "nw-file-011"]
    assert (result["folders"], result["proposals"], result["excluded"]) == (5, 5, 4)
    assert not any(isinstance(value, str) and "/" in value for value in result.values())


class FillConnection:
    def __init__(self, files, projects):
        self.files, self.projects = files, projects

    def execute(self, sql, params=()):
        if "advisory" in sql:
            return Rows([{"locked": True}])
        if "pulse.index_file" in sql:
            return Rows(self.files)
        if "pulse.project" in sql:
            return Rows(self.projects)
        return Rows([])


def test_fill_never_uses_protected_files_as_type_evidence(monkeypatch):
    fixture = json.loads((Path(__file__).parent / "fixtures/onboard_northwind.json").read_text())
    rules = SimpleNamespace(
        documents=[SimpleNamespace(doc_key="northwind", version=1)],
        project_paths=tuple(fixture["project_paths"]),
        protected_paths=(),
        body={key: fixture[key] for key in ("pods", "creative_types", "design_type_rules")},
    )
    monkeypatch.setattr(onboard, "load", lambda _conn, _org: rules)
    files = [{"file_id": "protected-1", "name": "launch.mp4", "mime": "video/mp4",
              "path": "Northwind Homes/Maple Rise/HR/Model Videos/launch.mp4", "project_id": None}]
    project = {"id": "project-1", "name": "Maple Rise", "title": "Maple Rise",
               "storage_root": "index-path:Northwind Homes/Maple Rise", "client_id": None,
               "unit_id": None, "deliverable_type": None, "locked": [], "client_name": None}

    result = onboard.fill_org(FillConnection(files, [project]), "northwind", dry_run=True)

    assert result["projects"] == 1
    assert result["deliverableType"] == 0
