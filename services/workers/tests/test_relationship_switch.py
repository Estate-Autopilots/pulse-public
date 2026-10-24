"""RELEASE-5: R46's hourly relationship refresh stays off until the server switches relationships on."""
from pulse_workers.__main__ import relationships_on


def test_relationship_refresh_is_off_until_the_server_switches_it_on():
    assert relationships_on({}) is False
    assert relationships_on({"PULSE_RELATIONSHIPS": "0"}) is False
    assert relationships_on({"PULSE_RELATIONSHIPS": "yes"}) is False
    assert relationships_on({"PULSE_RELATIONSHIPS": "1"}) is True
