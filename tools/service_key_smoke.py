"""Read-only service-key refusals. No real credential, redirects, sessions or response bodies."""
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def service_key_probes(base_url, host=None, access_headers=None):
    opener = build_opener(ProxyHandler({}), NoRedirect())
    checks = []
    for label, path, authorization, expected in [
        ('no key', '/api/v1/service/clients', None, 401),
        ('malformed key', '/api/v1/service/clients', 'Bearer psvc_smoke_invalid', 401),
        ('staff boundary', '/api/v0/me', 'Bearer psvc_smoke_invalid', 403),
    ]:
        headers = {'User-Agent': 'Pulse-Service-Key-Smoke/1.0', **(access_headers or {})}
        if host:
            headers['Host'] = host
        if authorization:
            headers['Authorization'] = authorization
        try:
            with opener.open(Request(base_url.rstrip('/') + path, headers=headers), timeout=10) as response:
                status = response.status
        except HTTPError as error:
            status = error.code
            error.close()
        except (OSError, URLError):
            status = 0
        checks.append({'check': label, 'path': path, 'expected': expected, 'status': status,
                       'passed': status == expected})
    return checks


def access_headers():
    client = os.environ.get('PULSE_SMOKE_CF_ACCESS_CLIENT_ID')
    secret = os.environ.get('PULSE_SMOKE_CF_ACCESS_CLIENT_SECRET')
    return {'CF-Access-Client-Id': client, 'CF-Access-Client-Secret': secret} if client and secret else {}


if __name__ == '__main__':
    checks = service_key_probes(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None, access_headers())
    print(json.dumps(checks, indent=2))
    raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
