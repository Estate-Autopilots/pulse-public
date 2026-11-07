# Pulse tutorial reels

Reels-first tutorials from the real Pulse UI: 9:16 vertical reels (1080x1920, 15–30 s) with a hook in the first
1.5 s, cuts and punch-in zooms on the actual taps, word-by-word captions, an energetic ElevenLabs voice, SFX on the
logged actions and a music bed ducked under the voice, mastered to −14 LUFS at about 10 Mbps. Every run also makes a
16:9 long-form cut and an editor pack (raw takes and stills, voice files, stems, SRT, timecoded script, cue sheet,
FCPXML / Premiere XML and the frame-exact edit plan) so a human editor can rework any reel.

No presenter. All people, companies, messages and amounts on screen are fictional: the **Brightside Studio** rehearsal
company on pulse-dev (`reels-demo.localhost`), with **Luna** as its AI employee and **Skyline Heights** and
**Greenleaf Cafe** as clients.

## How it works

```
storyboards/<id>.json ──► capture.mjs ──► take.mp4 + take.actions.json  (every action: frame number + element box)
         │                                      │
         └── lines (en, hi) ──► reels.py voice ─┤ ElevenLabs v3 + character timings (cached, budgeted)
                                                ▼
                       reelkit/plan.py ──► plan.json   (all decisions in integer frames at 30 fps)
                                                ▼
         reelkit/compose.py (picture) + reelkit/audio.py (voice, SFX, ducked bed, −14 LUFS) ──► final MP4
                                                ▼
                       reelkit/qa.py ──► contact sheet, black/freeze scan, loudness, caption overflow
                                                ▼
                       reels.py pack ──► editor pack (reelkit/timeline.py: FCPXML, Premiere XML, cue sheet, SRT)
```

- **Capture** (`capture.mjs`): headless Chromium at phone size (390x844 at 3x = 1170x2532) drives a storyboard's
  takes. CDP screencast frames are re-timed into a constant 30 fps clip (a 1 px ticker keeps frames coming while the
  UI is still). Each tap, typed field, element that appears and named mark goes into the action log with its frame and
  bounding box. A soft tap ring is drawn on the page. One browser at a time; a watchdog stops a stuck run.
- **Plan** (`reelkit/plan.py`): each beat is a source range between two logged marks. Frames around every action play
  at 1x; idle stretches are sped up (up to 3x) and, past that, jump-cut. The cut lands 3 frames before the beat's first
  action. The camera punches in on each logged element box (spring ease) and pushes in slowly through holds. Captions
  are 1–3 word cards timed from ElevenLabs character timings; SFX land on logged frames: tap on taps, pop on
  appearances and the hook, whoosh on take changes, chime on the payoff. Blank frames between routes are detected per
  take and replaced with the last good frame; storyboard `blur` boxes hide things such as an invite token.
- **Compose** (`reelkit/compose.py`): Pillow + numpy, frame by frame, piped to ffmpeg (libx264 high, 10 Mbps). Hook text
  on brand pills, captions with the spoken word in yellow and key words in lilac, kept off the element being tapped
  and out of the bottom 20 % (platform UI), whip transitions between takes, a punch-in on each cut, a short end card.
  `layout="wide"` places the phone on a 1920x1080 stage with a karaoke line beside it (long-form).
- **Audio** (`reelkit/audio.py`): mixed at 48 kHz in numpy, so every cue starts on its exact frame (1 frame = 1600
  samples). The bed is looped with crossfades and ducked by 11 dB under the voice (envelope follower, 60 ms
  smoothing), then two-pass `loudnorm` to −14 LUFS integrated, −1 dBTP.
- **QA** (`reelkit/qa.py`): ffprobe spec (size, fps, frame count against the plan), a contact sheet of the first frame
  after every cut, `blackdetect` and `freezedetect` (over 1.2 s), an EBU R128 loudness report, and caption overflow
  from the render. Each reel gets `<stem>-qa.json` and `<stem>-contact-sheet.jpg`.

Why not Remotion: Remotion is free only for companies of three people or fewer and costs $25 a seat beyond that
(see `ea-research/flow/inputs/STACK-REPORT.md`). This compositor uses the same frame-based model, renders
deterministically, and its `plan.json` is the editable composition project.

## Run it

Render on **ac**, not on ea (ea is production). Prefix heavy steps with `nice -n 19 ionice -c3`. ffmpeg runs with
`-threads 2`, and `reels.py` waits while the 1-minute load is 3 or more (for at most 5 minutes) and stops when the
work disk has less than 10 GB free. Everything goes under `REELS_WORK` (default `/tmp/pulse-reels`), which holds
`cache/` (ElevenLabs results), `capture/`, `work/` (intermediates) and `out/<date>/`.

```bash
# 0. One-off: the demo company on pulse-dev (see demo/*.mjs headers). Reach pulse-dev from ac through an SSH tunnel to
#    ea's 127.0.0.1:3200 (e.g. local port 13200); the demo company answers at http://reels-demo.localhost:13200.
#    The seeds run on ea against the dev database only; they refuse any company that is not a rehearsal company.
node demo/setup-demo.mjs                   # BASE, OPERATOR, LOGINS, CHROME (wizard as the operator)
node demo/seed-demo.mjs --logins <file>    # on ea, with pulse_dev.env loaded: Luna, the Skyline Heights group, finance
node demo/seed-tasks.mjs <people.json>     # Meera's late tasks and the tasks waiting on hers
node demo/seed-demo.mjs --reset-r1         # before each re-take of reel 1: the "Send it" proposal is pending again

# 1. Lines and budget
python3 reels.py lint
./with-elevenlabs python3 reels.py quota
./with-elevenlabs python3 reels.py sounds              # SFX kit + music bed, once (cached)
./with-elevenlabs python3 reels.py voice [ids] --budget 7000

# 2. Capture (REELS_BASE, REELS_CHROME, REELS_LOGINS; REELS_SHOTS=1 for debug stills)
node capture.mjs storyboards/01-ai-asks-first.json $REELS_WORK/capture/01-ai-asks-first

# 3. Build, long-form, packs
python3 reels.py build [ids] [--langs en,hi]
python3 reels.py longform
python3 reels.py pack
python3 reels.py report --plan-limit <characters on the plan>   # REPORT.md + summary.json
```

`survey.mjs` screenshots routes as one demo person and lists their tappable elements, for writing storyboards.

## Storyboards

`storyboards/<id>.json`:

- `takes[]`: `setup` (sign-in, storage, cookies, first page; not recorded) and `steps` (recorded). Steps: `goto`,
  `login`, `tap`, `type`, `fill` (a `secret` comes from the logins file), `press`, `appear` (wait for an element and log
  it), `scroll`, `wait`, `grab` (keep a value such as the client link as `${var}`), `back`, `storage`, `cookie`, `mark`,
  `eval`, `shot`. Targets: `role`+`name`, `label`, `text`, `sel` (+`hasText`), `placeholder`, `within`; `/regex/`
  strings work. Per step: `mark` (a name beats can cut on), `zoom` (punch-in, 0 = none), `sfx` (`none` to mute).
  `blur`: `[{mark, box?: [x, y, w, h] CSS px, pad}]` blurs from that mark to the end of the take.
- `beats[]`: one shot each: `take`, `from`/`to` marks (+ `from_offset`/`to_offset` in frames), optional `camera`
  (fixed framing), `hook` text per language, `payoff`, and `line.<lang>` with `say` (what the voice reads: Eleven v3
  audio tags such as `[excited]`; Devanagari for Hinglish) and `cap` (what the caption shows, Roman script, the same
  number of words; `*word*` is a key word). `lint` blocks digits and money in lines.
- The first beat is the hook (a flash-forward to the payoff with big text, voice from frame 0).

Voices are in `voices.json` (one ElevenLabs library voice, not a clone; Eleven v3) and the SFX kit and bed prompts in
`sound-kit.json`. Changing a line, voice or prompt re-makes only that item; everything else comes from the cache.

## ElevenLabs key and spend

`with-elevenlabs` prefers EA's Infisical. It uses Atlas Crest' key only when `REELS_ALLOW_AC_KEY=1` and
`REELS_AC_WRAPPER` are set. Every paid call is booked in `out/ledger.json`, metered from the subscription counter
before and after (list price as a floor, because the counter lags for sound effects). A call is refused when it would
pass `--budget` or 5 % of the plan, or when the quota left is lower than expected. A free ElevenLabs plan does not
allow commercial use. Check the plan that pays for any reel that will be published.

## Tests

```bash
python3 -m pytest tools/tutorials/tests -q
```

The tests cover the time map, blank frames, camera, word timing and caption cards, the plan, timelines and cue sheet,
the budget ledger, storyboard lint and mark references, and caption placement. They make no network calls and run
without a browser or ffmpeg.

## Learn Pulse: tutorials (XRAY-LINK, 25 Oct 2026)

The same engine also makes the **Learn** tutorials: the in-app hub at `/learn` (steps with a screenshot each, a video
where one was made, Try it, per-person "done"), the quiet **How do I…** button in the top bar on the pages a tutorial
is about, and a YouTube kit per tutorial. One list drives all of it: `apps/web/app/lib/learn.mjs` (`TUTORIALS`: title,
who it is for, steps with **exact UI labels**, `pages` for How do I…, `tryHref`; `PLAYLISTS` by topic and by role, with
the YouTube playlist titles).

A tutorial's storyboard (`storyboards/<id>.json`, same id) has two parts:

- `screens`: computer-size (1280x800) steps for the Learn pictures; a step with `"shot": "01"` is pictured after it
  runs, with `focus` ringed and `blur` ([{sel}]) blurred. `shots.mjs` runs them and **checks every `**Label**` of the
  matching Learn step is on the screen** (shots.json lists any that are not). `learn.py webp` turns the PNGs into
  `apps/web/public/learn-shots/<id>/<shot>.webp` (about 40-90 kB each; the web test checks they exist and stay small).
- `takes` + `beats`: the phone takes and voice lines, exactly as for the reels, plus `chapter` per beat (en/hi), which
  become the YouTube chapters (merged to at least 10 s each, as YouTube requires).

```bash
# Pictures (on ea, through ea-heavy; the demo company answers on pulse-dev at reels-demo.localhost)
REELS_BASE=http://reels-demo.localhost:3200 REELS_LOGINS=<logins.json> node shots.mjs <dir> [ids]
python3 learn.py webp <dir>

# Videos (on ac, like the reels; captures need pulse-dev, so capture on ea and copy capture/<id>/ over)
./with-elevenlabs python3 reels.py quota                         # stop and ask if the quota is short
./with-elevenlabs python3 reels.py voice <ids> --budget 8000     # cached; a changed line re-makes only itself
python3 learn.py build <ids> [--silent]                          # youtube/<id>-<lang>.mp4 (16:9) + reels/<id>-<lang>.mp4 (9:16)
python3 learn.py meta <ids>                                      # captions en / hi / hi-Latn (SRT+VTT), transcript, cues.csv,
                                                                 # thumbnail, <id>.json manifest, <id>-<lang>.youtube.txt
python3 learn.py playlists                                       # playlists.json (YouTube playlists from PLAYLISTS)
python3 learn.py web <ids> --media <dir>                         # 720p web cuts + VTT + poster, and lib/learn-media.json
python3 learn.py report                                          # LEARN.md
```

Videos never go into git. The Learn page shows a video only where its file is on that server: it reads
`lib/learn-media.json` and serves files from `PULSE_LEARN_MEDIA` (default `apps/web/.learn-media`, git-ignored) at
`/learn/media/<id>/<file>` with byte ranges. Once the videos are on YouTube, put each link in learn-media.json's
`youtube` and the page shows "Watch on YouTube". Nothing is published from here: publishing waits for the owner's
decision (ea-decide card `xray-learn-youtube`).
