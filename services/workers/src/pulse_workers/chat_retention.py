"""Daily tenant-scoped Chats retention; report counts only."""

import json

from pulse_sdk.db import active_orgs, connect, tenant_tx


def main():
    counts = []
    with connect("worker") as c:
        for org in active_orgs(c):
            with tenant_tx(c, org):
                counts.append(c.execute("select pulse.chat_prune() removed").fetchone()["removed"])
    print(json.dumps({"removed": sum(counts)}))


if __name__ == "__main__":
    main()
