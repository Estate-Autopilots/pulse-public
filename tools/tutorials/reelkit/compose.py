"""Frame compositor: renders a plan to video with exact frame math (Pillow + numpy, piped to ffmpeg).

Layouts:
- reel: 1080x1920. The phone capture fills the frame; the camera (centre and zoom per frame, from the plan) picks the
  crop. Hook text on top, word-by-word captions in the lower-middle safe zone (never in the bottom 20 %), whip
  transitions between takes, a punch-in on every cut, a short end card.
- wide: 1920x1080. The phone sits on a soft brand stage with the same camera inside it; the line plays karaoke-style
  on the right with the chapter title above it.

Every overlay can be switched off (clean=True) for the editor pack's clean clips.
"""

from __future__ import annotations

import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .plan import Seg, avoid_blank, camera_at, clamp_camera, ease

BRAND = (91, 69, 214)
INK = (18, 15, 36)
YELLOW = (255, 212, 59)
LILAC = (196, 184, 255)
SRC_W, SRC_H = 1170, 2532


@dataclass
class Fonts:
    path: Path
    _cache: dict = field(default_factory=dict)

    def get(self, size: int, weight: str = "Black") -> ImageFont.FreeTypeFont:
        k = (size, weight)
        if k not in self._cache:
            f = ImageFont.truetype(str(self.path), size)
            try:
                f.set_variation_by_name(weight)
            except Exception:  # noqa: BLE001 - a static font has no named instances
                pass
            self._cache[k] = f
        return self._cache[k]


class TakeReader:
    """Sequential decoder for one capture take; restarts with an exact seek when asked to go backwards."""

    def __init__(self, path: Path, threads: int = 2):
        self.path, self.threads = path, threads
        self.proc = None
        self.pos = -1
        self.frame: np.ndarray | None = None

    def _open(self, start: int) -> None:
        self.close()
        self.proc = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-threads", str(self.threads), "-ss", f"{start / 30:.6f}", "-i", str(self.path),
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL)  # the reader is killed on purpose after a seek: its broken-pipe noise is not news
        self.pos = start - 1

    def get(self, n: int) -> np.ndarray:
        if self.proc is None or n < self.pos or n - self.pos > 90:
            self._open(n)
        size = SRC_W * SRC_H * 3
        while self.pos < n:
            buf = self.proc.stdout.read(size)
            if len(buf) < size:  # past the end: keep the last frame
                self.pos = n
                break
            self.frame = np.frombuffer(buf, np.uint8).reshape(SRC_H, SRC_W, 3)
            self.pos += 1
        if self.frame is None:
            self.frame = np.zeros((SRC_H, SRC_W, 3), np.uint8)
        return self.frame

    def close(self) -> None:
        if self.proc:
            self.proc.stdout.close()
            self.proc.kill()
            self.proc.wait()
            self.proc = None
            self.frame = None


def src_frame(beat: dict, i: int) -> int:
    f = None
    for s in beat["segs"]:
        if s["out"] <= i < s["out"] + s["n"]:
            f = Seg(**s).src_at(i)
            break
    if f is None:
        last = beat["segs"][-1]
        f = Seg(**last).src_at(last["out"] + last["n"] - 1)
    return avoid_blank(f, beat.get("blank", []))


def blur_regions(img: np.ndarray, regions: list, src: int) -> np.ndarray:
    """Blur [from, to, x, y, w, h] regions (take px) active at source frame src (an invite link, a QR code)."""
    active = [r for r in regions if r[0] <= src < r[1]]
    if not active:
        return img
    pil = Image.fromarray(img)
    for _, _, x, y, w, h in active:
        b = tuple(int(v) for v in (max(0, x), max(0, y), min(SRC_W, x + w), min(SRC_H, y + h)))
        if b[2] > b[0] and b[3] > b[1]:
            pil.paste(pil.crop(b).filter(ImageFilter.GaussianBlur(28)), b[:2])
    return np.asarray(pil)


def screen_box(box: list, cam: tuple[float, float, float], size: tuple[int, int]) -> tuple[float, float, float, float]:
    """A take-px box as it lands in the output frame under camera cam."""
    x, y, w, h = clamp_camera(*cam, SRC_W, SRC_H, size[0] / size[1])
    k = size[0] / w
    return ((box[0] - x) * k, (box[1] - y) * k, box[2] * k, box[3] * k)


CAPTION_Y = (1290, 1410, 800)  # preferred centre first; never in the bottom 20 % of a 1920 frame


def caption_y(beat: dict, size: tuple[int, int], half: float = 115) -> int:
    """One caption height per shot, the slot that keeps the cards off what the shot is about: every element logged in
    it and the next tap just after it. A small target (a button) outweighs a big one (a whole card)."""
    if not beat.get("avoid"):
        return CAPTION_Y[0]
    boxes = [screen_box(a["box"], camera_at(beat["camera"], min(max(a["f"], 0), beat["frames"] - 1)), size) for a in beat["avoid"]]
    small = [b for b in boxes if b[3] < size[1] * 0.4]

    def overlap(y: int, bs) -> float:
        return sum(max(0.0, min(y + half, b[1] + b[3]) - max(y - half, b[1])) for b in bs)

    return min(CAPTION_Y, key=lambda y: (overlap(y, small), overlap(y, boxes), CAPTION_Y.index(y)))


def view(img: np.ndarray, cam: tuple[float, float, float], size: tuple[int, int]) -> Image.Image:
    x, y, w, h = clamp_camera(*cam, SRC_W, SRC_H, size[0] / size[1])
    pil = Image.fromarray(img)
    return pil.resize(size, Image.Resampling.LANCZOS, box=(x, y, x + w, y + h))


# ------------------------------------------------------------------------------------------------- text drawing
def text_card(fonts: Fonts, words: list[dict], active: int, size: int, max_w: int, stroke: int = 10) -> tuple[Image.Image, bool]:
    """A caption card: words in white, the spoken word in yellow, key words lilac. Returns (image, overflowed)."""
    font = fonts.get(size, "Black")
    space = font.getlength(" ")
    widths = [font.getlength(w["text"]) for w in words]
    lines: list[list[int]] = [[]]
    cur = 0.0
    for i, wd in enumerate(widths):
        need = wd if not lines[-1] else cur + space + wd
        if lines[-1] and need > max_w:
            lines.append([i])
            cur = wd
        else:
            lines[-1].append(i)
            cur = need
    over = any(widths[i] > max_w for i in range(len(words))) or len(lines) > 2
    asc, desc = font.getmetrics()
    lh = asc + desc
    line_w = [sum(widths[i] for i in ln) + space * (len(ln) - 1) for ln in lines]
    W = int(max(line_w) + stroke * 2 + 24)
    H = int(lh * len(lines) + stroke * 2 + 16 + (len(lines) - 1) * 6)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d, ds = ImageDraw.Draw(img), ImageDraw.Draw(shadow)
    y = stroke + 8
    for ln, lw in zip(lines, line_w):
        x = (W - lw) / 2
        for i in ln:
            w = words[i]
            fill = YELLOW if i == active else (LILAC if w.get("key") else (255, 255, 255))
            ds.text((x + 4, y + 7), w["text"], font=font, fill=(0, 0, 0, 150), stroke_width=stroke, stroke_fill=(0, 0, 0, 150))
            d.text((x, y), w["text"], font=font, fill=fill, stroke_width=stroke, stroke_fill=INK)
            x += widths[i] + space
        y += lh + 6
    out = Image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(8)), img)
    return out, over


def hook_lines(text: str, measure, max_w: float) -> list[str]:
    """One line if it fits; else two lines split where the longer one is shortest (never a lone last word)."""
    if measure(text) <= max_w:
        return [text]
    words = text.split()
    best = min(range(1, len(words)), key=lambda i: max(measure(" ".join(words[:i])), measure(" ".join(words[i:]))), default=None)
    return [text] if best is None else [" ".join(words[:best]), " ".join(words[best:])]


def hook_card(fonts: Fonts, text: str, size: int = 92, max_w: int = 900) -> Image.Image:
    """Big hook text on brand-purple pills, one pill per line; shrinks a little to stay on one line."""
    for s in (size, int(size * 0.92), int(size * 0.85)):
        if fonts.get(s, "Black").getlength(text) <= max_w:
            size = s
            break
    font = fonts.get(size, "Black")
    lines = hook_lines(text, font.getlength, max_w)
    asc, desc = font.getmetrics()
    pad_x, pad_y, gap = 34, 18, 14
    lh = asc + desc + pad_y * 2
    W = int(max(font.getlength(ln) for ln in lines) + pad_x * 2 + 20)
    H = lh * len(lines) + gap * (len(lines) - 1) + 20
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y = 10
    for ln in lines:
        lw = font.getlength(ln)
        x0 = (W - lw) / 2 - pad_x
        d.rounded_rectangle((x0, y, x0 + lw + pad_x * 2, y + lh), radius=26, fill=BRAND + (255,))
        d.text(((W - lw) / 2, y + pad_y - 2), ln, font=font, fill=(255, 255, 255))
        y += lh + gap
    sh = Image.new("RGBA", (W + 40, H + 40), (0, 0, 0, 0))
    sh.paste(Image.new("RGBA", img.size, (0, 0, 0, 90)), (20, 30), img)
    sh = sh.filter(ImageFilter.GaussianBlur(14))
    sh.alpha_composite(img, (20, 20))
    return sh


def scaled(img: Image.Image, k: float) -> Image.Image:
    if abs(k - 1) < 1e-3:
        return img
    return img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))), Image.Resampling.BICUBIC)


def pop(t: int, n: int = 6) -> float:
    """Scale for a pop-in over n frames: 0.82 rising past 1.0 and settling at exactly 1.0."""
    if t >= n:
        return 1.0
    x = t / n
    return 0.82 + 0.18 * x + 0.10 * math.sin(math.pi * x)


def paste_center(base: Image.Image, img: Image.Image, cx: float, cy: float, alpha: float = 1.0) -> None:
    if alpha < 1:
        a = img.getchannel("A").point(lambda v: int(v * alpha))
        img = img.copy()
        img.putalpha(a)
    base.alpha_composite(img, (int(cx - img.width / 2), int(cy - img.height / 2)))


def vertical_gradient(w: int, h: int, top: tuple, bottom: tuple) -> Image.Image:
    t = np.linspace(0, 1, h)[:, None]
    arr = (np.array(top)[None, None, :] * (1 - t[..., None]) + np.array(bottom)[None, None, :] * t[..., None])
    arr = np.repeat(arr, w, axis=1)
    return Image.fromarray(arr.astype(np.uint8), "RGBA" if len(top) == 4 else "RGB")


# --------------------------------------------------------------------------------------------------- renderer
@dataclass
class Renderer:
    plan: dict
    takes: dict[str, Path]
    fonts: Fonts
    layout: str = "reel"
    clean: bool = False
    icon: Path | None = None
    overflow: list = field(default_factory=list)

    def __post_init__(self) -> None:
        self.size = (1080, 1920) if self.layout == "reel" else (1920, 1080)
        self.readers = {k: TakeReader(p) for k, p in self.takes.items()}
        self.active_take: str | None = None
        self.last_of: dict[int, Image.Image] = {}  # beat index -> its last phone frame
        self.card_cache: dict = {}
        self.hook_cache: dict = {}
        self.beat_at = []
        for bi, b in enumerate(self.plan["beats"]):
            self.beat_at.extend([bi] * b["frames"])
        if self.layout == "reel":
            self.top_shade = vertical_gradient(self.size[0], 760, (10, 8, 24, 170), (10, 8, 24, 0))
            half = vertical_gradient(self.size[0], 210, (10, 8, 24, 0), (10, 8, 24, 105))
            band = Image.new("RGBA", (self.size[0], 420))
            band.paste(half, (0, 0))
            band.paste(half.transpose(Image.Transpose.FLIP_TOP_BOTTOM), (0, 210))
            self.cap_shade = band  # fades in and out around the caption: no hard edge
        else:
            self.stage = self._stage()
            self.panel = (430, 940)  # phone panel inside the stage
            self.panel_xy = (250, 70)
            r = Image.new("L", self.panel, 0)
            ImageDraw.Draw(r).rounded_rectangle((0, 0, self.panel[0] - 1, self.panel[1] - 1), radius=52, fill=255)
            self.panel_mask = r

    # ---- frames
    def phone_frame(self, f: int) -> tuple[Image.Image, dict, int]:
        bi = self.beat_at[f] if f < len(self.beat_at) else len(self.plan["beats"]) - 1
        b = self.plan["beats"][bi]
        i = min(f - b["start"], b["frames"] - 1)
        cx, cy, z = camera_at(b["camera"], i)
        if b["transition"] in ("cut", "start") and i < 5 and not self.clean:  # punch-in on the cut
            z *= 1 + 0.07 * (1 - ease(i / 5))
        size = self.size if self.layout == "reel" else self.panel
        cached = self.last_of.get(bi)
        if i == b["frames"] - 1 and cached is not None:
            return cached, b, i
        src = src_frame(b, i)
        raw = blur_regions(self.reader(b["take"]).get(src), b.get("blur", []), src)
        frame = view(raw, (cx, cy, z), size)
        if i == b["frames"] - 1:
            self.last_of[bi] = frame  # the whip and the end card reuse it, so no second decoder is needed
        return frame, b, i

    def reader(self, take: str) -> "TakeReader":
        """One decoder at a time: the host may allow only two heavy processes (the encoder and this one)."""
        if self.active_take != take:
            if self.active_take is not None:
                self.readers[self.active_take].close()
            self.active_take = take
        return self.readers[take]

    def frame(self, f: int) -> Image.Image:
        end = self.plan["end"]
        if f >= end["start"]:
            return self.end_card(f - end["start"])
        ph, b, i = self.phone_frame(f)
        if b["transition"] == "whip" and i < 6 and not self.clean and b["start"] > 0:
            prev_img, _, _ = self.phone_frame(b["start"] - 1)
            ph = self.whip(prev_img, ph, i / 6)
        if self.layout == "reel":
            img = ph.convert("RGBA")
            if not self.clean:
                self.overlays_reel(img, f, b, i)
        else:
            img = self.stage.copy()
            self.place_phone(img, ph)
            if not self.clean:
                self.overlays_wide(img, f, b, i)
        return img.convert("RGB")

    def whip(self, a: Image.Image, b: Image.Image, t: float) -> Image.Image:
        """Push transition with motion blur: the old shot leaves left as the new one enters from the right."""
        w = a.width
        k = ease(t)
        off = int(w * k)
        A, B = np.asarray(a.convert("RGB")).astype(np.float32), np.asarray(b.convert("RGB")).astype(np.float32)
        canvas = np.zeros_like(A)
        canvas[:, : w - off] = A[:, off:]
        canvas[:, w - off:] = B[:, : off]
        blur = int(60 * math.sin(t * math.pi)) + 1
        if blur > 2:
            acc = np.zeros_like(canvas)
            for s in range(0, blur, max(1, blur // 6)):
                acc += np.roll(canvas, s, axis=1)
            canvas = acc / len(range(0, blur, max(1, blur // 6)))
        return Image.fromarray(canvas.clip(0, 255).astype(np.uint8))

    # ---- reel overlays
    def overlays_reel(self, img: Image.Image, f: int, b: dict, i: int) -> None:
        W, H = self.size
        if b.get("hook"):
            img.alpha_composite(self.top_shade, (0, 0))
            hk = self.hook_cache.setdefault(b["hook"], hook_card(self.fonts, b["hook"]))
            paste_center(img, scaled(hk, pop(i)), W / 2, 330)
        cap = self.caption_at(f)
        if cap:
            card, active, age = cap
            if "caption_y" not in b:
                b["caption_y"] = caption_y(b, self.size)
            y = b["caption_y"]
            img.alpha_composite(self.cap_shade, (0, y - 210))
            key = (id(card), active)
            if key not in self.card_cache:
                im, over = text_card(self.fonts, card["words"], active, 84, 900)
                self.card_cache[key] = im
                if over:
                    self.overflow.append({"f": f, "text": " ".join(w["text"] for w in card["words"])})
            paste_center(img, scaled(self.card_cache[key], pop(age, 4)), W / 2, y)

    def caption_at(self, f: int):
        for c in self.plan["captions"]:
            if c["f0"] <= f < c["f1"]:
                active = 0
                for k, w in enumerate(c["words"]):
                    if f >= w["f0"]:
                        active = k
                return c, active, f - c["f0"]
        return None

    # ---- wide stage
    def _stage(self) -> Image.Image:
        W, H = self.size
        g = vertical_gradient(W, H, (246, 246, 250), (232, 227, 255)).convert("RGBA")
        blob = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(blob).ellipse((-200, 380, 900, 1400), fill=BRAND + (40,))
        ImageDraw.Draw(blob).ellipse((1300, -300, 2200, 500), fill=(255, 212, 59, 40))
        g.alpha_composite(blob.filter(ImageFilter.GaussianBlur(120)))
        # Panel shadow
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((250 + 10, 70 + 26, 250 + 430 + 10, 70 + 940 + 26), radius=56, fill=(30, 20, 80, 70))
        g.alpha_composite(sh.filter(ImageFilter.GaussianBlur(28)))
        if self.icon and self.icon.exists():
            ic = Image.open(self.icon).convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)
            g.alpha_composite(ic, (W - 64 - 60, H - 64 - 48))
        return g

    def place_phone(self, img: Image.Image, ph: Image.Image) -> None:
        img.paste(ph, self.panel_xy, self.panel_mask)

    def overlays_wide(self, img: Image.Image, f: int, b: dict, i: int) -> None:
        d = ImageDraw.Draw(img)
        x0 = 820
        title = b.get("chapter") or self.plan.get("title") or ""
        d.text((x0, 210), title, font=self.fonts.get(40, "Bold"), fill=BRAND)
        if b.get("hook") and i < 60:
            hk = self.hook_cache.setdefault(("w", b["hook"]), hook_card(self.fonts, b["hook"], 64, 900))
            paste_center(img, scaled(hk, pop(i)), x0 + 460, 420)
        # Karaoke line: every word of this beat, spoken ones dark, the current one in brand colour.
        words = [w for c in self.plan["captions"] if c.get("beat") == b["id"] for w in c["words"]]
        if words:
            font = self.fonts.get(58, "Bold")
            space = font.getlength(" ")
            x, y, maxw = x0, 560 if b.get("hook") and i < 60 else 420, 960
            for w in words:
                wd = font.getlength(w["text"])
                if x + wd > x0 + maxw:
                    x, y = x0, y + 78
                col = BRAND if w["f0"] <= f < w["f1"] else ((27, 21, 48) if f >= w["f0"] else (160, 155, 182))
                d.text((x, y), w["text"], font=font, fill=col)
                x += wd + space
            if y > 980:
                self.overflow.append({"f": f, "text": "wide line runs past the frame"})

    # ---- end card
    def end_card(self, t: int) -> Image.Image:
        W, H = self.size
        last = self.plan["end"]["start"] - 1
        if self.layout == "reel":
            ph, _, _ = self.phone_frame(last)
            base = ph.convert("RGBA").filter(ImageFilter.GaussianBlur(min(28, 4 + t * 3)))
        else:
            base = self.stage.copy()
            ph, _, _ = self.phone_frame(last)
            self.place_phone(base, ph)
            base = base.filter(ImageFilter.GaussianBlur(min(22, 3 + t * 3)))
        base.alpha_composite(Image.new("RGBA", (W, H), BRAND + (int(min(200, 40 + t * 22)),)))
        if self.clean:
            return base.convert("RGB")
        k = pop(t, 7)
        if self.icon and self.icon.exists():
            ic = Image.open(self.icon).convert("RGBA").resize((220, 220), Image.Resampling.LANCZOS)
            paste_center(base, scaled(ic, k), W / 2, H / 2 - 170)
        word = text_plain(self.fonts, "Pulse", 120, (255, 255, 255))
        paste_center(base, scaled(word, k), W / 2, H / 2 + 10)
        sub = text_plain(self.fonts, self.plan["end"]["text"], 58, (255, 255, 255), "SemiBold")
        paste_center(base, scaled(sub, k), W / 2, H / 2 + 120, alpha=min(1.0, t / 6))
        return base.convert("RGB")

    # ---- output
    def render(self, out: Path, bitrate: str = "10M", threads: int = 2, frames: int | None = None) -> dict:
        n = frames or self.plan["frames"]
        W, H = self.size
        cmd = ["nice", "-n", "19", "ionice", "-c3", "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", f"{W}x{H}", "-r", "30", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-profile:v", "high",
               "-b:v", bitrate, "-maxrate", "12M", "-bufsize", "20M", "-pix_fmt", "yuv420p", "-threads", str(threads),
               "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", str(out)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            for f in range(n):
                proc.stdin.write(self.frame(f).tobytes())
        finally:
            proc.stdin.close()
            proc.wait()
            for r in self.readers.values():
                r.close()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed for {out}")
        return {"frames": n, "overflow": self.overflow}


def text_plain(fonts: Fonts, text: str, size: int, fill, weight: str = "Black") -> Image.Image:
    font = fonts.get(size, weight)
    w = int(font.getlength(text)) + 20
    asc, desc = font.getmetrics()
    img = Image.new("RGBA", (w, asc + desc + 20), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((10, 10), text, font=font, fill=fill)
    return img
