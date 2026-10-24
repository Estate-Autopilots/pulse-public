const focusableSelector = 'button, a, input, [tabindex]';

export function captureFocusTarget(root, activeElement) {
  if (!root || !activeElement || !root.contains(activeElement)) return null;
  if (activeElement.dataset?.viewHeading !== undefined) return { kind: 'heading' };

  for (const key of ['action', 'consent', 'focusKey']) {
    const value = activeElement.dataset?.[key];
    if (value) return { kind: 'data', key, value };
  }

  if (activeElement.id) return { kind: 'id', value: activeElement.id };
  for (const name of ['aria-label', 'href']) {
    const value = activeElement.getAttribute?.(name);
    if (value) return { kind: 'attribute', name, value, tagName: activeElement.tagName };
  }
  return null;
}

export function restoreFocusTarget(root, target) {
  if (!root || !target) return null;
  const nodes = Array.from(root.querySelectorAll(focusableSelector));
  const match = nodes.find((node) => {
    if (target.kind === 'heading') return node.dataset?.viewHeading !== undefined;
    if (target.kind === 'data') return node.dataset?.[target.key] === target.value;
    if (target.kind === 'id') return node.id === target.value;
    if (target.kind === 'attribute') {
      return node.tagName === target.tagName && node.getAttribute?.(target.name) === target.value;
    }
    return false;
  });
  const destination = match ?? root.querySelector('[data-view-heading]');
  destination?.focus({ preventScroll: true });
  return destination ?? null;
}
