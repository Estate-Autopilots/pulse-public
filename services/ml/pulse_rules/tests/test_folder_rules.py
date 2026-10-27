from __future__ import annotations

from pulse_rules.folder_rules import FolderRulesError, check, load


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, docs_by_org):
        self.docs_by_org = docs_by_org
        self.queries = []

    def execute(self, sql, params=()):
        self.queries.append((sql, params))
        return Result(self.docs_by_org.get(params[0], []))


def test_loader_defaults_exclusions_and_adapts_0045_shape():
    conn = Connection({"ea-org": [{
        "doc_key": "ea-editor-rules", "version": 4,
        "body": {
            "index_rules": [{"match": "approved videos?", "kind": "final"}],
            "creative_type_rules": {"folder_path": [{"match": "vovs?", "type": "vov"}]},
            "file_name": {"legacy_type_hints": {"model": "MV"}},
        },
    }]})

    rules = load(conn, "ea-org")

    assert rules.index_rules[0].doc_key == "ea-editor-rules"
    assert rules.creative_types["folder_path"][0]["type"] == "vov"
    assert rules.legacy_type_hints == {"model": "MV"}
    assert rules.exclusions == ("raw", "b-roll", "reference", "examples?", "templates?")


def test_merge_order_is_stable_and_maps_merge_while_arrays_replace():
    conn = Connection({"org": [
        {"doc_key": "a", "version": 2, "body": {
            "schema_version": 1,
            "index_rules": [{"match": "old stage", "kind": "draft"}],
            "creative_types": {"parsed_type_codes": {"MV": "model_video"}},
        }},
        {"doc_key": "b", "version": 1, "body": {
            "schema_version": 1,
            "index_rules": [{"match": "handoff", "kind": "final"}],
            "creative_types": {"parsed_type_codes": {"VV": "vov"}},
        }},
    ]})

    rules = load(conn, "org")

    assert rules.index_rules[0].match == "handoff"
    assert rules.index_rules[0].doc_key == "b"
    assert rules.creative_types["parsed_type_codes"] == {"MV": "model_video", "VV": "vov"}
    assert [doc.doc_key for doc in rules.documents] == ["a", "b"]


def test_default_exclusions_are_applied_after_merging_all_active_documents():
    conn = Connection({"org": [
        {"doc_key": "a-x", "version": 1, "body": {"schema_version": 1, "exclusions": ["archive"]}},
        {"doc_key": "b-y", "version": 1, "body": {
            "schema_version": 1, "index_rules": [{"match": "handoff", "kind": "final"}],
        }},
    ]})

    rules = load(conn, "org")

    assert rules.exclusions == ("archive",)
    assert rules.index_rules[0].match == "handoff"


def test_unknown_properties_and_bad_patterns_are_reported_clearly():
    conn = Connection({"org": [{
        "doc_key": "bad", "version": 1,
        "body": {"schema_version": 1, "unexpected": True,
                 "index_rules": [{"match": "[", "kind": "draft"}]},
    }]})

    summary = check(conn, "org")

    assert not summary["valid"]
    assert any("unexpected" in error for error in summary["errors"])
    assert any("invalid regular expression" in error for error in summary["errors"])
    try:
        load(conn, "org")
    except FolderRulesError as exc:
        assert "bad@1" in str(exc)
    else:
        raise AssertionError("invalid configuration should not load")


def test_project_path_rules_require_a_named_project_capture():
    conn = Connection({"northwind": [{
        "doc_key": "northwind-project-paths", "version": 1,
        "body": {"project_paths": [{"match": r"(?P<client>[^/]+)/(?P<project>[^/]+)",
                                   "captures": {"client": "client", "project": "missing"}}]},
    }]})

    summary = check(conn, "northwind")

    assert not summary["valid"]
    assert any("named project capture" in error for error in summary["errors"])
    assert any("unknown named capture 'missing'" in error for error in summary["errors"])


def test_protected_paths_are_optional_and_validated_as_patterns():
    conn = Connection({
        "plain": [{"doc_key": "a", "version": 1, "body": {"schema_version": 1}}],
        "extra": [{"doc_key": "a", "version": 1, "body": {"protected_paths": ["board\\s+minutes"]}}],
        "bad": [{"doc_key": "a", "version": 1, "body": {"protected_paths": ["["]}}],
    })

    assert load(conn, "plain").protected_paths == ()
    assert load(conn, "extra").protected_paths == ("board\\s+minutes",)
    errors = check(conn, "bad")["errors"]
    assert any("/protected_paths/0: invalid regular expression" in error for error in errors)


def test_no_active_documents_is_invalid_in_summary_and_loader():
    conn = Connection({"northwind": []})

    summary = check(conn, "northwind")

    assert summary["valid"] is False
    assert summary["documents"] == []
    assert summary["counts"]["index_rules"] == 0
    try:
        load(conn, "northwind")
    except FolderRulesError as exc:
        assert "no active folder_rules documents" in str(exc)
    else:
        raise AssertionError("a missing configuration should fail clearly")
