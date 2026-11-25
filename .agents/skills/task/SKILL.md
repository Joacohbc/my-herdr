---
name: task
description: Structured start, plan, and finish workflow for features, bugfixes, and refactors in my-herdr.
---

# `task` — Lifecycle Workflow (`start | plan | finish`)

## `/task start`
1. Check `.docs/roadmap.md` for matching backlog/debt items or blocking open decisions.
2. Run `load-context` for the affected mod(s) or script(s).
3. For bugs: reproduce the exact symptom first (`herdr-app check`, `herdr-app status`, `*.error`, or `herdr-app shot`) before forming hypotheses.
4. Confirm scope: which mods, `shared` contracts, and `.docs/` files are affected.

## `/task plan`
1. Verify all GPUI/Herdr methods against `~/.config/herdr-app/gpui-kit.d.ts` and `herdr.d.ts` (never guess element methods like `.object_fit`).
2. Design respecting all invariants in `AGENTS.md` and `.docs/code-conventions.md` (render-phase safety, RAM bounds, hibernation, dirty protection, font inheritance, shell argument quoting).
3. Plan verification steps upfront (`herdr-app check`, reload mechanism, `herdr-app shot` if visual).
4. Record any non-obvious architectural trade-off as a new `Dn` entry in `.docs/architecture.md`.

## `/task finish`
1. Run `mod-verifier` (validates `herdr-app check` on all affected mods, symlink reload, `herdr-app status`, zero `*.error` files).
2. If UI changed, run `ui-reviewer` (`herdr-app shot` visual audit).
3. Run `code-reviewer` on `git diff` to verify GPUI safety, RAM/GC bounds, `hbc-code-design`, and doc impact.
4. Run `doc-editor` to update affected `.docs/` files, delete finished items from `.docs/roadmap.md`, and verify neutral Spanish.
5. Stage only intentional files (never `examples/`) and create atomic Conventional Commits explaining the *why*.
