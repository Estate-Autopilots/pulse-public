"""Path checks shared by the release smoke runner and its unit tests."""
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


def catalogue_credential_probe(method: str, url: str):
    """Exact non-staff realms: no credential, or a guaranteed-invalid public token.

    Agent-key routes are their own credential realm and refuse staff sessions.
    The psvc_ service reads are one too: the web proxy never forwards a staff session (EST-1715).
    The short offer token cannot match the 43-character catalogue token contract.
    Every other route/method keeps the normal anonymous and staff assertions.
    """
    return {
        ("GET", "/api/v0/agent/me"): ("/api/v0/agent/me", 401),
        ("GET", "/api/v1/catalog/items"): ("/api/v1/catalog/items", 401),
        ("GET", "/api/v1/catalog/offers/:token"): ("/api/v1/catalog/offers/release-smoke-invalid-token", 404),
        ("GET", "/api/v1/service/clients"): ("/api/v1/service/clients", 401),
        ("GET", "/api/v1/service/leads"): ("/api/v1/service/leads", 401),
        ("GET", "/api/v1/service/tasks/mine"): ("/api/v1/service/tasks/mine", 401),
        ("GET", "/api/v1/service/people"): ("/api/v1/service/people", 401),
        ("GET", "/api/v1/service/update-requests"): ("/api/v1/service/update-requests", 401),
    }.get((method, url))


@contextmanager
def browser_runtime(report_directory: Path, payload: dict):
    """Keep synthetic session input and browser profiles private and off shared tmp quotas."""
    root = Path(report_directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".browser-runtime-", dir=root) as directory:
        temporary = Path(directory)
        browser_input = temporary / "input.json"
        browser_input.write_text(json.dumps(payload))
        browser_input.chmod(0o600)
        yield browser_input, {**os.environ, "TMPDIR": str(temporary)}


def require_api_dist_in_checkout(checkout: Path) -> Path:
    """Require a built API distribution contained by the smoke checkout."""
    root = Path(checkout).resolve()
    dist = root / "services" / "api" / "dist"
    try:
        resolved = dist.resolve(strict=True)
    except (OSError, RuntimeError):
        raise SystemExit(
            "Release smoke requires a built services/api/dist inside this checkout; build the API here first."
        ) from None

    try:
        resolved.relative_to(root)
    except ValueError:
        raise SystemExit(
            "Release smoke refuses services/api/dist outside this checkout; build the API here instead of sharing dist."
        ) from None

    if not resolved.is_dir() or not (resolved / "app.js").is_file():
        raise SystemExit(
            "Release smoke requires services/api/dist/app.js built inside this checkout; build the API here first."
        )
    return resolved


# One keyring per environment (docs/ops/DOCUMENT-KEYS.md): staging is a nightly copy of production, so a value
# production sealed (pay, ID files, bank details) cannot be opened there, and the API gives its designed 503 refusal
# (services/api/src/document-keys.ts). Only that refusal, and only on staging, passes the role matrix. Production, a
# missing keyring and every other 5xx still fail (16 Oct 2026: the train stopped on hr GET /api/v0/comp/totals HTTP 503).
SEALED_ELSEWHERE = ("does not match its encryption key", "keyring no longer lists")


def sealed_elsewhere(environment: str, status: int, data) -> bool:
    message = data.get("error") if isinstance(data, dict) else None
    return (environment == "staging" and status == 503 and isinstance(message, str)
            and any(text in message for text in SEALED_ELSEWHERE))
