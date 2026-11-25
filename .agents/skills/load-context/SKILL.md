---
name: load-context
description: Selectively load only the .docs/ sections, glossary terms, Dn decisions, and action skills relevant to the area being modified in my-herdr.
---

# `load-context` — Selective Context Loader

Use this map before editing or reviewing any area of `my-herdr`. Read only the rows matching the files you will touch.

## Area → Read Map

| Area (files / mods) | Read in `.docs/` | Key Decisions | Action Skill |
| --- | --- | --- | --- |
| `mods/files-search/*` | `mods-catalog.md §1.1`, `architecture.md §2–§3`, `code-conventions.md` | `D1, D3, D11` | `add-or-edit-mod`, `ram-and-gc-audit` |
| `mods/file-viewer/*` | `mods-catalog.md §1.2`, `architecture.md §2–§3`, `code-conventions.md` | `D4, D5, D6, D7, D8, D9, D11, D12` | `add-or-edit-mod`, `ram-and-gc-audit` |
| `mods/changes-history/*` | `mods-catalog.md §1.3`, `architecture.md §2–§3`, `code-conventions.md` | `D3, D10, D11, D12` | `add-or-edit-mod`, `ram-and-gc-audit` |
| `mods/pane-custom/*` | `mods-catalog.md §1.4`, `architecture.md §2`, `code-conventions.md` | `D2, D4, D9, D11` | `add-or-edit-mod`, `sync-keys-and-icons` |
| `mods/tabs-custom/*` | `mods-catalog.md §1.5`, `architecture.md §2`, `code-conventions.md` | `D1, D11` | `add-or-edit-mod` |
| `mods/system-monitor/*` | `mods-catalog.md §1.6`, `architecture.md §3`, `code-conventions.md` | `D11, D12` | `add-or-edit-mod`, `ram-and-gc-audit` |
| `layouts/my-herdr.json`, `install.sh` | `architecture.md §1`, `mods-catalog.md §2`, `testing.md` | `D1` | `add-or-edit-mod` |
| `scripts/apply-keys.js`, `keys.json` | `mods-catalog.md §2`, `architecture.md §4 (D2)` | `D2` | `sync-keys-and-icons` |
| `scripts/build-icons.js`, `material-icons.js`, `micons/` | `mods-catalog.md §1.1, §2`, `architecture.md §4 (D3)`, `testing.md §4` | `D3` | `sync-keys-and-icons` |

## Always Check

1. `.docs/context.md` for canonical terms (`herdr.gc`, `solo`, `dirty`, `evictCaches`, etc.).
2. `.docs/roadmap.md` to verify whether the task resolves an open backlog item or technical debt entry (which must be deleted in the same commit).
3. `~/.config/herdr-app/herdr.d.ts` and `gpui-kit.d.ts` whenever calling a GPUI or Herdr API not already used in the target mod.
