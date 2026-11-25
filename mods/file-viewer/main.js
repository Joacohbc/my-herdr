// Read-only code & Markdown preview viewer pane opened by files-search.
// Controls live in the unified pane-custom header bar via shared state.
import { View, div } from "gpui-kit";
import { v_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, theme, settings, shared, setShared, panes, focused, checking } from "herdr";

const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js",
  toml: "yaml", jsonc: "json", svelte: "html", vue: "html",
  md: "markdown", mdx: "markdown",
};

function isMarkdown(path) {
  if (!path) return false;
  return /\.(md|markdown|mdx)$/i.test(path);
}

function offsetForLineCol(text, line, col, matchLen) {
  let currentLine = 1;
  let lineStart = 0;
  while (currentLine < line && lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    if (nl === -1) break;
    lineStart = nl + 1;
    currentLine++;
  }
  const nextNl = text.indexOf("\n", lineStart);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  const start = Math.min(lineEnd, lineStart + Math.max(0, (col || 1) - 1));
  const end = Math.min(lineEnd, start + Math.max(0, matchLen || 0));
  return { start, end };
}

export default class FileViewer extends View {
  init(initialProps, cx) {
    this.code = null;
    this.rawText = null;
    this.file = null;
    this.root = null;
    this.on = null;
    this.line = null;
    this.highlightRange = null;
    this.error = null;
    this.loading = false;
    this.softWrap = false;
    this.previewMarkdown = true;
    this.fontDelta = 0;
    this.loadSeq = 0;
    this.lastSharedSeq = shared("file-viewer.open")?.seq ?? 0;
    this.lastCmdSeq = shared("file-viewer.cmd")?.seq ?? 0;
    this.solo = Boolean(initialProps?.solo);
    this.tabId = initialProps?.tab ?? null;
    this.paneId = null;

    if (checking()) return;
    const p = initialProps ?? props();
    if (p?.file && p?.root) {
      this.openTarget(p, cx);
    }
  }

  close() {
    this.code?.release();
    this.code = null;
    if (this.paneId) {
      const all = { ...(shared("file-viewer.meta") ?? {}) };
      delete all[this.paneId];
      setShared("file-viewer.meta", all);
    }
  }

  resolvePaneId() {
    const allViewers = panes().filter(p => p.mod === "file-viewer");
    if (this.paneId && allViewers.some(p => p.pane === this.paneId)) return this.paneId;

    const scoped = this.tabId ? allViewers.filter(p => p.tab === this.tabId) : allViewers;
    const focusedMatch = scoped.find(p => p.focused) ?? allViewers.find(p => p.focused);
    if (focusedMatch) {
      this.paneId = focusedMatch.pane;
      this.tabId = focusedMatch.tab;
      return this.paneId;
    }

    const activeTab = focused()?.tab;
    const inActiveTab = activeTab ? allViewers.filter(p => p.tab === activeTab) : [];
    if (inActiveTab.length === 1) {
      this.paneId = inActiveTab[0].pane;
      this.tabId = inActiveTab[0].tab;
      return this.paneId;
    }

    if (scoped.length === 1) {
      this.paneId = scoped[0].pane;
      this.tabId = scoped[0].tab;
      return this.paneId;
    }
    return this.paneId;
  }

  publishMeta() {
    const paneId = this.resolvePaneId();
    if (!paneId) return;
    const baseSize = settings().font_size ?? 14;
    const fontSize = Math.max(9, Math.min(28, baseSize + this.fontDelta));
    const zoomPct = Math.round((fontSize / baseSize) * 100);
    const md = isMarkdown(this.file);
    const next = {
      file: this.file,
      root: this.root,
      on: this.on,
      line: this.line,
      md,
      preview: md && this.previewMarkdown,
      wrap: this.softWrap,
      zoomPct,
    };
    const all = shared("file-viewer.meta") ?? {};
    const prev = all[paneId];
    if (
      prev &&
      prev.file === next.file &&
      prev.line === next.line &&
      prev.md === next.md &&
      prev.preview === next.preview &&
      prev.wrap === next.wrap &&
      prev.zoomPct === next.zoomPct
    ) {
      return;
    }
    setShared("file-viewer.meta", { ...all, [paneId]: next });
  }

  checkCommands(cx) {
    const cmd = shared("file-viewer.cmd");
    if (!cmd || !cmd.seq || cmd.seq === this.lastCmdSeq) return;
    const paneId = this.resolvePaneId();
    if (cmd.pane && paneId && cmd.pane !== paneId) return;
    this.lastCmdSeq = cmd.seq;

    if (cmd.action === "toggle_preview") {
      this.previewMarkdown = !this.previewMarkdown;
    } else if (cmd.action === "toggle_wrap") {
      this.softWrap = !this.softWrap;
      this.code?.set_soft_wrap(this.softWrap);
    } else if (cmd.action === "zoom_in") {
      this.fontDelta = Math.min(12, this.fontDelta + 1);
    } else if (cmd.action === "zoom_out") {
      this.fontDelta = Math.max(-5, this.fontDelta - 1);
    } else if (cmd.action === "zoom_reset") {
      this.fontDelta = 0;
    }
    this.publishMeta();
    cx.notify();
  }

  checkSharedTarget(cx) {
    if (this.solo) return;
    const req = shared("file-viewer.open");
    if (!req || !req.seq || req.seq === this.lastSharedSeq) return;
    if (this.tabId && req.tab && req.tab !== this.tabId) return;
    const paneId = this.resolvePaneId();
    if (req.pane && paneId && req.pane !== paneId) return;
    this.lastSharedSeq = req.seq;
    this.openTarget(req, cx);
  }

  openTarget(target, cx) {
    const seq = ++this.loadSeq;
    const sameFile = this.file === target.file && this.root === target.root && this.on === (target.on ?? null) && this.rawText !== null;

    this.file = target.file;
    this.root = target.root;
    this.on = target.on ?? null;
    this.line = target.line ?? null;
    this.error = null;

    if (sameFile) {
      if (target.line) {
        const range = offsetForLineCol(this.rawText, target.line, target.col, target.matchLen);
        this.highlightRange = range.end > range.start ? range : null;
        this.code?.set_selected_range(range);
      } else {
        this.highlightRange = null;
      }
      this.publishMeta();
      cx.notify();
      return;
    }

    this.code?.release();
    this.code = null;
    this.rawText = null;
    this.highlightRange = null;
    this.previewMarkdown = isMarkdown(this.file);
    this.loading = true;
    this.publishMeta();

    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;

    cx.spawn(async cx => {
      try {
        const text = await readTextFile(fullPath, { on });
        if (this.loadSeq !== seq) return;
        if (text === null) {
          this.error = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.error = "Binary file · no text preview";
          return;
        }
        const t = theme();
        const ext = this.file.includes(".") ? this.file.split(".").pop().toLowerCase() : "txt";
        const content = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        this.rawText = content;
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          soft_wrap: this.softWrap,
          value: content,
          syntax: {
            keyword: t.ansi5,
            string: t.ansi2,
            comment: t.dim,
            function: t.ansi4,
            type: t.ansi3,
            number: t.ansi1,
            constant: t.ansi6,
          },
        });
        if (target.line) {
          const range = offsetForLineCol(content, target.line, target.col, target.matchLen);
          this.highlightRange = range.end > range.start ? range : null;
          this.code.set_selected_range(range);
        }
      } catch {
        if (this.loadSeq === seq) {
          this.error = "Cannot preview this file (binary, too large, or unreadable)";
        }
      } finally {
        if (this.loadSeq === seq) {
          this.loading = false;
          this.publishMeta();
          cx.notify();
        }
      }
    });
  }

  render(cx) {
    if (!checking()) {
      this.checkSharedTarget(cx);
      this.checkCommands(cx);
      this.publishMeta();
    }
    const t = theme();
    const font = settings();
    const fontSize = Math.max(9, Math.min(28, (font.font_size ?? 14) + this.fontDelta));
    const md = isMarkdown(this.file);
    const showMdPreview = md && this.previewMarkdown && this.rawText !== null;

    let body;
    if (showMdPreview) {
      let tv = TextView.markdown(`fv-md-${this.file}`, this.rawText)
        .selectable(true)
        .scrollable(true)
        .raw_html(false);
      if (this.highlightRange) {
        tv = tv.highlight_range(this.highlightRange.start, this.highlightRange.end, t.selection);
      }
      body = v_flex()
        .id("fv-md-wrap")
        .flex_1()
        .min_h(0)
        .px(22)
        .py(16)
        .text_size(fontSize)
        .text_color(t.foreground)
        .child(tv.flex_1().min_h(0));
    } else if (this.code) {
      body = Editor.new(this.code).font_family(font.font_family).text_size(fontSize).flex_1().min_h(0);
    } else {
      body = div().p(14).text_size(12.5).text_color(t.dim).child(this.error || (this.loading ? "Loading file…" : "Select a file from the Files panel"));
    }

    return v_flex()
      .id("file-viewer")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_scroll_wheel((e, cx) => {
        if (!e.modifiers?.control && !e.modifiers?.platform) return;
        const dy = e.delta?.y ?? 0;
        if (dy === 0) return;
        cx.stop_propagation();
        this.fontDelta = Math.max(-5, Math.min(12, this.fontDelta + (dy > 0 ? 1 : -1)));
        this.publishMeta();
        cx.notify();
      })
      .on_pinch((e, cx) => {
        const d = e.delta ?? 0;
        if (Math.abs(d) < 0.02) return;
        cx.stop_propagation();
        this.fontDelta = Math.max(-5, Math.min(12, this.fontDelta + (d > 0 ? 1 : -1)));
        this.publishMeta();
        cx.notify();
      })
      .child(body);
  }
}
