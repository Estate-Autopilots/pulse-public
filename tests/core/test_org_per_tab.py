"""ORG-PER-TAB: a company per browser tab from one sign-in (synthetic people and companies only).

2141: the browser's session (the parent) opens a child session per company of the same account, minted only for a
member, with the parent's expiry; a company the account is not in gets nothing; a closed company stays closed until it
is opened again; sign-out ends the parent and every child; a child never picks its company on its own; a record link
finds the other company of the same account that has it (and never one the account is not in).
ACCOUNT-META (2125, applied to tabs in 2142): a tab follows the switch's rule (acct_may_cross): a company's own sign-in cannot open the person's
other companies in a tab once the account has a personal sign-in, and a child is personal only when its parent is.
"""
import uuid

from helpers import build_world
from pulse_sdk.db import set_tenant
from test_account_security import command, hashof
from test_auth_unify import PW_A, _live, _sign_in, one_human  # noqa: F401  (fixture)
from test_account_code import owner_do
from test_account_meta import as_session, live as meta_live, own, session, two  # noqa: F401  (fixture)


def _tab(api, parent, child, org, reopen=False):
    with api.transaction():
        return api.execute('select * from pulse.account_tab_session(%s,%s,%s,%s)', (parent, child, str(org), reopen)).fetchone()


def _signed_in(api, a, handle, tag):
    r = _sign_in(api, a, handle + '.a', PW_A, tag)
    assert r['org'] == str(a.org)
    return hashof('acct' + tag)


def test_a_tab_opens_another_company_without_moving_the_sign_in(api, owner, one_human):
    a, b, handle, _ = one_human
    parent = _signed_in(api, a, handle, 't1'); child = hashof('child-b-t1')
    # The parent's own company opens with the parent.
    assert _tab(api, parent, hashof('child-a-t1'), a.org)['state'] == 'parent'
    row = _tab(api, parent, child, b.org)
    assert row['org_id'] == b.org and row['state'] == 'open'
    # Both stay live at once: A for the parent (the other tab), B for the child, each its company's own person.
    assert [x['person_id'] for x in _live(api, a, parent)] == [a.editor]
    assert [x['person_id'] for x in _live(api, b, child)] == [b.editor]
    assert _live(api, a, child) == [] and _live(api, b, parent) == []
    # Asked again, the same child (no second row); the audit names the company it came from.
    assert _tab(api, parent, child, b.org)['state'] == 'open'
    with owner.transaction():
        set_tenant(owner, b.org)
        assert owner.execute("select count(*) n from pulse.login_session where parent_hash=%s", (parent,)).fetchone()['n'] == 1
        s = owner.execute("select expires_at, via from pulse.login_session where token_hash=%s", (child,)).fetchone()
        assert s['via'] == 'account'
        assert owner.execute("select count(*) n from pulse.audit_event where org_id=%s and action='org_tab_open' and resource_id=%s", (b.org, str(a.org))).fetchone()['n'] == 1
        set_tenant(owner, a.org)
        p = owner.execute("select expires_at from pulse.login_session where token_hash=%s", (parent,)).fetchone()
    assert s['expires_at'] == p['expires_at']
    # A child never picks a company on its own; the parent still does (when it is an account session).
    with api.transaction():
        assert api.execute('select * from pulse.session_org(%s)', (child,)).fetchall() == []


def test_a_company_the_account_is_not_in_gets_nothing(api, owner, worker, one_human):
    a, b, handle, _ = one_human
    parent = _signed_in(api, a, handle, 't2')
    stranger = build_world(worker, owner, api)
    assert _tab(api, parent, hashof('child-c-t2'), stranger.org) is None
    assert _tab(api, parent, hashof('child-x-t2'), uuid.uuid4()) is None
    with owner.transaction():
        set_tenant(owner, stranger.org)
        assert owner.execute("select count(*) n from pulse.login_session where parent_hash=%s", (parent,)).fetchone()['n'] == 0
    # Someone else's session is no parent for me, and a dead parent opens nothing.
    assert _tab(api, hashof('not-a-session'), hashof('child-b-t2'), b.org) is None
    command(api, a, 'pulse.account_tab_sign_out_all(%s)', (parent,))
    assert _tab(api, parent, hashof('child-b-t2'), b.org) is None


def test_child_never_takes_another_persons_or_companys_row(api, one_human):
    a, b, handle, _ = one_human
    parent = _signed_in(api, a, handle, 't3')
    other = _signed_in(api, a, handle, 't3o')
    child = hashof('child-b-t3')
    assert _tab(api, parent, child, b.org)['state'] == 'open'
    # Another parent cannot claim this child hash, and the child is no parent itself.
    assert _tab(api, other, child, b.org) is None
    assert _tab(api, child, hashof('grandchild'), a.org) is None


def test_close_one_company_keeps_the_others(api, owner, one_human):
    a, b, handle, _ = one_human
    parent = _signed_in(api, a, handle, 't4'); child = hashof('child-b-t4')
    _tab(api, parent, child, b.org)
    r = command(api, b, 'pulse.account_tab_close(%s,%s,%s)', (parent, str(b.org), child))
    assert r == {'closed': str(b.org), 'signedOut': False}
    assert _live(api, b, child) == [] and [x['person_id'] for x in _live(api, a, parent)] == [a.editor]
    # Closed stays closed for the tab still in it, until the person opens it again.
    assert _tab(api, parent, child, b.org)['state'] == 'closed'
    assert _tab(api, parent, child, b.org, reopen=True)['state'] == 'open'
    assert [x['person_id'] for x in _live(api, b, child)] == [b.editor]


def test_close_the_signed_in_company_hands_the_token_to_another(api, one_human):
    a, b, handle, _ = one_human
    parent = _signed_in(api, a, handle, 't5'); child_b = hashof('child-b-t5'); child_a = hashof('child-a-t5')
    _tab(api, parent, child_b, b.org)
    r = command(api, a, 'pulse.account_tab_close(%s,%s,%s)', (parent, str(a.org), child_a))
    assert r['signedOut'] is False and r['now'] == str(b.org)
    # The browser's token now opens B (the tab in B goes on); A is closed for it.
    assert [x['person_id'] for x in _live(api, b, parent)] == [b.editor] and _live(api, a, parent) == []
    assert _tab(api, parent, child_b, b.org)['state'] == 'parent'
    assert _tab(api, parent, child_a, a.org)['state'] == 'closed'
    # With nothing else open, closing it is a full sign-out.
    assert command(api, b, 'pulse.account_tab_close(%s,%s,%s)', (parent, str(b.org), child_b))['signedOut'] is True
    assert _live(api, b, parent) == []


def test_sign_out_ends_the_parent_and_every_child(api, one_human):
    a, b, handle, _ = one_human
    parent = _signed_in(api, a, handle, 't6'); child = hashof('child-b-t6')
    _tab(api, parent, child, b.org)
    assert command(api, a, 'pulse.account_tab_sign_out_all(%s)', (parent,)) == 2
    assert _live(api, a, parent) == [] and _live(api, b, child) == []
    assert _tab(api, parent, child, b.org) is None


def test_record_link_finds_the_other_company_of_the_account_only(api, owner, worker, one_human):
    a, b, handle, _ = one_human
    stranger = build_world(worker, owner, api)
    docs = {}
    for w, who in ((b, b.editor), (stranger, stranger.editor)):
        d = uuid.uuid4(); docs[w.org] = d
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("insert into pulse.doc(org_id,id,title,created_by,access) values(%s,%s,'Synthetic plan',%s,'company')", (w.org, d, who))
    found = command(api, a, 'pulse.account_record_home(%s,%s)', ('doc', str(docs[b.org])), a.editor)
    assert found['org'] == str(b.org)
    # A company the account is not in: the same null as a record that does not exist.
    assert command(api, a, 'pulse.account_record_home(%s,%s)', ('doc', str(docs[stranger.org])), a.editor) is None
    assert command(api, a, 'pulse.account_record_home(%s,%s)', ('doc', str(uuid.uuid4())), a.editor) is None
    assert command(api, a, 'pulse.account_record_home(%s,%s)', ('secret', str(docs[b.org])), a.editor) is None
    # Someone without an account finds nothing anywhere else.
    assert command(api, a, 'pulse.account_record_home(%s,%s)', ('doc', str(docs[b.org])), a.editor2) is None


def test_a_company_sign_in_cannot_open_the_persons_other_company_in_a_tab(api, owner, two):
    """ACCOUNT-META's rule holds for tabs too, or a tab would be a way around it (the account has its own password and
    a personal e-mail; b's sign-in here is the company's own)."""
    a, b, c, handle, account, personal = two
    company = session(owner, b.org, b.editor, 'tab-company')
    child = hashof('child-c-tab-company')
    assert _tab(api, company, child, c.org)['state'] == 'personal'
    assert _tab(api, company, child, c.org, reopen=True)['state'] == 'personal'
    assert meta_live(owner, c.org, child) == []
    # Its own company still opens (the tab that is in it).
    assert _tab(api, company, hashof('child-b-tab-company'), b.org)['state'] == 'parent'
    # A record of c is not found from the company's sign-in (same null as a record that does not exist).
    d = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, c.org)
        owner.execute("insert into pulse.doc(org_id,id,title,created_by,access) values(%s,%s,'Synthetic plan',%s,'company')", (c.org, d, c.editor))
    assert as_session(api, b.org, b.editor, company, 'pulse.account_record_home(%s,%s)', ('doc', str(d))) is None
    # The person's own sign-in opens c in a tab in one call, and that tab's session is personal too.
    mine = session(owner, b.org, b.editor, 'tab-personal', personal=True)
    child = hashof('child-c-tab-personal')
    assert _tab(api, mine, child, c.org)['state'] == 'open'
    assert meta_live(owner, c.org, child) == [{'person_id': c.editor, 'personal': True}]
    assert as_session(api, b.org, b.editor, mine, 'pulse.account_record_home(%s,%s)', ('doc', str(d)))['org'] == str(c.org)


def test_an_unclaimed_account_opens_its_other_company_in_a_tab(api, owner, two):
    """An account with no personal sign-in yet keeps opening its companies as before (2125: such accounts still switch)."""
    a, b, c, handle, account, personal = two
    owner_do(owner, "update pulse_priv.pulse_account set password_hash=null, email=null, email_verified_at=null where id=%s", (account,))
    assert own(owner, 'pulse.acct_has_personal(%s)', (account,)) is False
    company = session(owner, b.org, b.editor, 'tab-unclaimed')
    child = hashof('child-c-tab-unclaimed')
    assert _tab(api, company, child, c.org)['state'] == 'open'
    assert meta_live(owner, c.org, child) == [{'person_id': c.editor, 'personal': False}]
    # Proved later on the browser's sign-in ("Confirm it's you"): the open company's session follows on its next call.
    owner_do(owner, "update pulse.login_session set personal=true where token_hash=%s", (company,), b.org)
    assert _tab(api, company, child, c.org)['state'] == 'open'
    assert meta_live(owner, c.org, child) == [{'person_id': c.editor, 'personal': True}]
