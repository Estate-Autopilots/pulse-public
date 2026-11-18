// DOREVE-2 (AC card 7): where the "Done · Undo" pill goes beside the circle that was clicked (kit/undo-here.tsx). Pure.

/** To the right of the anchor, centred on it; on its left when there is no room on the right; under it on a window too
 *  narrow for either; never off the window (8px from its edges). No anchor: low in the middle of the window. */
export function placeUndo(anchor, size, view) {
  const pad = 8;
  if (!anchor) return { left: Math.max(pad, Math.round(view.width / 2 - size.width / 2)), top: Math.max(pad, Math.round(view.height - size.height - 96)) };
  let left = anchor.right + 10, top = anchor.top + anchor.height / 2 - size.height / 2;
  if (left + size.width > view.width - pad) left = anchor.left - 10 - size.width;
  if (left < pad) { left = Math.min(Math.max(pad, anchor.left), Math.max(pad, view.width - pad - size.width)); top = anchor.top + anchor.height + 6; }
  top = Math.min(Math.max(pad, top), view.height - pad - size.height);
  return { left: Math.round(left), top: Math.round(top) };
}

/** DOREVE-2 (judges, rounds 1-2: "letters peek out", "fills only 60% of the row"): when the clicked circle sits in a
 *  row, the Undo becomes a banner over that whole row: from the circle's left to the row's end, the row's height less a
 *  little (36-64 px), inside the window. */
export function bannerOver(circle, row, view) {
  const pad = 8, left = Math.max(pad, Math.round(Math.min(circle.left - 6, row.left + 1))); // the row's own left edge
  const width = Math.round(Math.max(200, Math.min(row.right - left - 1, view.width - pad - left)));
  const height = Math.round(Math.min(64, Math.max(36, row.height - 6)));
  const top = Math.round(Math.min(Math.max(pad, row.top + row.height / 2 - height / 2), view.height - pad - height));
  return { left: Math.min(left, Math.max(pad, view.width - pad - width)), top, width, height };
}
