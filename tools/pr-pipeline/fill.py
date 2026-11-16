"""PR-PIPELINE: fill a creative template with its copy blocks and its brand kit, and write a standalone HTML page.

Adapted from the PR-CREATIVES template pack (templates/ beside this file). A job is
{"id", "layout" (template file name), "size", "theme", "slots": {...}, "slide", "of"} and a brand
{"name", "byline", "industry", "kit": {...}} with an optional mark (base64 + mime, the company's own mark from Settings).
The kit is a preset (kits/<name>.json, chosen by kit.preset or the industry) with the brand's own overrides on top
(kit.themes.<theme>.<var>, kit.colors for every theme, kit.fonts, kit.motif). Brands without a mark get a monogram.
Text slots are escaped; *word* becomes an accent-coloured <em>, and a newline becomes <br>.
"""
from __future__ import annotations

import copy
import html as _html
import re
from pathlib import Path

T = Path(__file__).resolve().parent / "templates"
KITS = Path(__file__).resolve().parent / "kits"
SIZES = {"portrait": (1080, 1350), "square": (1080, 1080), "x": (1600, 900), "story": (1080, 1920), "card": (1200, 1600)}
LAYOUTS = {"slide-hook", "slide-number", "slide-steps", "slide-cta", "post-stat", "post-quote", "post-ba", "weekly-card"}
# A preset per industry when the brand names none (any brand can choose another, or set its own colours).
INDUSTRY_PRESET = {"software": "teal-coral", "creator": "indigo-amber", "consulting": "indigo-amber", "real_estate": "navy-gold",
                   "education": "navy-gold", "agency": "night-teal", "ecommerce": "night-teal", "other": "night-teal"}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$|^rgba?\([0-9., ]+\)$")
FONT_CSS = re.compile(r"^https://fonts\.googleapis\.com/css2\?[A-Za-z0-9@:;,.+&=_%-]+$")
FONT_NAME = re.compile(r"^[A-Za-z0-9 '\",.-]{1,120}$")

FIT_JS = """
(function(){
  function fit(){
    document.querySelectorAll('[data-fit]').forEach(function(el){
      var s=parseFloat(getComputedStyle(el).fontSize), min=parseFloat(el.dataset.min||36), g=0;
      while(el.scrollWidth>el.clientWidth+1 && s>min && g++<300){ s*=0.97; el.style.fontSize=s+'px'; }
    });
    var m=document.querySelector('.main')||document.querySelector('.xg');
    if(m){ var k=1,g=0; while(m.scrollHeight>m.clientHeight+1 && k>0.74 && g++<40){ k-=0.02; m.style.setProperty('--k',k); } }
  }
  document.fonts.ready.then(function(){ fit(); requestAnimationFrame(function(){ document.body.dataset.fitted='1'; }); });
})();
"""


def esc(v):
    s = _html.escape(str(v), quote=True)
    s = re.sub(r"\*(.+?)\*", r"<em>\1</em>", s)
    return s.replace("\n", "<br>")


_TAG = re.compile(r"\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{>\s*(\w+)\s*\}\}|\{\{([#^])\s*([\w.]+)\s*\}\}|\{\{\s*([\w.]+)\s*\}\}")


def _lookup(stack, name):
    if name == ".":
        return stack[-1]
    for c in reversed(stack):
        if isinstance(c, dict) and name in c:
            return c[name]
    if name.endswith("_any"):
        return bool(_lookup(stack, name[:-4]))
    return None


def render(tpl, stack):
    out, i = [], 0
    while True:
        m = _TAG.search(tpl, i)
        if not m:
            out.append(tpl[i:])
            return "".join(out)
        out.append(tpl[i:m.start()])
        raw, partial, sec, sname, var = m.groups()
        if raw:  # only the logo (built here, never from copy) is inserted raw
            v = _lookup(stack, raw) if raw == "logo" else esc(_lookup(stack, raw) or "")
            out.append("" if v is None else str(v))
            i = m.end()
        elif partial:
            out.append(render((T / "partials" / f"{partial}.html").read_text(encoding="utf-8"), stack))
            i = m.end()
        elif sec:
            tag = re.compile(r"\{\{([#^/])\s*" + re.escape(sname) + r"\s*\}\}")
            depth, j = 1, m.end()
            while depth:
                n = tag.search(tpl, j)
                if not n:
                    raise ValueError(f"unclosed section {sname}")
                depth += 1 if n.group(1) in "#^" else -1
                j = n.end()
            inner = tpl[m.end():n.start()]
            v = _lookup(stack, sname)
            if sec == "#":
                if isinstance(v, list):
                    for k, it in enumerate(v):
                        if isinstance(it, dict):
                            it = {**it, "_n": k + 1}
                        out.append(render(inner, stack + [it]))
                elif v:
                    out.append(render(inner, stack + [v] if isinstance(v, dict) else stack))
            elif not v:
                out.append(render(inner, stack))
            i = j
        else:
            v = _lookup(stack, var)
            out.append("" if v is None else esc(v))
            i = m.end()


def load_kit(brand: dict) -> dict:
    """The preset with the brand's own overrides; anything unsafe in the overrides is ignored."""
    own = brand.get("kit") or {}
    name = own.get("preset") if isinstance(own.get("preset"), str) and (KITS / f"{own.get('preset')}.json").is_file() else None
    name = name or INDUSTRY_PRESET.get(brand.get("industry") or "other", "night-teal")
    import json
    kit = copy.deepcopy(json.loads((KITS / f"{name}.json").read_text(encoding="utf-8")))
    colors = own.get("colors") if isinstance(own.get("colors"), dict) else {}
    for theme, vals in kit["themes"].items():
        for k, v in colors.items():
            if k in vals and isinstance(v, str) and HEX.match(v):
                vals[k] = v
        o = (own.get("themes") or {}).get(theme) if isinstance(own.get("themes"), dict) else None
        if isinstance(o, dict):
            for k, v in o.items():
                if k in vals and isinstance(v, str) and HEX.match(v):
                    vals[k] = v
    fonts = own.get("fonts") if isinstance(own.get("fonts"), dict) else {}
    if isinstance(fonts.get("css"), str) and FONT_CSS.match(fonts["css"]):
        kit["fonts_css"] = fonts["css"]
    for k in ("display", "body", "mono"):
        if isinstance(fonts.get(k), str) and FONT_NAME.match(fonts[k]):
            kit[f"font_{k}"] = fonts[k]
    if own.get("motif") in ("arcs", "ecg", "lens", "roof", "none"):
        kit["motif"] = own["motif"]
    kit["preset"] = name
    return kit


def initials(name: str) -> str:
    words = [w for w in re.split(r"[^A-Za-z0-9]+", name or "") if w]
    return ("".join(w[0] for w in words[:2]) or "P").upper()


def logo_html(brand: dict, mark_b64: str | None, mark_mime: str | None) -> str:
    """The company's own mark when it has one (Settings), otherwise a monogram in the theme's colours."""
    if mark_b64 and mark_mime in ("image/svg+xml", "image/png", "image/webp", "image/jpeg") and re.fullmatch(r"[A-Za-z0-9+/=\s]+", mark_b64):
        return f'<img alt="" src="data:{mark_mime};base64,{"".join(mark_b64.split())}">'
    ini = _html.escape(initials(brand.get("name", "")))
    return ('<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="var(--chip)"/>'
            f'<text x="32" y="41" text-anchor="middle" font-family="var(--font-display)" font-weight="800" font-size="26" fill="var(--chipfg)">{ini}</text></svg>')


def motif_svg(kind, w, h):
    c = "var(--motif)"
    if kind == "arcs":
        body = "".join(f'<circle cx="{w + 30}" cy="{h + 30}" r="{r}" fill="none" stroke="{c}" stroke-width="3"/>' for r in (210, 330, 450, 570))
    elif kind == "ecg":
        y, x = h * 0.9, w * 0.56
        pts = [(-20, y), (x, y), (x + 50, y + 60), (x + 104, y - 80), (x + 132, y), (w + 20, y)]
        body = '<path d="M' + " L".join(f"{a:.0f} {b:.0f}" for a, b in pts) + f'" fill="none" stroke="{c}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>'
    elif kind == "lens":
        body = "".join(f'<circle cx="{w * .94:.0f}" cy="{h * .06:.0f}" r="{r}" fill="none" stroke="{c}" stroke-width="2.5"/>' for r in (120, 210, 300, 390))
    elif kind == "roof":
        body = "".join(f'<path d="M{w - 330 + d} {150 + d} L{w - 190 + d} {40 + d} L{w - 50 + d} {150 + d}" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' for d in (0, 50, 100))
    else:
        return ""
    return f'<svg class="deco" data-deco aria-hidden="true" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{body}</svg>'


def theme_css(kit):
    return "\n".join(f".th-{name}{{" + ";".join(f"--{k}:{v}" for k, v in t.items()) + "}" for name, t in kit["themes"].items())


def render_job(job: dict, brand: dict, mark_b64: str | None = None, mark_mime: str | None = None) -> tuple[str, int, int, dict]:
    """(html, width, height, kit) for one creative."""
    kit = load_kit(brand)
    layout = job.get("layout") if job.get("layout") in LAYOUTS else "post-stat"
    size = job.get("size") if job.get("size") in SIZES else "portrait"
    theme = job.get("theme") if job.get("theme") in kit["themes"] else "dark"
    w, h = SIZES[size]
    slots = dict(job.get("slots") or {})
    ctx = {"brand_name": brand.get("name", ""), "byline": brand.get("byline", ""), "logo": logo_html(brand, mark_b64, mark_mime),
           "sign_name": brand.get("name", ""), "sign_role": brand.get("byline", ""), "w": w, "h": h}
    if (job.get("of") or 1) > 1:
        ctx["counter"] = f"{job['slide']:02d} / {job['of']:02d}"
        ctx["progress"] = [{"on": i + 1 == job["slide"]} for i in range(job["of"])]
        ctx["has_progress"] = True
    for k, v in slots.items():
        if k not in ctx or k in ("byline",):
            ctx[k] = v
    body = render((T / f"{layout}.html").read_text(encoding="utf-8"), [ctx])
    deco = motif_svg(kit.get("motif"), w, h)
    css = (T / "base.css").read_text(encoding="utf-8")
    root = (f":root{{--W:{w}px;--H:{h}px;--font-display:{kit['font_display']};--font-body:{kit['font_body']};"
            f"--font-mono:{kit['font_mono']};--b-page:{kit['themes'][theme]['bg']}}}")
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{_html.escape(str(job.get('id', 'creative')))}</title>
<style>@import url('{kit['fonts_css']}');
{css}
{root}
{theme_css(kit)}</style></head>
<body><div class="cv th-{theme} fmt-{size}">{deco}{body}</div>
<script>{FIT_JS}</script></body></html>
"""
    return page, w, h, kit


def copy_text(slots) -> list[str]:
    """Every piece of copy in the slots (for spelling and privacy checks)."""
    out: list[str] = []
    if isinstance(slots, str):
        out.append(slots)
    elif isinstance(slots, dict):
        for k, v in slots.items():
            if k not in ("title_size", "number_style", "quote_size", "color", "tick"):
                out += copy_text(v)
    elif isinstance(slots, list):
        for v in slots:
            out += copy_text(v)
    return out
