"""New imports use trusted project scope; same-looking names never silently join accounts."""
import uuid

from pulse_gdrive_snapshot.folder_names import norm
from pulse_gdrive_snapshot.records import _Clients


class Source:
    def __init__(self, rows=()):
        self.rows = rows
        self.writes = []
    def execute(self, sql, params=()):
        if sql.startswith('select'):
            return self.rows
        self.writes.append(params)
        return []

def test_new_project_contexts_with_shared_representative_remain_separate():
    source = Source()
    resolver = _Clients(source, uuid.uuid4())
    a = resolver.resolve('drive-project:synthetic-a', 'Contact A')
    b = resolver.resolve('drive-project:synthetic-b', 'Contact A Full')
    c = resolver.resolve('drive-project:synthetic-c', 'Contact A')
    assert len({a,b,c}) == 3
    assert resolver.resolve('drive-project:synthetic-a', 'Contact A revised') == a
    assert len(source.writes) == 3

def test_existing_accepted_project_account_survives_new_source_binding():
    accepted = uuid.uuid4()
    source = Source([{'source_key':'c:contact a','entity_id':accepted}])
    resolver = _Clients(source, uuid.uuid4())
    assert resolver.resolve('drive-project:synthetic-a', 'Contact A', accepted) == accepted
    assert resolver.resolve('drive-project:synthetic-new', 'Contact A') != accepted

def test_normalization_keeps_original_scripts_and_combining_marks():
    assert norm('  अनिल शर्मा ') == 'अनिल शर्मा'
    assert norm('ＡＣＭＥ') == 'acme'
