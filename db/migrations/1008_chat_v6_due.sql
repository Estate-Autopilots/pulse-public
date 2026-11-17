-- migrate:up
-- CHAT-V6 (owner, 25 Oct 2026: "reminders and scheduled sends must fire even if the API restarts or is down at the
-- due time"). chat_due() (1005) already delivers whatever is past due, however late, and claims each row inside its
-- own transaction (for update skip locked; a scheduled message goes through chat_send with its fixed client id, so a
-- retry can never post it twice). Until now only the API's 10-second timer called it. The worker (pulse-worker run,
-- its minute tick) now calls it too, so a reminder rings and a scheduled message goes while the API is down, and the
-- API catches up as soon as it starts. Two callers at once cannot both deliver a row: the second skips locked rows.
-- Additive: one grant.

grant execute on function pulse.chat_due() to pulse_worker;

-- migrate:down
revoke execute on function pulse.chat_due() from pulse_worker;
