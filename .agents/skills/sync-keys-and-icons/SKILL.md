---
name: sync-keys-and-icons
description: Safely update keyboard shortcuts (keys.json + command palette) and regenerate or compact Material Icon Theme tables in my-herdr.
---

# `sync-keys-and-icons` — Keybindings & Material Icons Protocol

## 1. Keybindings (`scripts/apply-keys.js` + `pane-custom/mod.json`)
- **Palette consistency rule:** Herdr's Command Palette (`Ctrl+Shift+P`) displays bindings from `"global"`. Any custom shortcut (`alt-{left,down,up,right}`, `alt-shift-{left,down,up,right}`, `ctrl-t`, `ctrl-w`, `ctrl-shift-t`) MUST be synced across `"global"`, `"layout:my-herdr"`, and `"terminal"`, and legacy conflicting bindings (`alt-{h,j,k,l}`, `ctrl-shift-w`) must be deleted from `"global"`.
- Custom `<mod>.<command>` actions intended for `Ctrl+Shift+P` must also be declared in `mods/<mod>/mod.json` under `"palette"`.
- Apply and verify:
  ```bash
  node /home/joaco/projects/my-herdr/scripts/apply-keys.js
  ls ~/.config/herdr-app/*.error 2>/dev/null || true
  ```

## 2. Material Icon Theme (`scripts/build-icons.js`)
- `mods/files-search/material-icons.js` stores packed inverted tables (files + extensions + deduplicated folders) parsed lazily into `Map`s (never plain `{}` objects, avoiding `__proto__` collisions) with `releaseIconCache()`.
- `mods/changes-history/material-icons.js` is generated without folder tables to minimize heap footprint.
- When updating from `~/.vscode/extensions/pkief.material-icon-theme-*`:
  1. Copy `icons/*.svg` into `mods/files-search/micons/`.
  2. Regenerate/compact via `node scripts/build-icons.js`.
  3. Verify 100% equivalence across all entries and `releaseIconCache()` recovery, then run `herdr-app check` on both `files-search` and `changes-history`.
