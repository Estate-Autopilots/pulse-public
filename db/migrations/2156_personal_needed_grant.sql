-- migrate:up
-- BUG-SWEEP-2 (EA #29, found by the browser walk on 15 Nov after 2142 went live): opening another company in a tab from
-- a company's own sign-in answered "Access denied for this account" instead of asking "Confirm it's you". The API
-- (accounts.ts openInTab, from ORG-PER-TAB) reads the refusal's sentence with `select pulse.acct_personal_needed()`, but
-- 2125 left that function without EXECUTE for the API role, so the read itself was refused (42501) and the answer lost
-- its personal_sign_in code. The function returns a fixed sentence and reads nothing; the API role may call it.
grant execute on function pulse.acct_personal_needed() to pulse_api;

-- migrate:down
revoke execute on function pulse.acct_personal_needed() from pulse_api;
