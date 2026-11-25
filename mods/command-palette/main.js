import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import {
  props,
  theme,
  settings,
  shared,
  run,
  closeOverlay,
  checking,
  notify,
} from "herdr";
import {
  getActiveLocation,
  loadAliases,
  saveAliases,
  createFsEntry,
  openInTerminalEditor,
  openInFileViewer,
  runCommandInTerminal,
  openAliasesInViewer,
  buildCommandList,
} from "./actions.js";

const ROW_HEIGHT = 42;
const MAX_VISIBLE_ROWS = 50;

function matchesQuery(item, q) {
  if (!q) return true;
  const hay = `${item.group || ""} ${item.title || ""} ${item.subtitle || ""} ${item.words || ""} ${item.name || ""} ${item.command || ""}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
}

export default class CommandPalette extends View {
  init(initialProps, cx) {
    const p = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();
    this.overlayId = p?.overlay ?? null;
    this.handle = cx.focus_handle();

    const loc = getActiveLocation();
    this.root = p?.root || loc.cwd || "";
    this.on = p?.on !== undefined ? p.on : loc.on;
    this.baseDir = p?.baseDir || "";
    this.mode = p?.mode === "runner" ? "palette" : (p?.mode || "palette");
    this.runnerActive = p?.mode === "runner";

    this.query = "";
    this.selected = 0;
    this.runnerPlace = "tab";
    this.runnerKeepOpen = true;
    this.aliases = [];
    this.aliasesRaw = null;
    this.aliasesError = null;
    this.commands = buildCommandList();

    this.fsPath = "";
    this.fsError = null;
    this.fsBusy = false;

    this.aliasName = "";
    this.aliasCmd = "";
    this.aliasDesc = "";
    this.aliasPlace = "tab";
    this.aliasKeepOpen = true;
    this.aliasFormError = null;

    this.searchInput = InputState.new({
      placeholder: "Type a command or > to run in terminal…",
      value: this.query,
    });
    this.searchInput.on("change", (_e, cx) => {
      const val = this.searchInput.value();
      if (!this.runnerActive && val.startsWith(">")) {
        const rest = val.slice(1).trimStart();
        this.runnerActive = true;
        this.query = rest;
        this.selected = 0;
        this.searchInput.set_value(rest);
        cx.notify();
        return;
      }
      this.query = val;
      this.selected = 0;
      cx.notify();
    });
    this.searchInput.on("submit", (_e, cx) => this.executeSelected(false, cx));

    this.fsInput = InputState.new({
      placeholder: this.mode === "create-folder" ? "e.g. src/components" : "e.g. src/notes.md",
      value: "",
    });
    this.fsInput.on("change", (_e, cx) => {
      this.fsPath = this.fsInput.value();
      this.fsError = null;
      cx.notify();
    });
    this.fsInput.on("submit", (_e, cx) => this.submitFs(this.mode === "quick-edit", "tab", cx));

    this.aliasNameInput = InputState.new({ placeholder: "Alias name (e.g. logs)" });
    this.aliasNameInput.on("change", (_e, cx) => {
      this.aliasName = this.aliasNameInput.value();
      this.aliasFormError = null;
      cx.notify();
    });

    this.aliasCmdInput = InputState.new({ placeholder: "Shell command (e.g. docker compose logs -f)" });
    this.aliasCmdInput.on("change", (_e, cx) => {
      this.aliasCmd = this.aliasCmdInput.value();
      this.aliasFormError = null;
      cx.notify();
    });

    this.aliasDescInput = InputState.new({ placeholder: "Description (optional)" });
    this.aliasDescInput.on("change", (_e, cx) => {
      this.aliasDesc = this.aliasDescInput.value();
      cx.notify();
    });

    if (checking()) return;

    this.focusActiveInput();
    cx.timer.after(120, () => this.focusActiveInput());

    cx.spawn(async cx => {
      const res = await loadAliases();
      this.aliases = res.aliases;
      this.aliasesRaw = res.raw;
      this.aliasesError = res.error;
      cx.notify();
    });
  }

  close() {
    for (const input of [this.searchInput, this.fsInput, this.aliasNameInput, this.aliasCmdInput, this.aliasDescInput]) {
      if (input) {
        try { input.release(); } catch {}
      }
    }
    this.searchInput = null;
    this.fsInput = null;
    this.aliasNameInput = null;
    this.aliasCmdInput = null;
    this.aliasDescInput = null;
  }

  dismiss() {
    if (this.overlayId) closeOverlay(this.overlayId);
  }

  focusActiveInput() {
    if (this.mode === "create-file" || this.mode === "create-folder" || this.mode === "quick-edit") {
      this.fsInput?.focus();
      return;
    }
    if (this.mode === "add-alias") {
      this.aliasNameInput?.focus();
      return;
    }
    this.searchInput?.focus();
  }

  isRunnerQuery() {
    return this.mode === "palette" && this.runnerActive;
  }

  runnerRawText() {
    return this.query.trim();
  }

  visibleItems() {
    if (this.isRunnerQuery()) {
      const raw = this.runnerRawText();
      const lower = raw.toLowerCase();
      const out = [];

      for (const alias of this.aliases) {
        if (!lower || matchesQuery(alias, lower)) {
          out.push({
            id: `alias:${alias.name}`,
            kind: "alias",
            group: "Alias",
            title: alias.name,
            subtitle: alias.description ? `${alias.description}  ·  ${alias.command}` : alias.command,
            shortcut: alias.place === "tab" ? "Tab" : `Split ${alias.place}`,
            alias,
          });
        }
      }

      if (raw) {
        const exactAlias = this.aliases.find(a => a.name.toLowerCase() === lower);
        if (!exactAlias) {
          out.unshift({
            id: `exec:${raw}`,
            kind: "exec",
            group: "Run",
            title: raw,
            subtitle: `Run in ${this.runnerPlace === "tab" ? "new tab" : `split ${this.runnerPlace}`}${this.runnerKeepOpen ? " (keep shell open)" : ""}`,
            shortcut: "Enter",
            command: raw,
          });
        }
      } else {
        const recent = Array.isArray(shared("command-palette.recent")) ? shared("command-palette.recent") : [];
        for (const cmd of recent) {
          if (this.aliases.some(a => a.command === cmd)) continue;
          out.push({
            id: `recent:${cmd}`,
            kind: "exec",
            group: "Recent",
            title: cmd,
            subtitle: "Run recent command in terminal",
            shortcut: "",
            command: cmd,
          });
        }
      }

      return out.slice(0, MAX_VISIBLE_ROWS);
    }

    const q = this.query.trim().toLowerCase();
    return this.commands.filter(c => matchesQuery(c, q)).slice(0, MAX_VISIBLE_ROWS);
  }

  switchMode(mode, cx) {
    this.mode = mode;
    this.fsError = null;
    this.aliasFormError = null;
    if (mode === "create-file" || mode === "create-folder" || mode === "quick-edit") {
      this.fsPath = "";
      this.fsInput?.set_value("");
    }
    this.focusActiveInput();
    cx.notify();
  }

  enterRunnerMode(cx) {
    this.mode = "palette";
    this.runnerActive = true;
    this.query = "";
    this.searchInput?.set_value("");
    this.selected = 0;
    this.focusActiveInput();
    cx.notify();
  }

  exitRunnerMode(cx) {
    this.runnerActive = false;
    this.selected = 0;
    this.focusActiveInput();
    cx.notify();
  }

  executeItem(item, forceSplitRight, cx) {
    if (!item) return;

    if (item.kind === "alias") {
      const place = forceSplitRight ? "right" : item.alias.place;
      this.dismiss();
      runCommandInTerminal({
        command: item.alias.command,
        folder: this.root,
        place,
        name: item.alias.name,
        keepOpen: item.alias.keepOpen,
      });
      return;
    }

    if (item.kind === "exec") {
      const place = forceSplitRight ? "right" : this.runnerPlace;
      this.dismiss();
      runCommandInTerminal({
        command: item.command,
        folder: this.root,
        place,
        keepOpen: this.runnerKeepOpen,
      });
      return;
    }

    const act = item.action;
    if (!act) return;
    if (act.kind === "switch-mode") {
      this.switchMode(act.mode, cx);
      return;
    }
    if (act.kind === "enter-runner") {
      this.enterRunnerMode(cx);
      return;
    }
    if (act.kind === "edit-aliases") {
      this.dismiss();
      openAliasesInViewer();
      return;
    }
    if (act.kind === "mod.open") {
      this.dismiss();
      run("mod.open", { name: act.name });
      return;
    }
    if (act.kind === "run") {
      this.dismiss();
      run(act.command, act.args);
    }
  }

  executeSelected(forceSplitRight, cx) {
    const items = this.visibleItems();
    const item = items[Math.min(this.selected, Math.max(0, items.length - 1))];
    this.executeItem(item, forceSplitRight, cx);
  }

  submitFs(openInTerminal, place, cx) {
    if (this.fsBusy) return;
    const isDir = this.mode === "create-folder";
    const allowExisting = this.mode === "quick-edit";
    const rawPath = this.fsInput?.value() ?? this.fsPath;

    this.fsBusy = true;
    this.fsError = null;
    cx.notify();

    cx.spawn(async cx => {
      try {
        const res = await createFsEntry({
          root: this.root,
          on: this.on,
          baseDir: this.baseDir,
          rawPath,
          isDir,
          allowExisting,
        });
        if (!res.ok) {
          this.fsError = res.error;
          this.fsBusy = false;
          cx.notify();
          return;
        }

        if (isDir) {
          notify({ title: "Folder created", body: res.relPath, timeout: 2000 });
          this.dismiss();
          return;
        }

        if (openInTerminal) {
          const editor = await openInTerminalEditor({
            absPath: res.absPath,
            folder: this.root,
            on: this.on,
            place,
            name: res.name,
          });
          notify({ title: `Opened in ${editor}`, body: res.relPath, timeout: 1800 });
          this.dismiss();
          return;
        }

        openInFileViewer({ relPath: res.relPath, root: this.root, on: this.on, name: res.name });
        notify({ title: "File created", body: res.relPath, timeout: 2000 });
        this.dismiss();
      } catch (e) {
        this.fsError = String(e.message || e);
        this.fsBusy = false;
        cx.notify();
      }
    });
  }

  submitNewAlias(cx) {
    const name = (this.aliasNameInput?.value() ?? this.aliasName).trim();
    const command = (this.aliasCmdInput?.value() ?? this.aliasCmd).trim();
    const description = (this.aliasDescInput?.value() ?? this.aliasDesc).trim();

    if (!name || !command) {
      this.aliasFormError = "Alias name and command are required.";
      cx.notify();
      return;
    }

    cx.spawn(async cx => {
      try {
        const fresh = await loadAliases();
        const filtered = fresh.aliases.filter(a => a.name !== name);
        const nextList = [
          ...filtered,
          { name, command, description, place: this.aliasPlace, keepOpen: this.aliasKeepOpen },
        ];
        const saved = await saveAliases(nextList, fresh.raw);
        this.aliases = saved.aliases;
        this.aliasesRaw = saved.raw;
        this.aliasesError = null;
        this.aliasName = "";
        this.aliasCmd = "";
        this.aliasDesc = "";
        this.aliasNameInput?.set_value("");
        this.aliasCmdInput?.set_value("");
        this.aliasDescInput?.set_value("");
        notify({ title: "Alias saved", body: `${name} → ${command}`, timeout: 2200 });
        this.enterRunnerMode(cx);
      } catch (e) {
        this.aliasFormError = String(e.message || e);
        cx.notify();
      }
    });
  }

  chip(id, label, active, onClick, t) {
    return div()
      .id(id)
      .px(7)
      .py(2)
      .rounded(5)
      .text_size(11)
      .font_medium()
      .cursor_pointer()
      .border_1()
      .border_color(active ? t.accent : t.border)
      .when(active, el => el.bg(t.selected))
      .when(!active, el => el.bg(t.surface))
      .text_color(active ? t.accent : t.muted)
      .hover(s => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
      .on_click(onClick)
      .child(label);
  }

  renderFsModal(t, fontFamily) {
    const isFolder = this.mode === "create-folder";
    const isQuickEdit = this.mode === "quick-edit";
    const title = isFolder
      ? "Create Folder"
      : isQuickEdit
        ? "Quick Edit in Terminal (micro / nano)"
        : "Create File";
    const targetDisplay = this.root
      ? (this.baseDir ? `${this.root}/${this.baseDir}` : this.root)
      : "No active folder";

    return v_flex()
      .id("cp-fs-modal")
      .w_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.dismiss();
        }
      })
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(14).font_semibold().child(title))
          .child(
            div()
              .id("cp-fs-back")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.dismiss())
              .child("Esc"),
          ),
      )
      .child(
        v_flex()
          .gap(4)
          .child(div().text_size(11).text_color(t.dim).child(`Base folder${this.on ? ` (${this.on})` : ""}`))
          .child(div().text_size(11.5).text_color(t.muted).truncate().child(targetDisplay)),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .items_center()
          .rounded(7)
          .bg(t.background)
          .border_1()
          .border_color(this.fsError ? t.ansi1 : t.accent)
          .child(Input.new(this.fsInput).flex_1().h_full().text_size(13).text_color(t.foreground)),
      )
      .when(Boolean(this.fsError), el => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.fsError)))
      .child(div().text_size(11).text_color(t.dim).child("Nested paths like src/utils/file.js create parent folders automatically."))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .justify_end()
          .child(
            h_flex()
              .id("cp-fs-cancel")
              .h(32)
              .px(12)
              .items_center()
              .rounded(6)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_size(12)
              .text_color(t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.dismiss())
              .child("Cancel"),
          )
          .when(!isFolder && !isQuickEdit, el =>
            el.child(
              h_flex()
                .id("cp-fs-micro")
                .h(32)
                .px(12)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .text_size(12)
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => this.submitFs(true, "tab", cx))
                .child("Create & Edit (micro/nano)"),
            ),
          )
          .when(isQuickEdit, el =>
            el.child(
              h_flex()
                .id("cp-fs-micro-split")
                .h(32)
                .px(12)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .text_size(12)
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => this.submitFs(true, "right", cx))
                .child("Split →"),
            ),
          )
          .child(
            h_flex()
              .id("cp-fs-submit")
              .h(32)
              .px(14)
              .items_center()
              .rounded(6)
              .bg(t.solid)
              .text_size(12)
              .font_medium()
              .text_color(t.solid_foreground)
              .cursor_pointer()
              .hover(s => s.opacity(0.9))
              .on_click((_e, cx) => this.submitFs(isQuickEdit, "tab", cx))
              .child(this.fsBusy ? "Working…" : isFolder ? "Create Folder" : isQuickEdit ? "Open in micro/nano" : "Create & Open"),
          ),
      );
  }

  renderAddAlias(t, fontFamily) {
    const field = (label, input) =>
      v_flex()
        .gap(4)
        .child(div().text_size(11).text_color(t.dim).child(label))
        .child(
          h_flex()
            .h(34)
            .px(10)
            .items_center()
            .rounded(6)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .child(Input.new(input).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
        );

    return v_flex()
      .id("cp-add-alias")
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.enterRunnerMode(cx);
        }
      })
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(14).font_semibold().child("Add Command Alias"))
          .child(
            div()
              .id("cp-alias-back")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.enterRunnerMode(cx))
              .child("← Back"),
          ),
      )
      .child(field("Alias name", this.aliasNameInput))
      .child(field("Shell command", this.aliasCmdInput))
      .child(field("Description", this.aliasDescInput))
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().text_size(11).text_color(t.dim).child("Open in:"))
          .child(this.chip("al-pl-tab", "Tab", this.aliasPlace === "tab", (_e, cx) => { this.aliasPlace = "tab"; cx.notify(); }, t))
          .child(this.chip("al-pl-right", "Split →", this.aliasPlace === "right", (_e, cx) => { this.aliasPlace = "right"; cx.notify(); }, t))
          .child(this.chip("al-pl-down", "Split ↓", this.aliasPlace === "down", (_e, cx) => { this.aliasPlace = "down"; cx.notify(); }, t))
          .child(div().flex_1())
          .child(this.chip("al-keep", this.aliasKeepOpen ? "Keep open: On" : "Keep open: Off", this.aliasKeepOpen, (_e, cx) => { this.aliasKeepOpen = !this.aliasKeepOpen; cx.notify(); }, t)),
      )
      .when(Boolean(this.aliasFormError), el => el.child(div().text_size(11.5).text_color(t.ansi1).child(this.aliasFormError)))
      .child(
        h_flex()
          .pt(4)
          .gap(8)
          .justify_end()
          .child(
            h_flex()
              .id("cp-alias-cancel")
              .h(32)
              .px(12)
              .items_center()
              .rounded(6)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_size(12)
              .text_color(t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.enterRunnerMode(cx))
              .child("Cancel"),
          )
          .child(
            h_flex()
              .id("cp-alias-save")
              .h(32)
              .px(14)
              .items_center()
              .rounded(6)
              .bg(t.solid)
              .text_size(12)
              .font_medium()
              .text_color(t.solid_foreground)
              .cursor_pointer()
              .hover(s => s.opacity(0.9))
              .on_click((_e, cx) => this.submitNewAlias(cx))
              .child("Save Alias"),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;

    if (this.mode === "create-file" || this.mode === "create-folder" || this.mode === "quick-edit") {
      return this.renderFsModal(t, fontFamily);
    }
    if (this.mode === "add-alias") {
      return this.renderAddAlias(t, fontFamily);
    }

    const runner = this.isRunnerQuery();
    const items = this.visibleItems();
    const safeIdx = Math.min(this.selected, Math.max(0, items.length - 1));
    this.selected = safeIdx;
    const listHeight = Math.min(360, Math.max(56, items.length * (ROW_HEIGHT + 2)));

    return v_flex()
      .id("command-palette")
      .w_full()
      .min_h(0)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") {
          cx.stop_propagation();
          this.dismiss();
          return;
        }
        if (k === "backspace" && runner && this.query === "") {
          cx.stop_propagation();
          this.exitRunnerMode(cx);
          return;
        }
        if (k === "down" && items.length) {
          this.selected = (this.selected + 1) % items.length;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "up" && items.length) {
          this.selected = (this.selected + items.length - 1) % items.length;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "enter" && e.modifiers?.shift) {
          cx.stop_propagation();
          this.executeSelected(true, cx);
        }
      })
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(8)
          .bg(t.background)
          .border_1()
          .border_color(t.accent)
          .child(
            div()
              .id("cp-mode-badge")
              .px(6)
              .py(2)
              .rounded(4)
              .bg(runner ? t.selected : t.surface)
              .text_size(11.5)
              .font_bold()
              .text_color(runner ? t.accent : t.dim)
              .when(runner, el =>
                el
                  .cursor_pointer()
                  .tooltip("Exit terminal mode (Backspace)")
                  .hover(s => s.bg(t.hover))
                  .on_click((_e, cx) => this.exitRunnerMode(cx)),
              )
              .child(runner ? ">_" : "⌘"),
          )
          .child(Input.new(this.searchInput).flex_1().h_full().text_size(13).text_color(t.foreground))
          .child(
            div()
              .id("cp-mode-toggle")
              .px(7)
              .py(3)
              .rounded(5)
              .bg(runner ? t.selected : t.surface)
              .text_size(11)
              .font_medium()
              .text_color(runner ? t.accent : t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                if (runner) {
                  this.query = "";
                  this.searchInput?.set_value("");
                  this.exitRunnerMode(cx);
                } else {
                  this.enterRunnerMode(cx);
                }
              })
              .child(runner ? "Commands" : "> Run"),
          ),
      )
      .when(runner, el =>
        el.child(
          h_flex()
            .flex_none()
            .items_center()
            .gap(6)
            .child(this.chip("cp-pl-tab", "Tab", this.runnerPlace === "tab", (_e, cx) => { this.runnerPlace = "tab"; cx.notify(); }, t))
            .child(this.chip("cp-pl-right", "Split →", this.runnerPlace === "right", (_e, cx) => { this.runnerPlace = "right"; cx.notify(); }, t))
            .child(this.chip("cp-keep", this.runnerKeepOpen ? "Keep open" : "Auto-close", this.runnerKeepOpen, (_e, cx) => { this.runnerKeepOpen = !this.runnerKeepOpen; cx.notify(); }, t))
            .child(div().flex_1())
            .child(this.chip("cp-add-al-btn", "+ Add Alias", false, (_e, cx) => this.switchMode("add-alias", cx), t))
            .child(this.chip("cp-edit-al-btn", "Edit JSON", false, () => { this.dismiss(); openAliasesInViewer(); }, t)),
        ),
      )
      .when(Boolean(this.aliasesError) && runner, el =>
        el.child(div().text_size(11).text_color(t.ansi1).child(this.aliasesError)),
      )
      .child(
        v_flex()
          .id("cp-list")
          .h(listHeight)
          .flex_none()
          .overflow_y_scrollbar()
          .gap(2)
          .children(
            items.length
              ? items.map((item, idx) => {
                  const isSel = idx === safeIdx;
                  return h_flex()
                    .id(`cp-item-${idx}-${item.id}`)
                    .h(ROW_HEIGHT)
                    .flex_none()
                    .px(10)
                    .gap(10)
                    .items_center()
                    .rounded(7)
                    .cursor_pointer()
                    .when(isSel, el => el.bg(t.selected))
                    .hover(s => s.bg(isSel ? t.selected : t.hover))
                    .on_click((e, cx) => this.executeItem(item, Boolean(e?.modifiers?.shift), cx))
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .flex_none()
                        .rounded(4)
                        .bg(t.surface)
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(isSel ? t.accent : t.dim)
                        .child(item.group || "Cmd"),
                    )
                    .child(
                      v_flex()
                        .flex_1()
                        .min_w(0)
                        .gap(1)
                        .child(
                          div()
                            .truncate()
                            .text_size(12.5)
                            .font_medium()
                            .text_color(isSel ? t.foreground : t.foreground)
                            .child(item.title),
                        )
                        .when(Boolean(item.subtitle), sub =>
                          sub.child(
                            div()
                              .truncate()
                              .text_size(11)
                              .text_color(t.dim)
                              .child(item.subtitle),
                          ),
                        ),
                    )
                    .when(Boolean(item.shortcut), sc =>
                      sc.child(
                        div()
                          .px(6)
                          .py(2)
                          .flex_none()
                          .rounded(4)
                          .bg(t.surface)
                          .border_1()
                          .border_color(t.border)
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child(item.shortcut),
                      ),
                    );
                })
              : [
                  div()
                    .p(14)
                    .text_size(12)
                    .text_color(t.dim)
                    .child(runner ? "Type a shell command after > and press Enter" : "No matching commands"),
                ],
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .pt(4)
          .border_t(1)
          .border_color(t.border)
          .items_center()
          .justify_between()
          .text_size(11)
          .text_color(t.dim)
          .child(runner ? "Enter: run · Shift+Enter: split right · Backspace (empty): exit" : "↑↓: navigate · Enter: run · Type > for terminal commands")
          .child(this.root ? this.root.split(/[\\/]/).pop() : ""),
      );
  }
}
