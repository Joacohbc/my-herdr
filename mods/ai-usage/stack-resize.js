import { layout, run, settings } from "herdr";

export const STACK = ["agents", "system-monitor", "ports-monitor", "docker", "usage"];
export const MINS = { agents: 60, "system-monitor": 62, "ports-monitor": 64, docker: 64, usage: 64 };
export const SPACES_MIN = 90;
export const BRAND_PX = 46;
export const FOOTER_PX = 69;

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

// Height left for the STACK blocks once brand, footer and the elastic spaces block's
// minimum are taken. `window` from "herdr" shadows GPUI's, so reach the GPUI one globally.
export function availableStackPx() {
  const viewport = globalThis.window?.viewport_size?.();
  if (!viewport?.height) return null;
  const zoom = settings().zoom || 1;
  return viewport.height / zoom - BRAND_PX - FOOTER_PX - SPACES_MIN;
}

// Shrinks blocks bottom-up (keepId last) toward their minimums until the stack fits.
export function fitHeights(heights, available, keepId) {
  const next = { ...heights };
  let excess = STACK.reduce((sum, id) => sum + next[id], 0) - available;
  const order = [...STACK].reverse().filter(id => id !== keepId);
  if (keepId) order.push(keepId);
  for (const id of order) {
    if (excess <= 0) break;
    const take = Math.min(excess, Math.max(0, next[id] - MINS[id]));
    next[id] = Math.round(next[id] - take);
    excess -= take;
  }
  return next;
}

// Resizes `ownId` to `px` (when given) and squeezes the rest so no block falls off the window.
export function fitStackToViewport(ownId = null, px = null) {
  const tree = layout();
  const heights = snapshotHeights(tree, ownId, px ?? 0);
  if (ownId && px !== null) heights[ownId] = px;
  const available = availableStackPx();
  const next = available === null ? heights : fitHeights(heights, available, ownId);
  for (const id of STACK) {
    const current = findNode(tree, id)?.size?.px;
    if (next[id] !== current) run("layout.resize", { id, px: next[id] });
  }
}
