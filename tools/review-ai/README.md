# Review data: the company's own AI check

`score.mjs` runs on the company's own server. It asks Pulse for the next unchecked Review data suggestions with the
key of one of the company's AI co-workers (`GET /api/v0/agent/review-data/queue`), has the server's own Claude
(`claude -p`, the company's sign-in) give each a confidence from 0 to 1 and one plain reason, and sends them back
(`POST /api/v0/agent/review-data/scores`). Scores decide nothing: Review data shows them, and people accept the sure
ones together (with Undo) and decide the doubtful ones one by one.

Suggestions read from WhatsApp groups (contacts from the chats, models and shoots, anything whose source names a chat)
are never handed out (migration 2044), because the model runs at its provider.

## Switch it on for a company (an admin of that company)

1. In Pulse: AI employees → add one named "Data reviewer" (it needs no chats). Its key is issued on the company's own
   server by the operator, as for every AI employee (`pulse.agent_key_issue(<its id>, 'runner')`, 90 days, straight into a
   file only the scorer's account reads, e.g. `~/.config/pulse/review-ai.key`, mode 600); it is never shown in Pulse.
2. Try it: `PULSE_URL=https://pulse.<domain> PULSE_AGENT_KEY_FILE=~/.config/pulse/review-ai.key node tools/review-ai/score.mjs --dry-run`
   (prints the scores for 25 suggestions, sends nothing).
3. Run it every hour, 4 batches of 25 at a time, for example with a user timer:
   `systemd-run --user --on-calendar=hourly --unit review-ai -E PULSE_URL=… -E PULSE_AGENT_KEY_FILE=… node /path/to/tools/review-ai/score.mjs --batches 4`

`REVIEW_AI_CLAUDE` names another command than `claude` (it must read the prompt on stdin and print the answer).
