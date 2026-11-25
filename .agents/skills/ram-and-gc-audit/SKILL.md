---
name: ram-and-gc-audit
description: Enforce RAM budgets, panel visibility pausing, background tab hibernation, bounded caches, and herdr.gc participation across all my-herdr mods.
---

# `ram-and-gc-audit` — Memory & Automatic Cleanup Protocol

## 1. Entry Rule
Every mod copy stays alive in memory while its block or tab exists in the layout, even when hidden or in a background tab. Unbounded state, active watchers on hidden panels, or duplicate text buffers are treated as bugs.

## 2. Mandatory Memory Contracts
1. **Visibility gating (side panels):**
   - Check `window()?.visible !== false`, `!findLayoutNode(layout(), "panel")?.hidden`, and `panel-body.active === "<id>"`.
   - Cancel `watchFolder` immediately when hidden and pause fast polling.
   - Evict caches (`entries`, `marks`, `commits`, `rows`, `scans`, `releaseIconCache()`) after `30 s` hidden or immediately on `shared("herdr.gc")` bump.
2. **Background tab hibernation (tab panes):**
   - Track `hiddenSince` on `15 s` timer; hibernate after `45 s` in background tab (or immediately on `herdr.gc`).
   - **Dirty invariant:** NEVER hibernate while `isDirty()` (`codeDirty || csvDirty`) is true.
   - On hibernate: release `EditorState`, drop text/CSV/diff arrays, remove staged files in `data/fv-preview/`, and restore transparently when `isPaneVisible()` returns true.
3. **Single-buffer & bounded collections:**
   - Never hold `rawText` and `EditorState` simultaneously for plain code files (use `Uint32Array` line starts).
   - Cap every `Map`/`Set`/history array (`MAX_OPEN_FOLDERS = 24`, `MAX_SAVED_CONTEXTS = 8`, `MAX_SCANS = 4`, `MAX_CLOSED_HISTORY = 8`, `MAX_UNIQUE_SUGGESTIONS = 200`, `CSV_PAGE_SIZE = 200`, `MAX_FILE_CHARS = 250_000`).
   - Truncate `ps` command lines in `awk` before IPC (`system-monitor`).
4. **Core terminal GC (`system-monitor`):**
   - Periodically (`60 s`) purge `state === "finished"` terminals via `hc ls --all --json` → `hc rm <addr>`.
   - Prune orphaned `file-viewer.meta` keys and emit `herdr.gc` when `memPct >= 75%` or on manual `GC`.

## 3. Verification
- Check `herdr-app check` on touched mods.
- Confirm `hc ls --all --json` reports `finished: 0` after auto-GC.
- Confirm `~/.config/herdr-app/data/fv-preview/` does not retain closed/hibernated previews.
