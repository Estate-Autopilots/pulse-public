#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.3.0"]
# ///
"""Render a Pulse update draft (pulse-update-draft/v1 JSON) into a 1080x1350 PNG card, without a browser.

  uv run --script tools/update-card/render.py <draft.json> <card.png> [--org "Company name"]

The card follows the daily hand-off template (light theme): a brand header with the headline, one block per
draft section with status chips and progress bars, the "needs" section as a highlighted list, and the footer
"Prepared by Pulse (AI) for <onBehalfOf>". What does not fit becomes "+N more": the longest lists are cut first,
then notes shrink to one line, then the last sections (draft order is priority, "needs" is kept whole longest)
fold into one closing "+N more in <section>" line. Each cut is reported on stderr. The PNG is written
atomically; on an unreadable draft or a card that cannot fit, nothing is written and the exit code is 2, so the
caller posts the text alone.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime
from functools import cache
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FORMAT = "pulse-update-draft/v1"
WIDTH, HEIGHT = 1080, 1350
SS = 2                 # draw at 2x and downscale once: smooth corners and text
MARGIN = 36            # ground around the card, in output pixels
CARD_CSS = 560         # card width in the template's CSS px (its column is 560 wide); sizes below are CSS px
K = (WIDTH - 2 * MARGIN) * SS / CARD_CSS
FONTS = Path(__file__).resolve().parent / "fonts"
FOOTER = "Prepared by Pulse (AI) for {who}"

# Light theme of the template (EA brand).
C = {
    "ground": "#EEF1F4", "card": "#FFFFFF", "sunk": "#F3F5F8", "ink": "#141821", "muted": "#5D6573",
    "line": "#E1E5EB", "brand": "#0E7C6B", "brand-soft": "#E3F3EF",
    "good": "#17804A", "good-soft": "#E3F4EA", "prog": "#2B5FB3", "prog-soft": "#E4ECFA",
    "next": "#7A4FD0", "next-soft": "#EFE8FC", "warn": "#9A5A06", "warn-soft": "#FFF1D9",
}
# Register statuses -> chip label and tone; any other status shows as its own words.
CHIPS = {
    "live": ("Live", "good"), "done": ("Done", "good"), "in_progress": ("In progress", "prog"),
    "test_site": ("Test site", "prog"), "waiting": ("Waiting", "warn"), "planned": ("Planned", "next"),
    "started": ("Started", "next"), "new": ("New", "next"),
}
EDITIONS = {"morning": "Morning update", "night": "Night update"}


class DraftError(ValueError):
    pass


def px(css: float) -> int:
    return round(css * K)


def mix(fg: str, bg: str, alpha: float) -> tuple[int, int, int]:
    a, b = (tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) for h in (fg, bg))
    return tuple(round(x * alpha + y * (1 - alpha)) for x, y in zip(a, b))


@cache
def font(size: float, weight: int, display: bool = False) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONTS / ("BricolageGrotesque.ttf" if display else "PublicSans.ttf")), size * K)
    axes = {b"Weight": weight, b"Width": 90, b"Optical size": min(max(size, 12), 96)}
    f.set_variation_by_axes([axes[a["name"]] for a in f.get_variation_axes()])
    return f


@dataclass(frozen=True)
class Text:
    size: float
    weight: int
    color: str | tuple[int, int, int]
    line_height: float = 1.5
    display: bool = False
    tracking: float = 0.0   # letter-spacing in em, for the uppercase labels

    @property
    def font(self) -> ImageFont.FreeTypeFont:
        return font(self.size, self.weight, self.display)

    @property
    def lh(self) -> int:
        return px(self.size * self.line_height)

    def length(self, s: str) -> float:
        if not self.tracking:
            return self.font.getlength(s)
        return sum(self.font.getlength(ch) for ch in s) + self.tracking * self.size * K * len(s)

    def wrap(self, text: str, width: float, max_lines: int) -> list[str]:
        lines: list[str] = []
        for word in text.split():
            if lines and self.length(f"{lines[-1]} {word}") <= width:
                lines[-1] = f"{lines[-1]} {word}"
            else:
                lines.append(word)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] += "…"
        for i, line in enumerate(lines):  # an over-long word, or the added ellipsis, may still overflow
            while self.length(line) > width and len(line) > 1:
                line = line[:-2].rstrip() + "…"
            lines[i] = line
        return lines


H2 = Text(12, 700, C["muted"], tracking=0.08)
TITLE = Text(14.5, 700, C["ink"])
NOTE = Text(13, 400, C["muted"])
MORE = Text(12.5, 600, C["muted"])
CHIP = Text(11, 700, C["ink"], line_height=1)
NEED = Text(14, 400, C["ink"])
FOOT = Text(12, 400, C["muted"])
ON_BRAND = mix("#FFFFFF", C["brand"], 0.9)
WHO = Text(12, 600, ON_BRAND, tracking=0.06)
H1 = Text(25, 750, "#FFFFFF", line_height=1.15, display=True)
WHEN = Text(13, 400, ON_BRAND)


class Painter:
    """Measures when `draw` is None and draws otherwise, so layout and drawing share one code path."""

    def __init__(self, draw: ImageDraw.ImageDraw | None = None):
        self.draw = draw
        self.texts: list[str] = []   # every drawn text run, for the tests

    def line(self, style: Text, s: str, x: float, y: float, anchor: str = "l", color=None) -> int:
        if self.draw is not None and s:
            f = style.font
            asc, desc = f.getmetrics()
            base = y + (style.lh - asc - desc) / 2 + asc
            x -= {"l": 0, "m": style.length(s) / 2, "r": style.length(s)}[anchor]
            fill = color or style.color
            if style.tracking:
                for ch in s:
                    self.draw.text((x, base), ch, font=f, fill=fill, anchor="ls")
                    x += f.getlength(ch) + style.tracking * style.size * K
            else:
                self.draw.text((x, base), s, font=f, fill=fill, anchor="ls")
            self.texts.append(s)
        return style.lh

    def lines(self, style: Text, lines: list[str], x: float, y: float, **kw) -> int:
        return sum(self.line(style, s, x, y + i * style.lh, **kw) for i, s in enumerate(lines))

    def box(self, xy, radius: float, fill, corners=None) -> None:
        if self.draw is not None:
            self.draw.rounded_rectangle(xy, radius=radius, fill=fill, corners=corners)


@dataclass
class Section:
    key: str
    title: str
    note: str
    items: list[dict]
    total: int
    shown: int = 0
    note_lines: int = 2
    folded: bool = False

    @property
    def needs(self) -> bool:
        return self.key == "needs"

    @property
    def hidden(self) -> int:
        return self.total if self.folded else self.total - self.shown


def text_of(value, what: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise DraftError(f"{what} must be a string")
    return " ".join(value.split())


def parse(draft) -> tuple[dict, list[Section]]:
    if not isinstance(draft, dict) or draft.get("format") != FORMAT:
        raise DraftError(f"not a {FORMAT} draft")
    head = {
        "headline": text_of(draft.get("headline"), "headline"),
        "edition": EDITIONS.get(draft.get("edition"), "Update"),
        "on_behalf_of": text_of(draft.get("onBehalfOf"), "onBehalfOf"),
        "org": text_of(draft.get("org"), "org"),
        "when": "",
    }
    if not head["headline"]:
        raise DraftError("headline is empty")
    window = draft.get("window") or {}
    if not isinstance(window, dict):
        raise DraftError("window must be an object")
    if window.get("end"):
        try:
            at = datetime.fromisoformat(window["end"]).astimezone(ZoneInfo(window.get("timezone") or "UTC"))
        except (TypeError, ValueError, KeyError) as exc:
            raise DraftError(f"window: {exc}") from exc
        head["when"] = f"{at:%a} {at.day} {at:%b %Y} · {at:%H:%M} {at.tzname()}"
    if not isinstance(draft.get("sections"), list):
        raise DraftError("sections must be a list")
    sections = []
    for raw in draft["sections"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("items", []), list):
            raise DraftError("each section needs a title and an items list")
        items = []
        for it in raw.get("items", []):
            it = {"title": it} if isinstance(it, str) else it
            if not isinstance(it, dict) or not text_of(it.get("title"), "item title"):
                raise DraftError(f"section {raw.get('key')!r}: every item needs a title")
            items.append(it)
        count = raw.get("count") if isinstance(raw.get("count"), int) else 0
        note = text_of(raw.get("note"), "section note")
        if not items and not note and not count:
            continue
        sections.append(Section(text_of(raw.get("key"), "key"), text_of(raw.get("title"), "section title"),
                                note, items, max(count, len(items)), shown=len(items)))
    return head, sections


def chip(it: dict) -> tuple[str, str] | None:
    status = text_of(it.get("status"), "status")
    label, tone = CHIPS.get(status, (status.replace("_", " ").capitalize(), "next"))
    label = text_of(it.get("chip"), "chip") or label
    return (label, tone) if label else None


def item_block(p: Painter, it: dict, x: float, y: float, w: float, note_lines: int) -> int:
    pad_x, pad_y, gap = px(12), px(10), px(10)
    c = chip(it)
    chip_w = CHIP.length(c[0]) + px(18) if c else 0
    text_w = w - 2 * pad_x - (chip_w + gap if c else 0)
    title = TITLE.wrap(text_of(it["title"], "title"), text_w, 2)
    note = NOTE.wrap(text_of(it.get("note"), "note"), text_w, note_lines)
    progress = it.get("progress")
    bar = isinstance(progress, (int, float)) and not isinstance(progress, bool) and progress < 100
    text_h = len(title) * TITLE.lh + len(note) * NOTE.lh + (px(12) if bar else 0)
    h = 2 * pad_y + max(text_h, px(23) if c else 0)
    if p.draw is not None:
        p.box((x, y, x + w, y + h), px(12), C["sunk"])
        ty = y + pad_y + p.lines(TITLE, title, x + pad_x, y + pad_y)
        ty += p.lines(NOTE, note, x + pad_x, ty)
        if bar:
            top = ty + px(6)
            p.box((x + pad_x, top, x + pad_x + text_w, top + px(6)), px(3), C["line"])
            if progress > 0:
                fill_w = max(text_w * min(progress, 100) / 100, px(6))
                p.box((x + pad_x, top, x + pad_x + fill_w, top + px(6)), px(3), C["brand"])
        if c:
            cx = x + w - pad_x - chip_w
            p.box((cx, y + pad_y, cx + chip_w, y + pad_y + px(23)), px(23) // 2, C[f"{c[1]}-soft"])
            p.line(CHIP, c[0], cx + px(9), y + pad_y + px(6), color=C[c[1]])
    return h


def heading(p: Painter, s: Section, x: float, y: float, w: float, color=None) -> int:
    """The section title, with "+N more" on the right when items were cut."""
    more = f"+{s.hidden} more" if s.hidden else ""
    room = w - (MORE.length(more) + px(10) if more else 0)
    p.line(H2, H2.wrap(s.title.upper(), room, 1)[0] if s.title else "", x, y, color=color)
    p.line(MORE, more, x + w, y + (H2.lh - MORE.lh) / 2, anchor="r")
    return H2.lh


def section_block(p: Painter, s: Section, x: float, y: float, w: float) -> int:
    if s.needs:
        return needs_block(p, s, x, y, w)
    gap = px(8)
    top = y
    y += heading(p, s, x, y, w)
    if s.note:
        y += gap + p.lines(NOTE, NOTE.wrap(s.note, w, s.note_lines), x, y + gap)
    for it in s.items[:s.shown]:
        y += gap + item_block(p, it, x, y + gap, w, s.note_lines)
    return y - top


def needs_block(p: Painter, s: Section, x: float, y: float, w: float) -> int:
    pad_x, pad_y, indent = px(14), px(12), px(20)
    rows = [NEED.wrap(" ".join(filter(None, (text_of(it["title"], "title"), text_of(it.get("note"), "note")))),
                      w - 2 * pad_x - indent, s.note_lines) for it in s.items[:s.shown]]
    h = 2 * pad_y + H2.lh + px(6) + sum(len(r) for r in rows) * NEED.lh
    if p.draw is not None:
        p.box((x, y, x + w, y + h), px(14), C["brand-soft"])
        ty = y + pad_y + heading(p, s, x + pad_x, y + pad_y, w - 2 * pad_x, color=C["brand"]) + px(6)
        for n, row in enumerate(rows, 1):
            p.line(NEED, f"{n}.", x + pad_x + indent - NEED.font.getlength(" "), ty, anchor="r")
            ty += p.lines(NEED, row, x + pad_x + indent, ty)
    return h


def folded_lines(sections: list[Section], w: float) -> list[str]:
    parts = [f"+{s.hidden} more in {s.title or s.key}" for s in sections if s.folded and s.hidden]
    return MORE.wrap(" · ".join(parts), w, 2) if parts else []


def header_block(p: Painter, head: dict, x: float, y: float, w: float) -> int:
    pad_x, gap = px(20), px(8)
    inner = w - 2 * pad_x
    h1 = H1.wrap(head["headline"], inner, 3)
    when = " · ".join(filter(None, (head["when"], head["on_behalf_of"] and f"from {head['on_behalf_of']}")))
    h = px(20) + WHO.lh + gap + len(h1) * H1.lh + (gap + WHEN.lh if when else 0) + px(18)
    if p.draw is not None:
        p.box((x, y, x + w, y + h), px(22), C["brand"], corners=(True, True, False, False))
        ty = y + px(20)
        edition = head["edition"].upper()
        org = " · ".join(filter(None, ("Pulse", head["org"]))).upper()
        p.line(WHO, WHO.wrap(org, inner - WHO.length(edition) - px(10), 1)[0], x + pad_x, ty)
        ty += p.line(WHO, edition, x + w - pad_x, ty, anchor="r") + gap
        ty += p.lines(H1, h1, x + pad_x, ty)
        if when:
            p.line(WHEN, when, x + pad_x, ty + gap)
    return h


def body_height(sections: list[Section], w: float, gap: int) -> int:
    m = Painter()
    blocks = [section_block(m, s, 0, 0, w) for s in sections if not s.folded]
    folded = folded_lines(sections, w)
    if folded:
        blocks.append(len(folded) * MORE.lh)
    return sum(blocks) + gap * max(len(blocks) - 1, 0)


def fit(sections: list[Section], room: float, w: float, gap: int) -> None:
    """Cut until the body fits: the longest lists down to two items, notes to one line, lists down to one
    item, then fold whole sections from the end of the draft. The "needs" list is cut only after everything
    else is folded. Then give back, in draft order, whatever still fits: folded sections first, then items,
    then second note lines."""

    def fits() -> bool:
        return body_height(sections, w, gap) <= room

    def give_back(s: Section, attr: str, value) -> bool:
        old = getattr(s, attr)
        setattr(s, attr, value)
        if fits():
            return True
        setattr(s, attr, old)
        return False

    if fits():
        return
    floor = 2
    while not fits():
        open_ = [s for s in sections if not s.folded]
        cut = [s for s in open_ if s.shown > floor and not s.needs]
        if cut:
            max(cut, key=lambda s: (s.shown, sections.index(s))).shown -= 1
        elif floor == 2:
            floor = 1
            for s in sections:
                s.note_lines = 1
        elif any(not s.needs for s in open_):
            next(s for s in reversed(open_) if not s.needs).folded = True
        elif any(s.shown > 1 for s in open_):
            next(s for s in open_ if s.shown > 1).shown -= 1
        else:
            raise DraftError("the draft does not fit on one card even with every section folded")
    for s in sections:
        if s.folded:
            s.shown = min(s.shown, 1)
            give_back(s, "folded", False)
    grown = True
    while grown:
        grown = False
        for s in sections:
            if not s.folded and s.shown < len(s.items):
                grown = give_back(s, "shown", s.shown + 1) or grown
    for s in sections:
        give_back(s, "note_lines", 2)


def render(draft, org: str = "") -> tuple[Image.Image, list[str], list[str]]:
    """Returns the card, the drawn text runs and one line per cut."""
    head, sections = parse(draft)
    head["org"] = head["org"] or org
    cw, ch = (WIDTH - 2 * MARGIN) * SS, (HEIGHT - 2 * MARGIN) * SS
    x0, y0 = MARGIN * SS, MARGIN * SS
    bx, bw, gap = x0 + px(18), cw - 2 * px(18), px(18)
    top_h = header_block(Painter(), head, x0, y0, cw)
    room = ch - top_h - px(16) - px(20) - (px(4) + FOOT.lh) - gap
    fit(sections, room, bw, gap)

    img = Image.new("RGB", (WIDTH * SS, HEIGHT * SS), C["ground"])
    shadow = Image.new("L", img.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + px(10), x0 + cw, y0 + ch + px(10)), px(22), fill=20)
    img.paste((20, 24, 33), mask=shadow.filter(ImageFilter.GaussianBlur(px(15))))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((x0, y0, x0 + cw, y0 + ch), px(22), fill=C["card"])
    p = Painter(d)
    header_block(p, head, x0, y0, cw)
    y = y0 + top_h + px(16)
    for s in sections:
        if not s.folded:
            y += section_block(p, s, bx, y, bw) + gap
    p.lines(MORE, folded_lines(sections, bw), bx, y)
    foot = FOOTER.format(who=head["on_behalf_of"] or "your team")
    p.line(FOOT, foot, x0 + cw / 2, y0 + ch - px(20) - FOOT.lh, anchor="m")
    d.rounded_rectangle((x0, y0, x0 + cw, y0 + ch), px(22), outline=C["line"], width=max(px(1), 1))
    cuts = [f"{s.key}: folded, +{s.hidden} more" if s.folded else f"{s.key}: {s.shown} shown, +{s.hidden} more"
            for s in sections if s.hidden and (s.folded or s.shown < len(s.items))]
    return img.resize((WIDTH, HEIGHT), Image.LANCZOS), p.texts, cuts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("draft", type=Path, help="pulse-update-draft/v1 JSON file")
    ap.add_argument("out", type=Path, help="PNG to write (parent directories are created)")
    ap.add_argument("--org", default="", help="company name for the header when the draft has no `org`")
    args = ap.parse_args(argv)
    try:
        draft = json.loads(args.draft.read_text(encoding="utf-8"))
        img, _, cuts = render(draft, args.org)
    except (OSError, json.JSONDecodeError, DraftError) as exc:
        print(f"update-card: {exc}", file=sys.stderr)
        return 2
    for cut in cuts:
        print(f"update-card: {cut}", file=sys.stderr)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_name(f".{args.out.name}.tmp")
    img.save(tmp, "PNG", optimize=True)
    os.replace(tmp, args.out)
    print(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
