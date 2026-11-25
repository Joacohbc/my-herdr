export const STACK = ["agents", "system-monitor", "ports-monitor"];
export const MINS = { agents: 60, "system-monitor": 62, "ports-monitor": 64 };
export const SPACES_MIN = 90;
export const BRAND_PX = 46;

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export function snapshotHeights(tree, ownId, ownHeight) {
  const out = {};
  for (const id of STACK) {
    const px = findNode(tree, id)?.size?.px;
    out[id] = typeof px === "number" ? px : (id === ownId ? ownHeight : MINS[id] * 2);
  }
  return out;
}

// spacesH: current height of the elastic spaces block.
export function pushResize({ heights, spacesH, targetId, dy }) {
  const next = { ...heights };
  const idx = STACK.indexOf(targetId);
  let spaces = spacesH;
  if (dy < 0) {
    let want = -dy;
    const fromSpaces = Math.min(want, Math.max(0, spaces - SPACES_MIN));
    spaces -= fromSpaces;
    next[targetId] += fromSpaces;
    want -= fromSpaces;
    for (let i = idx - 1; i >= 0 && want > 0; i--) {
      const id = STACK[i];
      const take = Math.min(want, Math.max(0, next[id] - MINS[id]));
      next[id] -= take;
      next[targetId] += take;
      want -= take;
    }
  } else if (dy > 0) {
    let want = dy;
    const own = Math.min(want, Math.max(0, next[targetId] - MINS[targetId]));
    next[targetId] -= own;
    spaces += own;
    want -= own;
    for (let i = idx + 1; i < STACK.length && want > 0; i++) {
      const id = STACK[i];
      const take = Math.min(want, Math.max(0, next[id] - MINS[id]));
      next[id] -= take;
      spaces += take;
      want -= take;
    }
  }
  for (const id of STACK) next[id] = Math.round(next[id]);
  return next;
}
