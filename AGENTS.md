# AGENTS.md — `my-herdr`

Personal customization repository for **Herdr App** (`herdr-app`, native Rust/GPUI terminal & AI agent workspace) and `herdr-core` (`hc`), symlinked into `~/.config/herdr-app/`. Includes a custom layout (`my-herdr`), 10 GPUI JavaScript mods (`files-search`, `file-viewer`, `changes-history`, `pane-custom`, `tabs-custom`, `system-monitor`, `ports-monitor`, `agents-custom`, `web-launcher`, `command-palette`), configurable terminal command aliases (`command-aliases.json`), Material Icon compaction, keyboard bindings, and automatic RAM/GC management.

This file holds the rules an agent must follow. Detailed documentation lives in `.docs/` (Spanish) and the domain vocabulary in `.docs/context.md`.

## Where to look

| Need | Read |
| --- | --- |
| Layout tree, `shared` contracts, RAM/GC lifecycle, decisions D1–D12 | `.docs/architecture.md` |
| Every custom mod, interactions, limits, scripts | `.docs/mods-catalog.md` |
| Domain vocabulary (ubiquitous language) | `.docs/context.md` |
| GPUI runtime restrictions, `hbc-code-design`, language rules | `.docs/code-conventions.md` |
| Validation (`herdr-app check`), symlink reload, visual verification | `.docs/testing.md` |
| Pending work, open decisions, technical debt | `.docs/roadmap.md` (the single task list) |

## Commands

```bash
# Link layout + all 9 mods, sync keys.json, and validate all mods
./install.sh

# Validate every custom mod
for mod in files-search file-viewer pane-custom system-monitor ports-monitor agents-custom changes-history tabs-custom web-launcher command-palette; do
  herdr-app check ~/.config/herdr-app/mods/$mod || exit 1
done

# Force live reload of layout-owned mods (symlinked)
herdr-app do layout.switch '{"name":"main"}' && herdr-app do layout.switch '{"name":"my-herdr"}'

# Force live reload of open tab-owned mods (e.g. file-viewer)
touch -h ~/.config/herdr-app/mods/file-viewer && touch /home/joaco/projects/my-herdr/mods/file-viewer/main.js

# Verify live status, zero errors, and capture visual screenshot
herdr-app status && ls ~/.config/herdr-app/*.error 2>/dev/null || true
herdr-app shot /tmp/herdr-verify.png

# Sync arrow/tab shortcuts or rebuild compact Material Icons
node scripts/apply-keys.js
node scripts/build-icons.js
```

## Architecture in five lines

- `layouts/my-herdr.json` and `mods/*` are symlinked into `~/.config/herdr-app/`; shipped Herdr files are never touched.
- Mods run in isolated GPUI JS sandboxes and communicate solely via `shared()`/`setShared()` (`file-viewer.{open,meta,cmd}`, `changes.badge`, `herdr.gc`) and `run()`.
- Right-side panels (`files-search`, `changes-history`) cancel `watchFolder` on hide and evict caches/icon maps after 30 s; background viewer/diff tabs hibernate after 45 s unless dirty (`*`).
- `system-monitor` attributes deep `pid`/`ppid` process trees, purges finished `herdr-core` terminals (`hc rm`) every 60 s, and broadcasts `herdr.gc` under high RAM (`>= 75%`) or on manual `GC`.
- `file-viewer` supports Markdown, hi-res 1024 px SVG/image staging (`data/fv-preview/`), Excel-style editable CSV/TSV with `@Col:val` autocomplete, lazy single-page PDFs, and editable Raw/Code mode (`Ctrl+S`).

## MUST (Domain & Architectural Invariants)

- **Clones only**: customize via `layouts/my-herdr.json` and custom mods (`mod.clone`), keeping `install.sh` in sync.
- **GPUI safety**: guard side effects with `checking()`, read props via `(initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props()`, apply `settings().font_family ?? settings().font` at each mod root, and release `EditorState`, `InputState`, `watchFolder`, temp files, and icon caches in `close()`.
- **No render-phase mutations**: never call `cx.notify()` synchronously or `EditorState.new(...)` during `render()`; defer via `cx.spawn(async cx => { await cx.sleep(0); ... })`.
- **Bounded RAM & dirty safety**: every cache/history must have an explicit upper bound and eviction policy; never hibernate a tab while `isDirty()` is true; require explicit confirmation before destructive git actions (`Discard`, `Delete untracked`, `Drop stash`).
- **Validation**: every mod edit must pass `herdr-app check`, live reload (`layout.switch` or `touch -h`), and `herdr-app status` (`"errors": []`); visual UI changes must also be inspected via `herdr-app shot`.
- **Docs**: update the owning `.docs/` file and `.docs/context.md` in the same commit; delete completed items from `.docs/roadmap.md`.

## NEVER

- Never edit shipped Herdr layouts/mods (`main.json`, `files`, `pane`, `tabs`, `changes`, `spaces`, `agents`) or generated files (`~/.config/herdr-app/{AGENTS.md,gpui-kit.d.ts,herdr.d.ts}`).
- Never use DOM/HTML/CSS/`setTimeout`/`setInterval`, `"transparent"` in `.bg(...)`, `.object_fit(...)` on `image(...)`, or `.overflow_x_scrollbar()` without an explicit height inside a `v_flex()`.
- Never interpolate user queries or file paths into shell scripts (always pass as positional `"$1"` with `--`).
- Never retain `cx` outside the current callback, import `.js` files across mod directories, or commit local `examples/` test files.

## Languages

- Code, identifiers, logs, commits, `AGENTS.md`, skills, subagents: **English**.
- `.docs/*.md`, `README.md`, user conversation: **Spanish** (standard neutral Spanish; no regionalisms or voseo).
- Commits follow Conventional Commits (`feat`, `fix`, `refactor`, `style`, `docs`, `chore`) and explain the *why*.

## Skills (`.agents/skills/`)

| Skill | Use when |
| --- | --- |
| `load-context` | Starting any task to load only the relevant `.docs/` sections, `Dn` decisions, and action skills |
| `task` | Running the `start` → `plan` → `finish` workflow on a feature, bugfix, or refactor |
| `add-or-edit-mod` | Cloning, creating, or modifying any GPUI mod in `mods/` |
| `ram-and-gc-audit` | Adding caches, background timers, previews, or auditing RAM/hibernation/GC behavior |
| `sync-keys-and-icons` | Changing keybindings (`keys.json`/palette) or regenerating/compacting Material Icons |

## Subagents (`.agents/agents/`)

| Agent | Use when |
| --- | --- |
| `mod-verifier` | Running `herdr-app check`, symlink/status checks, and `herdr-core` finished-terminal checks |
| `code-reviewer` | Reviewing `git diff` against GPUI invariants, RAM bounds, `hbc-code-design`, and doc impact |
| `ui-reviewer` | Capturing `herdr-app shot` and auditing visual layout, SVG crispness, contrast, and layout shift |
| `doc-editor` | Updating `.docs/`, `AGENTS.md`, `Dn` decisions, and pruning `.docs/roadmap.md` |

## Workflow

`/task start` → `/task plan` → implement → `/task finish`.
