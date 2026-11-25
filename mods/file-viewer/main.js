// Read-only code & Markdown preview viewer pane opened by files-search.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, readTextFile, theme, settings, shared, run, panes, focused, checking } from "herdr";

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
    this.solo = Boolean(initialProps?.solo);
    this.tabId = initialProps?.tab ?? focused()?.tab ?? null;

    if (checking()) return;
    const p = initialProps ?? props();
    if (p?.file && p?.root) {
      this.openTarget(p, cx);
    }
  }

  close() {
    this.code?.release();
    this.code = null;
  }

  checkSharedTarget(cx) {
    if (this.solo) return;
    const req = shared("file-viewer.open");
    if (!req || !req.seq || req.seq === this.lastSharedSeq) return;
    if (this.tabId && req.tab && req.tab !== this.tabId) return;
    if (req.pane && this.myPaneId() && req.pane !== this.myPaneId()) return;
    this.lastSharedSeq = req.seq;
    this.openTarget(req, cx);
  }

  myPaneId() {
    const list = panes().filter(p => p.mod === "file-viewer" && (!this.tabId || p.tab === this.tabId));
    return list.length === 1 ? list[0].pane : null;
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
      cx.notify();
      return;
    }

    this.code?.release();
    this.code = null;
    this.rawText = null;
    this.highlightRange = null;
    this.previewMarkdown = isMarkdown(this.file);
    this.loading = true;

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
          cx.notify();
        }
      }
    });
  }

  render(cx) {
    if (!checking()) this.checkSharedTarget(cx);
    const t = theme();
    const font = settings();
    const fontSize = Math.max(9, Math.min(28, (font.font_size ?? 14) + this.fontDelta));
    const md = isMarkdown(this.file);
    const showMdPreview = md && this.previewMarkdown && this.rawText !== null;
    const myPane = panes().find(
      p => p.mod === "file-viewer" && (!this.tabId || p.tab === this.tabId) && (p.focused || panes().filter(x => x.mod === "file-viewer" && (!this.tabId || x.tab === this.tabId)).length === 1),
    );
    const isZoomed = Boolean(myPane?.zoomed);
    const title = this.file
      ? (this.line ? `${this.file}:${this.line}` : this.file)
      : "No file selected";

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
        cx.notify();
      })
      .on_pinch((e, cx) => {
        const d = e.delta ?? 0;
        if (Math.abs(d) < 0.02) return;
        cx.stop_propagation();
        this.fontDelta = Math.max(-5, Math.min(12, this.fontDelta + (d > 0 ? 1 : -1)));
        cx.notify();
      })
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(12)
          .gap(4)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(title))
          .when(md, el =>
            el.child(
              div()
                .id("fv-md-toggle")
                .px(6)
                .py(2)
                .rounded(5)
                .text_size(11)
                .font_medium()
                .cursor_pointer()
                .when(this.previewMarkdown, c => c.bg(t.selected))
                .text_color(this.previewMarkdown ? t.accent : t.dim)
                .hover(s => s.bg(this.previewMarkdown ? t.selected : t.hover).text_color(this.previewMarkdown ? t.accent : t.foreground))
                .on_click((_e, cx) => {
                  this.previewMarkdown = !this.previewMarkdown;
                  cx.notify();
                })
                .child(this.previewMarkdown ? "Preview" : "Raw"),
            ),
          )
          .child(
            div()
              .id("fv-zoom-out")
              .px(5)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.fontDelta = Math.max(-5, this.fontDelta - 1);
                cx.notify();
              })
              .child("A−"),
          )
          .when(this.fontDelta !== 0, el =>
            el.child(
              div()
                .id("fv-zoom-reset")
                .px(4)
                .py(2)
                .rounded(5)
                .text_size(10.5)
                .text_color(t.accent)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.fontDelta = 0;
                  cx.notify();
                })
                .child(`${fontSize}px`),
            ),
          )
          .child(
            div()
              .id("fv-zoom-in")
              .px(5)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.fontDelta = Math.min(12, this.fontDelta + 1);
                cx.notify();
              })
              .child("A+"),
          )
          .child(
            div()
              .id("fv-pane-zoom")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .cursor_pointer()
              .when(isZoomed, el => el.bg(t.selected))
              .text_color(isZoomed ? t.accent : t.dim)
              .hover(s => s.bg(isZoomed ? t.selected : t.hover).text_color(isZoomed ? t.accent : t.foreground))
              .on_click(() => run("pane.zoom"))
              .child(isZoomed ? "Unzoom" : "Zoom"),
          )
          .when(!showMdPreview, el =>
            el.child(
              div()
                .id("fv-wrap")
                .px(6)
                .py(2)
                .rounded(5)
                .text_size(11)
                .cursor_pointer()
                .when(this.softWrap, c => c.bg(t.selected))
                .text_color(this.softWrap ? t.accent : t.dim)
                .hover(s => s.bg(this.softWrap ? t.selected : t.hover).text_color(this.softWrap ? t.accent : t.foreground))
                .on_click((_e, cx) => {
                  this.softWrap = !this.softWrap;
                  this.code?.set_soft_wrap(this.softWrap);
                  cx.notify();
                })
                .child("Wrap"),
            ),
          )
          .child(
            div()
              .id("fv-close")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(12)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => run("pane.close"))
              .child("×"),
          ),
      )
      .child(body);
  }
}
