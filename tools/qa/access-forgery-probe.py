#!/usr/bin/env python3
"""Forged Cloudflare Access identity probe (EST-699, part 1 of EST-650). Read-only GETs, no account or session.

  tools/qa/access-forgery-probe.py staging|production [--port N]

Calls the install's loopback port the way tools/release-smoke.py does (4102 staging, 4002 production) with the
synthetic qa-forged@example.invalid on one signed-in API route and one page:
  a  Cf-Access-Authenticated-User-Email only, no assertion
  b  the same plus a malformed Cf-Access-Jwt-Assertion
  c  the same plus a well-formed RS256 assertion signed by a throwaway key that lives in memory only, with the
     audience and issuer from PULSE_CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN when set (synthetic otherwise)
The API must answer 401; the page 401 or a redirect to /login. Prints JSON with probe name and status code only.
Exit codes: 0 every probe denied, 1 any probe got a 2xx or another unexpected answer, 2 usage error.
"""
import argparse
import base64
import json
import os
import secrets
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

EMAIL = 'qa-forged@example.invalid'
API, PAGE = '/api/v0/me', '/people'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def forged_jwt():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # never serialised or written
    now = int(time.time())
    domain = os.environ.get('CF_ACCESS_TEAM_DOMAIN', '').strip() or 'qa-forged.cloudflareaccess.com'
    header = {'alg': 'RS256', 'kid': secrets.token_hex(32), 'typ': 'JWT'}
    claims = {'aud': [os.environ.get('PULSE_CF_ACCESS_AUD', '').strip() or 'qa-forged-audience'], 'email': EMAIL,
              'exp': now + 300, 'iat': now, 'nbf': now, 'iss': 'https://' + domain.removeprefix('https://'),
              'sub': str(uuid.uuid4()), 'type': 'app', 'identity_nonce': secrets.token_urlsafe(16)}
    signing_input = b64url(json.dumps(header).encode()) + '.' + b64url(json.dumps(claims).encode())
    return signing_input + '.' + b64url(key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256()))


def denied(path, status, location):
    if path == API:
        return status == 401
    return status == 401 or (300 <= (status or 0) < 400 and urlsplit(location or '').path == '/login')


def main():
    ap = argparse.ArgumentParser(description='Forged Access identity probe (read-only).')
    ap.add_argument('env', choices=('staging', 'production'))
    ap.add_argument('--port', type=int, help='loopback port (default: 4102 staging, 4002 production)')
    a = ap.parse_args()
    port = a.port or (4002 if a.env == 'production' else 4102)
    host = ('pulse' if a.env == 'production' else 'pulse-staging') + '.estateautopilots.com'
    opener = build_opener(ProxyHandler({}), NoRedirect)
    base = {'Host': host, 'User-Agent': 'Pulse forged Access probe', 'Cf-Connecting-Ip': '198.51.100.' + str(secrets.randbelow(200) + 20),
            'Cf-Access-Authenticated-User-Email': EMAIL}
    variants = [('a-email-only', {}), ('b-malformed-jwt', {'Cf-Access-Jwt-Assertion': 'forged.not-a.jwt'}),
                ('c-forged-jwt', {'Cf-Access-Jwt-Assertion': forged_jwt()})]
    results, failed = [], []
    for name, extra in variants:
        for kind, path in (('api', API), ('page', PAGE)):
            try:
                with opener.open(Request(f'http://127.0.0.1:{port}{path}', headers={**base, **extra}), timeout=30) as r:
                    status, location = r.status, r.headers.get('Location')
            except HTTPError as e:
                status, location = e.code, e.headers.get('Location')
            except (URLError, OSError):
                status, location = None, None
            probe = f'{name} {kind}'
            results.append({'probe': probe, 'status': status})
            if not denied(path, status, location):
                failed.append(probe)
    print(json.dumps(results, indent=2))
    if failed:
        print('access-forgery-probe: not denied: ' + ', '.join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
