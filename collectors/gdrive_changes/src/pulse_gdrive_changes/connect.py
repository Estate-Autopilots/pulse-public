"""EA Connect (R52): this Drive changes reader as one implementation of the connector.v1 contract.

A root is read with the credential of the company it belongs to, never another's:
- a root bound to a connector install (drive_source.install_id) uses that install's credential from its company's own
  folder in the secret store (`<PULSE_CONNECTOR_SECRETS_DIR>/<company>/<ref>.json`), only while the install is
  active and the server sets PULSE_CONNECTORS=1, and only if the file is the credential whose fingerprint the install
  recorded;
- a root without an install is the install company's own (R44's credential directory) and is never read for another
  company.
The database refuses the same (pulse.drive_change_bound), so a mistake here still writes nothing.

`pulse-connect secret` is the operator's step that puts a company's Google key into that company's folder: it records
only the key's fingerprint (claimed for that company; the same service account is refused for any other company) and
prints no secret, address or path contents.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from pulse_sdk import connector
from pulse_sdk.db import tenant_tx, url_for

from .drive import CredentialUnavailable, credential_file


class CredentialUnbound(CredentialUnavailable):
    code = "credential_unbound"            # a root without a connector, outside the install's own company


class ConnectorsOff(CredentialUnavailable):
    code = "connectors_off"


class ConnectorInactive(CredentialUnavailable):
    code = "connector_inactive"            # revoked, or not approved by the company's admin


class CredentialMismatch(CredentialUnavailable):
    code = "credential_mismatch"           # the file is not the credential the install recorded


def credential_for(source: Mapping[str, Any], install_org: uuid.UUID | str | None) -> tuple[Path, str | None]:
    """The credential file and Workspace account a root is read with. Raises a CredentialUnavailable (the root is then
    marked access_lost with this code, and retried hourly) rather than borrowing another company's credential."""
    if source.get("install_id") is None:
        if install_org is None or str(source["org_id"]) != str(install_org):
            raise CredentialUnbound()
        return credential_file(str(source["credential_ref"])), source["subject"]
    if not connector.on():
        raise ConnectorsOff()
    if source.get("install_status") != "active":
        raise ConnectorInactive()
    try:
        path = connector.company_secret(source["org_id"], str(source.get("secret_ref") or ""))
        fingerprint = connector.google_fingerprint_of(path)
    except connector.SecretUnavailable as exc:
        raise CredentialUnavailable() from exc
    if fingerprint != source.get("credential_fingerprint"):
        raise CredentialMismatch()
    return path, source.get("install_subject")


def install_secret(conn: psycopg.Connection, org_id: uuid.UUID | str, install_id: uuid.UUID | str, key_file: Path,
                   *, base: str | None = None) -> dict[str, Any]:
    """Put a company's Google service-account key into its own folder of the secret store for one EA Connect install.
    The fingerprint is claimed for that company first (another company's credential is refused before anything is
    copied); the file is written privately and replaced atomically; the database change commits only after that."""
    folder = base or os.environ.get(connector.SECRETS_DIR_ENV)
    if not folder:
        raise ValueError(f"{connector.SECRETS_DIR_ENV} is not set")
    try:
        fingerprint = connector.google_fingerprint_of(key_file)
    except connector.SecretUnavailable as exc:
        raise ValueError("the file is not a Google service-account key") from exc
    org = uuid.UUID(str(org_id))
    with tenant_tx(conn, org):
        row = conn.execute("""select implementation, secret_ref, status from pulse.connector_install where id = %s""",
                           (str(install_id),)).fetchone()
        if row is None:
            raise LookupError("no such connector in this company")
        conn.execute("select pulse.connector_secret_installed(%s, %s)", (str(install_id), fingerprint))
        company = Path(folder) / str(org)
        company.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(company, 0o700)
        target = company / f"{row['secret_ref']}.json"
        fd, tmp = tempfile.mkstemp(dir=company, prefix=".incoming-", suffix=".json")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(key_file.read_bytes())
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)       # our own half-written copy, never a stored credential
            raise
    return {"install": str(install_id), "secretRef": row["secret_ref"], "installed": True,
            "credentialId": fingerprint[:12]}


def google_client(org_id: str, key_file: Path | None = None, purpose: str = "sign-in") -> dict[str, Any]:
    """Install or inspect a hosted company's OAuth client; never print key material or parse errors.
    purpose "sign-in": google-sign-in.json (Continue with Google); "mail": google-mail.json (MAILBOX, the company's own
    client for connecting its Google Workspace mailbox, scope gmail.send)."""
    if purpose not in ("sign-in", "mail"):
        raise ValueError("purpose must be sign-in or mail")
    ref = "google-sign-in" if purpose == "sign-in" else "google-mail"
    org = str(uuid.UUID(org_id))
    base = os.environ.get(connector.SECRETS_DIR_ENV)
    if not base:
        raise ValueError("PULSE_CONNECTOR_SECRETS_DIR is not set")

    def read(path: Path) -> dict[str, str]:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or set(value) != {"client_id", "client_secret"} or not all(
                isinstance(v, str) and v.strip() for v in value.values()):
            raise ValueError()
        return value

    try:
        if key_file is not None:
            if key_file.is_symlink() or not key_file.is_file() or key_file.stat().st_size > 16_384:
                raise ValueError()
            value = read(key_file)
            company = Path(base) / org
            if Path(base).is_symlink():
                raise ValueError()
            company.mkdir(mode=0o700, parents=True, exist_ok=True)
            if company.is_symlink() or stat.S_IMODE(company.stat().st_mode) != 0o700:
                raise ValueError()
            target = company / f"{ref}.json"
            if target.is_symlink():
                raise ValueError()
            fd, tmp = tempfile.mkstemp(dir=company, prefix=".google-", suffix=".json")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as out:
                    os.fchmod(out.fileno(), 0o600)
                    json.dump(value, out)
                os.replace(tmp, target)
            finally:
                Path(tmp).unlink(missing_ok=True)
        path = connector.company_secret(org, ref)
        if (Path(base).is_symlink() or not path.is_file() or path.stat().st_nlink != 1
                or path.stat().st_size > 16_384 or stat.S_IMODE(path.parent.stat().st_mode) != 0o700
                or stat.S_IMODE(path.stat().st_mode) != 0o600):
            raise ValueError()
        value = read(path)
        return {"installed": True, "credentialId": hashlib.sha256(
            ("google-client:" + value["client_id"]).encode()).hexdigest()[:12]}
    except (OSError, ValueError, UnicodeError, connector.SecretUnavailable) as exc:
        if key_file is not None:
            reason = "Google client refused: use a private company folder and a valid OAuth client file"
            raise ValueError(reason) from exc
        return {"installed": False, "credentialId": None}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pulse-connect", description="EA Connect operator steps (R52)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("secret", help="install a company's Google key into its own folder of the secret store")
    p.add_argument("--org-id", required=True, help="the company the install belongs to")
    p.add_argument("--install", required=True, help="the EA Connect install id (Settings → Connected sources)")
    p.add_argument("--key-file", required=True, type=Path,
                   help="the company's service-account key (read, never printed)")
    g = sub.add_parser("google-client", help="install a hosted company's OAuth client, or show safe status")
    g.add_argument("--org-id", required=True)
    g.add_argument("--file", type=Path, help="private JSON with client_id and client_secret; omit for status")
    g.add_argument("--purpose", choices=["sign-in", "mail"], default="sign-in",
                   help="sign-in (Continue with Google) or mail (the company mailbox, MAILBOX)")
    args = parser.parse_args(argv)
    try:
        if args.command == "google-client":
            print(json.dumps(google_client(args.org_id, args.file, args.purpose), sort_keys=True), flush=True)
            return 0
        with psycopg.connect(url_for("worker"), autocommit=True, row_factory=dict_row,
                             application_name="pulse-connect") as conn:
            done = install_secret(conn, args.org_id, args.install, args.key_file)
            print(json.dumps(done, sort_keys=True), flush=True)
    except (LookupError, ValueError) as exc:
        print(f"refused: {exc}", file=sys.stderr, flush=True)
        return 2
    except psycopg.Error as exc:
        # The database's refusal names the reason (e.g. credential_elsewhere) without any secret.
        reason = (exc.diag.message_primary or type(exc).__name__).split(":")[0]
        print(f"database refused the request ({reason})", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
