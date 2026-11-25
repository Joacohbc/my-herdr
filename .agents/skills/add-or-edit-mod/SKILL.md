---
name: add-or-edit-mod
description: Step-by-step protocol for cloning, creating, or modifying any GPUI JavaScript mod in my-herdr while enforcing GPUI safety, RAM bounds, font inheritance, and symlink hot-reload.
---

# `add-or-edit-mod` — Mod Engineering Protocol

## 1. Entry Architectural Rule
- **Never edit shipped Herdr mods or `main.json`.** To customize a shipped mod, clone it first (`herdr-app do mod.clone '{"name":"<src>","as":"<name>"}'`), move it into `mods/<name>/`, strip generated `gpui-kit.d.ts`/`jsconfig.json`, symlink it via `install.sh`, and update `layouts/my-herdr.json`.
- **No cross-mod JS imports:** Herdr's sandbox rejects JS imports resolving outside a mod's own folder (assets via `image("mods/<other>/...")` are allowed).

## 2. Mandatory GPUI & Runtime Contracts
1. **Props reading:** always read `const p = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();`.
2. **Check guard:** put `if (checking()) return;` before starting timers, watchers, `exec`, `hc`, or `writeTextFile`.
3. **Render-phase purity:**
   - Never call `cx.notify()` synchronously inside helpers invoked from `render()` (pass `fromRender = true`).
   - Never call `EditorState.new(...)` or `InputState.new(...)` inside `render()`; create in `init()`, event handlers, or `cx.spawn(async cx => { await cx.sleep(0); ... })`.
4. **Styling & layout safety:**
   - Apply `.when(Boolean(fontFamily), el => el.font_family(fontFamily))` at the root using `settings().font_family ?? settings().font`.
   - Use only `theme()` tokens (never `"transparent"` in `.bg(...)`).
   - Give every `.overflow_x_scrollbar()` container inside a `v_flex()` an explicit height (`.h(n).flex_none()`).
   - Never use `.object_fit(...)` on `image(...)`; use proportional `.w(w).h(h)`.
   - Keep hover action buttons mounted with reduced opacity instead of conditionally mounting them (prevents layout shift).
5. **Cleanup in `close()`:** release every `EditorState` and `InputState`, cancel `watchFolder`, delete temp files in `data/fv-preview/`, and clear caches (`releaseIconCache()`).
6. **Shell safety:** pass user input and paths as positional arguments (`"$1"`) with `--`, never interpolated into shell strings.

## 3. Verification Matrix
1. `herdr-app check ~/.config/herdr-app/mods/<mod>` must pass.
2. Trigger live reload:
   - Layout-owned mod: `herdr-app do layout.switch '{"name":"main"}' && herdr-app do layout.switch '{"name":"my-herdr"}'`.
   - Open tab-owned mod (`file-viewer` / standalone `changes-history`): `touch -h ~/.config/herdr-app/mods/<mod> && touch /home/joaco/projects/my-herdr/mods/<mod>/main.js`.
3. Verify `herdr-app status` (`"layout": "my-herdr"`, `"errors": []`) and no `~/.config/herdr-app/*.error`.
4. For visual changes, capture and inspect `herdr-app shot /tmp/herdr-verify.png`.

## 4. Documentation Impact
- Update `.docs/mods-catalog.md` (and `.docs/architecture.md` if a `shared` contract or `Dn` decision changed).
