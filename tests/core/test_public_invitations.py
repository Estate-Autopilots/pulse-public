"""Single-use invitation capabilities, expiry, credential revocation and private recipient isolation."""
import hashlib

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant


def test_invitation_token_is_single_use_and_revokes_sessions(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        for pid, username in [(w.manager, 'synthetic.admin'), (w.editor, 'synthetic.editor')]:
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,email,evidence) values(%s,%s,'Editor',%s,'synthetic@example.test','{}')", (w.org, pid, username))
    digest = hashlib.sha256(b'synthetic-private-invitation').hexdigest()
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        batch = api.execute('select pulse.invitation_prepare() id').fetchone()['id']
        rows = api.execute('select pulse.invitation_preview() rows').fetchone()['rows']
        assert len(rows) == 2
        assert not any('token' in key or 'password' in key for row in rows for key in row)
        assert api.execute('select pulse.invitation_start(%s,%s,%s) email', (w.editor, batch, digest)).fetchone()['email'] == 'synthetic@example.test'
        api.execute('select pulse.invitation_finish(%s,true)', (w.editor,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute('select pulse.invitation_preview()')
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute('select * from pulse_priv.staff_invitation')
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at) values(%s,%s,'synthetic-old-session',now()+interval '1 hour')", (w.org, w.editor))
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute('select pulse.invitation_redeem(%s,%s) who', (digest, 'Synthetic-new-password!')).fetchone()['who'] == w.editor
        assert api.execute('select pulse.invitation_redeem(%s,%s) who', (digest, 'Synthetic-another-password!')).fetchone()['who'] is None
        assert api.execute('select * from pulse.login_verify(%s,%s)', ('synthetic.editor', 'Synthetic-new-password!')).fetchone()['must_change'] is False
    with owner.transaction():
        set_tenant(owner, w.org, w.manager)
        assert owner.execute('select revoked_at from pulse.login_session where person_id=%s', (w.editor,)).fetchone()['revoked_at'] is not None
        cred = owner.execute('select password_hash from pulse.login_credential where person_id=%s', (w.editor,)).fetchone()['password_hash']
        assert cred.startswith('$2a$10$')
        owner.execute("update pulse_priv.staff_invitation set status='sent',used_at=null,token_hash=%s,expires_at=now()-interval '1 second' where person_id=%s", (digest, w.editor))
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute('select pulse.invitation_redeem(%s,%s) who', (digest, 'Synthetic-third-password!')).fetchone()['who'] is None
    with owner.transaction():
        set_tenant(owner, w.org, w.manager)
        owner.execute("update pulse_priv.staff_invitation set status='prepared',token_hash=null,expires_at=null where person_id=%s", (w.editor,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute('select pulse.invitation_link(%s,%s,%s)', (w.editor, batch, digest))
    with api.transaction():
        set_tenant(api, w.org)
        assert api.execute('select pulse.invitation_redeem(%s,%s) who', (digest, 'Synthetic-private-setup!')).fetchone()['who'] == w.editor
