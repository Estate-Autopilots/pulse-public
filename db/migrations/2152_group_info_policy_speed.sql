-- migrate:up
-- SPEED-2 (owner, 15 Nov 2026: "a thousand times faster"): the chat list (GET /api/v0/chats, the most server time of any
-- route: 1,130 calls a week, p50 274 ms) and the groups hub read every group's hub record (chat_group_info), and its
-- restrictive "sees" policy (1098) called chat_browse_allowed() once per row before the hashed visible-groups check.
-- On production (read-only, Estate Autopilots, 465 groups) that was 85 of chat_list_facts()'s 104 ms for a leader.
-- Two once-per-query shortcuts now come first; the rule is the same:
--   * a leader or admin with chat on: chat_group_visible() is every group of the company for them (1043), so the
--     visible-groups branch was already true for every hub record (a hub record is only ever made for a group, never a
--     direct chat; none exists on production);
--   * a company that keeps groups to their members (chat_group_readers() = 'members', the default): chat_browse_allowed()
--     is false for every row (its first branch), so it is not called.
-- The browse branch still comes before the visible-groups list, so a single-row read (chat_browse, under the message
-- policies) still never builds that list.
drop policy sees on pulse.chat_group_info;
create policy sees on pulse.chat_group_info as restrictive for select
 using ((select pulse.viewer_is('admin', 'leadership') and pulse.chat_active())
        or ((select pulse.chat_group_readers()) <> 'members' and pulse.chat_browse_allowed(channel_id, kind, pod))
        or channel_id in (select pulse.chat_group_visible()));
-- migrate:down
-- Forward-only.
