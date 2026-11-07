# Pulse reel: editor pack

Everything a human editor needs to re-cut this reel. All people, companies, messages and amounts are fictional
(the "Brightside Studio" demo company on Pulse's dev server).

| Folder / file | What it is |
|---|---|
| `storyboard.json` | The shots, the lines (voice text and caption text per language) and the capture steps. |
| `media/takes/*.mp4` | Raw screen recordings of the real Pulse UI, phone 390x844 at 3x (1170x2532), constant 30 fps, CRF 12. |
| `media/takes/*.actions.json` | Action log per take: every tap, typed field, element appearing and mark, with its **frame number** and the element's **box** (CSS px; multiply by 3 for take pixels). Cut 2-4 frames before a tap; punch in on the box. |
| `media/stills/*.png` | A full-resolution still a few frames after every logged tap or appearance. |
| `media/sfx/*.mp3`, `media/music-bed.mp3` | The SFX kit (tap, whoosh, pop, chime) and the upbeat music bed (ElevenLabs). |
| `<lang>/media/clips/*.mp4` | The finished picture split per shot, 1080x1920, **without** captions or hook text (zooms, speed ramps and transitions kept). |
| `<lang>/media/voice/*.mp3` | One voice line per shot (ElevenLabs Eleven v3). |
| `<lang>/media/stems/{voice,sfx,music}.wav` | 48 kHz stems as placed in the final mix (music already ducked), before mastering. |
| `<lang>/*.fcpxml` | Final Cut Pro / DaVinci Resolve timeline: clips on the spine, voice, SFX and music on lanes below. |
| `<lang>/*-premiere.xml` | Premiere Pro (FCP7 XML) timeline with the same layout. |
| `<lang>/*.srt`, `*-words.srt` | Captions per line (max 2 x 42 characters) and word by word. |
| `<lang>/*-script.md` | Timecoded script: shot, on-screen hook, the exact voice text and the caption. |
| `<lang>/*-cue-sheet.csv` | Every cut, zoom keyframe, voice start, SFX hit, caption card and the end card, by timecode and frame. |
| `<lang>/compositor-project/` | The frame-exact edit plan the reel was rendered from (see its README). |

Timelines reference media by relative path: open them from inside this folder, or relink once to `media/`.
Mastering target for socials: -14 LUFS integrated, -1 dBTP, AAC 192 kbps, H.264 high at about 10 Mbps.
