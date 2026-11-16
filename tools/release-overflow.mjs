// v0.3.66: what sticks out past the window's right edge, for the release browser checks. Layout facts only: tag, CSS
// class names that are plain identifiers, whether it has an accessible name, position, right edge and width. Never text,
// labels or other attribute values (Pip's label carries notification titles: QA review on EST-1197).
export async function overflowOf(page) {
  return page.evaluate(() => {
    const iw = innerWidth, sw = document.documentElement.scrollWidth;
    if (sw <= iw + 2) return null;
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.right <= iw + 2 || !b.width) continue;
      const cls = String(el.className?.baseVal ?? el.className).split(/\s+/).filter((c) => /^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(c)).slice(0, 4).join(' ');
      wide.push({ tag: el.tagName.toLowerCase(), cls, named: el.hasAttribute('aria-label'), position: getComputedStyle(el).position, right: Math.round(b.right), width: Math.round(b.width) });
    }
    return { scrollWidth: sw, innerWidth: iw, wide: wide.slice(0, 20) };
  });
}
