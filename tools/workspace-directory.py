"""Read-only Workspace snapshot with the existing indexer account; output consumed by a worker, never logged."""

import json
import os
import sys

import google_auth_httplib2
import httplib2
from google.oauth2 import service_account
from googleapiclient.discovery import build


def main():
    creds = service_account.Credentials.from_service_account_file(
        os.environ.get(
            "PULSE_GOOGLE_KEY", "/etc/estate-autopilots/google/indexer-sa.json"
        ),
        scopes=[
            "https://www.googleapis.com/auth/" + s
            for s in (
                "admin.directory.group.readonly",
                "admin.directory.group.member.readonly",
                "admin.directory.user.readonly",
            )
        ],
        subject=os.environ.get(
            "PULSE_GOOGLE_DIRECTORY_ADMIN", "admin@estateautopilots.com"
        ),
    )
    api = build(
        "admin",
        "directory_v1",
        http=google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=25)),
        cache_discovery=False,
    )

    def pages(resource, key, **kwargs):
        rows, token = [], None
        while True:
            result = resource.list(pageToken=token, maxResults=200, **kwargs).execute(
                num_retries=2
            )
            rows.extend(result.get(key, []))
            token = result.get("nextPageToken")
            if not token:
                return rows

    groups, aliases = [], []
    for group in pages(api.groups(), "groups", customer="my_customer"):
        address = group["email"].lower()
        ga = sorted(set(group.get("aliases", []) + group.get("nonEditableAliases", [])))
        members = [
            {
                "email": m.get("email", ""),
                "role": m.get("role"),
                "type": m.get("type"),
                "status": m.get("status"),
            }
            for m in pages(api.members(), "members", groupKey=address)
        ]
        groups.append(
            {
                "address": address,
                "name": group.get("name") or address,
                "aliases": ga,
                "members": members,
            }
        )
        aliases.extend(
            {
                "address": a.lower(),
                "primary": address,
                "kind": "group",
                "editable": a in group.get("aliases", []),
            }
            for a in ga
        )
    for user in pages(api.users(), "users", customer="my_customer", projection="full"):
        aliases.extend(
            {
                "address": a.lower(),
                "primary": user["primaryEmail"].lower(),
                "kind": "user",
                "editable": a in user.get("aliases", []),
            }
            for a in set(user.get("aliases", []) + user.get("nonEditableAliases", []))
        )
    return {"groups": groups, "aliases": aliases}


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception:  # noqa: BLE001 — no identity, key or API payloads in diagnostics
        print(
            json.dumps(
                {
                    "error": "Directory read unavailable; check delegation of the three read-only Directory scopes."
                }
            )
        )
        sys.exit(1)
