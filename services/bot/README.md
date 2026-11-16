# services/bot · Coach bot (Telegram first)

The person-facing messaging channel: account linking, the evening digest with the daily check, one-tap declarations
(shared with client, client responded, approved, blocker), the PGS follow-up question, voice-note intake. From
phase 2 it is the fallback and alerts channel behind the in-app coach. Not the ops bot (`ea-bot`).

- **Lane:** `intel` (Intelligence Engineer).
- **Spec:** 05 §4 (`bot`), 03 S18 (coach bot), 03 S19 (voice notes), 01 §3.2 (messaging), 08 §5 (daily check),
  ADR-0014, ADR-0020.
- **Roadmap:** 07 §3 week 2 (bot skeleton), week 4 (Monday plan prompt and evening digest).

## Definition of done

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus: every message text is
reviewed against the privacy chapter (06 §5, 06 §9); the bot token comes from the environment and is never logged.
