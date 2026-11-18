# Compositor project

`plan.json` is the complete, frame-exact edit decision list this reel was rendered from (30 fps):

- `beats[]`: one shot each: the source take, `segs` (the source-frame map: 1x around every logged action, idle
  stretches sped up to at most 3x, longer ones jump-cut), `camera` keyframes (centre x/y in take pixels and zoom,
  eased like a spring), the hook text and the transition (`start`, `cut` with a punch-in, `whip` between takes).
- `captions[]`: word cards with each word's first and last frame (from ElevenLabs character timings).
- `sfx[]` and `voice[]`: where each sound and line starts.
- `end`: the end card.

Re-render with the Pulse repo's `tools/tutorials` (`reels.py build`), after editing the plan or the storyboard.
This replaces a Remotion project: Remotion needs a paid Company License for a company of more than three people, so
the pipeline uses its own ffmpeg + Pillow compositor with the same frame-based model.
