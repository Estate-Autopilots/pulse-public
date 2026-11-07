"""PRESENCE-ONBOARD proposal rules, with synthetic names and made-up numbers only."""
from pulse_gdrive_snapshot import onboard_proposals as P


def test_header_finds_details_and_never_reads_id_or_pay_columns():
    cols = P.header_map(["Sr", "Employee Name", "Date of Birth", "Mobile No", "Aadhaar No", "PAN", "Bank A/c", "Salary",
                         "Emergency Contact", "Emergency Number", "Address"])
    assert cols == {"name": 1, "dob": 2, "personalPhone": 3, "emergencyName": 8, "emergencyPhone": 9, "address": 10}


def test_values_are_cleaned_and_id_like_values_dropped():
    assert P.clean("dob", "14/03/1997") == "1997-03-14"
    assert P.clean("dob", "2024-01-01") is None                      # too young to be on staff
    assert P.clean("personalPhone", "+91 98765-43210") == "+91 98765 43210"
    assert P.clean("personalPhone", "234567890124") is None          # an Aadhaar-like number is not a phone
    assert P.clean("address", "Flat 4, Synthetic Lane, 2345 6789 0124") is None
    assert P.clean("address", "Flat 4, Synthetic Lane, Pune 411045") == "Flat 4, Synthetic Lane, Pune 411045"
    assert P.clean("emergencyName", "ABCPE1234F") is None             # a PAN-like value is never proposed
    assert P.clean("personalEmail", "someone@estateautopilots.com") is None   # work mail is not a personal email
    assert P.clean("personalEmail", "Sam.Home@Example.test") == "sam.home@example.test"


def test_sheet_rows_follow_the_header_wherever_it_starts():
    rows = [["Team details (synthetic)"], ["Name", "DOB", "Personal Email", "Aadhaar"],
            ["Synthetic Sam", "01-02-1995", "sam@example.test", "2345 6789 0124"], ["", "", ""]]
    out = list(P.sheet_rows(rows))
    assert out == [("Synthetic Sam", {"dob": "1995-02-01", "personalEmail": "sam@example.test"})]
    assert "2345" not in repr(out)
    assert list(P.sheet_rows([["Name", "Pod"], ["Synthetic Sam", "Pod 1"]])) == []   # no detail column: not an HR sheet
