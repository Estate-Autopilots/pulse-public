# The shared screenshot judge (QA-1, 18 Nov 2026)

One script for every lane and for `staff-ux-land.sh`. A **fresh** session looks at **small** pictures and returns a
table; the working session only reads the short summary. Never `Read` a full PNG inside a long working session: every
later turn re-reads it (QA-SYSTEM-RESEARCH §4.6: about 4,900 tokens a picture in a fresh session, hundreds of thousands
when it rides along in a long one).

```bash
# Score a folder of captures (Sonnet by default). Full table -> judge.md; stdout -> rows under 8, LOWEST, tokens and cost.
python3 tools/qa/judge/judge.py shots/ --scope "What these screens are; what not to score"
# Only what changed: before/after folders paired by file name; unchanged pairs cost nothing.
python3 tools/qa/judge/judge.py --before shots-approved/ --after shots/ --question "Is the stage strip easier to read?"
# Plan only (pictures prepared, token estimate, no model call).
python3 tools/qa/judge/judge.py shots/ --dry-run
```

- `--model sonnet` (default; `JUDGE_MODEL` also sets it), `haiku` for a first look at diff crops, `opus` only for a hard
  root cause.
- Pictures are brought to 1x (the CSS width comes from `--width` or the file name: `screen-363-dark.png`,
  `screen-1440-light.png`), long pages are cut into screen-high slices (`--slice-height`, `--max-slices`).
- Capture at 1x to begin with: Playwright `deviceScaleFactor: 1`. Name files `<screen>-<width>-<light|dark>.png`.
- The judge is told not to score overflow, overlap, cut text, contrast or tap sizes. The Readability Gate measures those
  exactly. A judge's finding is a judgement: it becomes a card, it does not block.
- In a land: `JUDGE=<shots dir> staff-ux-land.sh` runs it before taking the land lock and prints the summary (never
  blocks). `JUDGE_ARGS` passes more flags (e.g. `--model haiku`).
- Needs `ffmpeg`/`ffprobe` and the `claude` CLI. Tests: `uv run pytest tools/qa/judge/test_judge.py`.
