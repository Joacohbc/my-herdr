import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list } from "gpui-base";
import { props, readTextFile, theme, settings, shared, setShared, panes, spaces, focused, window, checking } from "herdr";
import {
  detectFileKind,
  columnLetter,
  parseCsvTable,
  stageImagePreview,
  inspectPdf,
  renderPdfPage,
  removePreviewFile,
} from "./preview.js";

const MAX_FILE_CHARS = 250_000;
const HIBERNATE_IDLE_MS = 45_000;
const IDLE_CHECK_MS = 15_000;

const LANG = {
  ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js",
  toml: "yaml", jsonc: "json", svelte: "html", vue: "html",
  md: "markdown", mdx: "markdown", svg: "xml",
};

function buildLineStarts(text) {
  const starts = [0];
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    starts.push(idx + 1);
    idx = text.indexOf("\n", idx + 1);
  }
  starts.push(text.length + 1);
  return new Uint32Array(starts);
}

function offsetFromLineStarts(lineStarts, textLen, line, col, matchLen) {
  if (!lineStarts || lineStarts.length < 2) return { start: 0, end: 0 };
  const clampedLine = Math.max(1, Math.min(line, lineStarts.length - 1));
  const lineStart = lineStarts[clampedLine - 1];
  const lineEnd = Math.min(textLen, Math.max(lineStart, lineStarts[clampedLine] - 1));
  const start = Math.min(lineEnd, lineStart + Math.max(0, (col || 1) - 1));
  const end = Math.min(lineEnd, start + Math.max(0, matchLen || 0));
  return { start, end };
}

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function createReadonlyEditor(file, content, softWrap) {
  const t = theme();
  const ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "txt";
  return EditorState.new({
    language: LANG[ext] ?? ext,
    readonly: true,
    soft_wrap: softWrap,
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
}

export default class FileViewer extends View {
  init(initialProps, cx) {
    const p = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();
    this.code = null;
    this.rawText = null;
    this.lineStarts = null;
    this.textLen = 0;
    this.file = null;
    this.root = null;
    this.on = null;
    this.kind = "code";
    this.line = null;
    this.col = null;
    this.matchLen = null;
    this.highlightRange = null;
    this.error = null;
    this.loading = false;
    this.hibernated = false;
    this.hiddenSince = 0;
    this.softWrap = false;
    this.previewMode = true;
    this.fontDelta = 0;
    this.loadSeq = 0;
    this.token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    this.imageRelPath = null;
    this.imageSizeBytes = 0;
    this.csvTable = null;
    this.pdfPages = 0;
    this.pdfPage = 1;
    this.pdfTitle = "";
    this.pdfRelPath = null;
    this.pdfPageLoading = false;

    this.lastSharedSeq = shared("file-viewer.open")?.seq ?? 0;
    this.lastCmdSeq = shared("file-viewer.cmd")?.seq ?? 0;
    this.lastGcSeq = shared("herdr.gc")?.seq ?? 0;
    this.solo = Boolean(p?.solo);
    this.tabId = p?.tab ?? null;
    this.paneId = null;

    if (checking()) return;
    if (p?.file && p?.root) {
      this.openTarget(p, cx);
    }
    cx.timer.every(IDLE_CHECK_MS, cx => this.checkHibernation(cx));
  }

  close() {
    this.releaseBuffers();
    if (this.paneId) {
      const all = { ...(shared("file-viewer.meta") ?? {}) };
      delete all[this.paneId];
      setShared("file-viewer.meta", all);
    }
  }

  releaseBuffers() {
    this.code?.release();
    this.code = null;
    this.rawText = null;
    this.lineStarts = null;
    this.textLen = 0;
    this.csvTable = null;
    if (this.imageRelPath) {
      const old = this.imageRelPath;
      this.imageRelPath = null;
      removePreviewFile(old);
    }
    if (this.pdfRelPath) {
      const old = this.pdfRelPath;
      this.pdfRelPath = null;
      removePreviewFile(old);
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

  isPaneVisible() {
    if (window()?.visible === false) return false;
    const paneId = this.resolvePaneId();
    if (!paneId) return true;
    const activeSpace = spaces().find(s => s.active);
    const activeTabId = activeSpace?.tabs?.find(t => t.active)?.id;
    if (!activeTabId) return false;
    const allPanes = panes();
    const me = allPanes.find(p => p.pane === paneId);
    if (!me || me.tab !== activeTabId) return false;
    const otherZoomed = allPanes.some(p => p.tab === activeTabId && p.zoomed && p.pane !== paneId);
    return !otherZoomed;
  }

  hasLoadedContent() {
    return Boolean(this.code || this.rawText !== null || this.imageRelPath || this.csvTable || this.pdfRelPath);
  }

  hibernate(cx) {
    if (this.hibernated || !this.hasLoadedContent()) return;
    this.loadSeq++;
    this.releaseBuffers();
    this.loading = false;
    this.pdfPageLoading = false;
    this.hibernated = true;
    cx?.notify();
  }

  checkHibernation(cx) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    const forceGc = gcSeq !== this.lastGcSeq;
    this.lastGcSeq = gcSeq;

    if (this.isPaneVisible()) {
      this.hiddenSince = 0;
      if (this.hibernated && this.file && this.root && !this.loading) {
        this.openTarget({
          file: this.file,
          root: this.root,
          on: this.on,
          line: this.line,
          col: this.col,
          matchLen: this.matchLen,
        }, cx);
      }
      return;
    }

    const now = Date.now();
    if (!this.hiddenSince) this.hiddenSince = now;
    if (forceGc || now - this.hiddenSince >= HIBERNATE_IDLE_MS) {
      this.hibernate(cx);
    }
  }

  supportsRawToggle() {
    return this.kind === "markdown" || this.kind === "csv" || this.kind === "svg";
  }

  publishMeta() {
    const paneId = this.resolvePaneId();
    if (!paneId) return;
    const baseSize = settings().font_size ?? 14;
    const fontSize = Math.max(9, Math.min(28, baseSize + this.fontDelta));
    const zoomPct = Math.round((fontSize / baseSize) * 100);
    const hasPreview = this.supportsRawToggle();
    const next = {
      file: this.file,
      root: this.root,
      on: this.on,
      line: this.line,
      md: hasPreview,
      hasPreview,
      preview: hasPreview ? this.previewMode : (this.kind === "image" || this.kind === "pdf"),
      wrap: this.softWrap,
      zoomPct,
    };
    const all = shared("file-viewer.meta") ?? {};
    const prev = all[paneId];
    if (
      prev &&
      prev.file === next.file &&
      prev.line === next.line &&
      prev.hasPreview === next.hasPreview &&
      prev.preview === next.preview &&
      prev.wrap === next.wrap &&
      prev.zoomPct === next.zoomPct
    ) {
      return;
    }
    setShared("file-viewer.meta", { ...all, [paneId]: next });
  }

  togglePreviewMode(cx) {
    if (!this.supportsRawToggle()) return;
    this.previewMode = !this.previewMode;
    if (this.previewMode) {
      this.code?.release();
      this.code = null;
      return;
    }
    if (this.rawText !== null) {
      this.code = createReadonlyEditor(this.file, this.rawText, this.softWrap);
      if (this.highlightRange) this.code.set_selected_range(this.highlightRange);
      return;
    }
    if (this.kind === "svg" && this.file && this.root) {
      const seq = ++this.loadSeq;
      const fullPath = `${this.root}/${this.file}`;
      const on = this.on;
      cx.spawn(async cx => {
        try {
          const text = await readTextFile(fullPath, { on });
          if (this.loadSeq !== seq || text === null) return;
          const content = text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) + "\n… (truncated)" : text;
          this.rawText = content;
          if (!this.previewMode) this.code = createReadonlyEditor(this.file, content, this.softWrap);
        } catch {
          // ignore
        } finally {
          if (this.loadSeq === seq) cx.notify();
        }
      });
    }
  }

  checkCommands(cx) {
    const cmd = shared("file-viewer.cmd");
    if (!cmd || !cmd.seq || cmd.seq === this.lastCmdSeq) return;
    const paneId = this.resolvePaneId();
    if (cmd.pane && paneId && cmd.pane !== paneId) return;
    this.lastCmdSeq = cmd.seq;

    if (cmd.action === "toggle_preview") {
      this.togglePreviewMode(cx);
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

  loadPdfPage(page, cx) {
    if (!this.file || !this.root) return;
    const clamped = Math.max(1, Math.min(this.pdfPages || 1, page));
    const seq = ++this.loadSeq;
    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;
    this.pdfPage = clamped;
    this.pdfPageLoading = true;
    cx.notify();

    cx.spawn(async cx => {
      try {
        const nextRel = await renderPdfPage(fullPath, on, clamped, `${this.token}-${seq}`);
        if (this.loadSeq !== seq) {
          removePreviewFile(nextRel);
          return;
        }
        const prevRel = this.pdfRelPath;
        this.pdfRelPath = nextRel;
        if (prevRel && prevRel !== nextRel) removePreviewFile(prevRel);
        this.error = null;
      } catch (e) {
        if (this.loadSeq === seq) this.error = String(e.message || e);
      } finally {
        if (this.loadSeq === seq) {
          this.pdfPageLoading = false;
          cx.notify();
        }
      }
    });
  }

  openTarget(target, cx) {
    const seq = ++this.loadSeq;
    const sameFile = !this.hibernated
      && this.hasLoadedContent()
      && this.file === target.file
      && this.root === target.root
      && this.on === (target.on ?? null);

    this.file = target.file;
    this.root = target.root;
    this.on = target.on ?? null;
    this.kind = detectFileKind(this.file);
    this.line = target.line ?? null;
    this.col = target.col ?? null;
    this.matchLen = target.matchLen ?? null;
    this.error = null;
    this.hibernated = false;
    this.hiddenSince = 0;

    if (sameFile) {
      if (target.line && this.lineStarts) {
        const range = offsetFromLineStarts(this.lineStarts, this.textLen, target.line, target.col, target.matchLen);
        this.highlightRange = range.end > range.start ? range : null;
        this.code?.set_selected_range(range);
      } else {
        this.highlightRange = null;
      }
      this.publishMeta();
      cx.notify();
      return;
    }

    this.releaseBuffers();
    this.highlightRange = null;
    this.previewMode = this.kind !== "code";
    this.loading = true;
    this.publishMeta();

    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;
    const kind = this.kind;

    cx.spawn(async cx => {
      try {
        if (kind === "image" || kind === "svg") {
          const staged = await stageImagePreview(fullPath, on, `${this.token}-${seq}`);
          if (this.loadSeq !== seq) {
            removePreviewFile(staged.relPath);
            return;
          }
          this.imageRelPath = staged.relPath;
          this.imageSizeBytes = staged.sizeBytes;
          return;
        }

        if (kind === "pdf") {
          const info = await inspectPdf(fullPath, on);
          if (this.loadSeq !== seq) return;
          this.pdfPages = info.pages;
          this.pdfTitle = info.title;
          this.pdfPage = Math.max(1, Math.min(info.pages, this.pdfPage || 1));
          const rel = await renderPdfPage(fullPath, on, this.pdfPage, `${this.token}-${seq}`);
          if (this.loadSeq !== seq) {
            removePreviewFile(rel);
            return;
          }
          this.pdfRelPath = rel;
          return;
        }

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
        const content = text.length > MAX_FILE_CHARS
          ? text.slice(0, MAX_FILE_CHARS) + "\n… (file truncated at 250 KB to save RAM)"
          : text;
        this.lineStarts = buildLineStarts(content);
        this.textLen = content.length;

        const range = target.line
          ? offsetFromLineStarts(this.lineStarts, this.textLen, target.line, target.col, target.matchLen)
          : null;
        this.highlightRange = range && range.end > range.start ? range : null;

        if (kind === "csv") {
          this.rawText = content;
          this.csvTable = parseCsvTable(content, this.file.toLowerCase().endsWith(".tsv"));
          this.code = null;
        } else if (kind === "markdown" && this.previewMode) {
          this.rawText = content;
          this.code = null;
        } else {
          this.code = createReadonlyEditor(this.file, content, this.softWrap);
          if (range) this.code.set_selected_range(range);
          this.rawText = kind === "markdown" ? content : null;
        }
      } catch (e) {
        if (this.loadSeq === seq) {
          this.error = String(e?.message || "Cannot preview this file");
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

  renderImageBody(t, zoomScale) {
    const imgSize = Math.round(Math.max(180, Math.min(1800, 520 * zoomScale)));
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(28)
          .flex_none()
          .px(12)
          .gap(10)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child(this.kind === "svg" ? "SVG Preview" : "Image Preview")
          .when(this.imageSizeBytes > 0, el => el.child(`· ${formatBytes(this.imageSizeBytes)}`))
          .child(div().flex_1())
          .child("Ctrl + wheel to zoom"),
      )
      .child(
        v_flex()
          .id("fv-img-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .items_center()
          .justify_center()
          .p(20)
          .child(
            div()
              .p(12)
              .rounded(8)
              .bg(this.kind === "svg" ? "#e5e7eb" : t.surface)
              .border_1()
              .border_color(t.border)
              .child(image(this.imageRelPath).w(imgSize).h(imgSize)),
          ),
      );
  }

  renderPdfBody(t, zoomScale) {
    const pageW = Math.round(Math.max(260, Math.min(1800, 680 * zoomScale)));
    const pageH = Math.round(pageW * 1.32);
    const navBtn = (id, label, disabled, onClick) =>
      div()
        .id(id)
        .px(7)
        .py(2)
        .rounded(5)
        .text_size(11.5)
        .bg(t.raised)
        .text_color(disabled ? t.dim : t.foreground)
        .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(onClick))
        .child(label);

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(navBtn("pdf-prev", "← Prev", this.pdfPage <= 1 || this.pdfPageLoading, (_e, cx) => this.loadPdfPage(this.pdfPage - 1, cx)))
          .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(`Page ${this.pdfPage} / ${this.pdfPages}`))
          .child(navBtn("pdf-next", "Next →", this.pdfPage >= this.pdfPages || this.pdfPageLoading, (_e, cx) => this.loadPdfPage(this.pdfPage + 1, cx)))
          .when(this.pdfPageLoading, el => el.child(div().text_size(11).text_color(t.accent).child("Rendering…")))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(this.pdfTitle || "Single-page lazy PDF mode")),
      )
      .child(
        v_flex()
          .id("fv-pdf-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .items_center()
          .p(16)
          .when(Boolean(this.pdfRelPath), el =>
            el.child(
              div()
                .rounded(6)
                .overflow_hidden()
                .border_1()
                .border_color(t.border)
                .bg("#ffffff")
                .child(image(this.pdfRelPath).w(pageW).h(pageH)),
            ),
          ),
      );
  }

  renderCsvBody(t, fontSize) {
    const tbl = this.csvTable;
    const rowH = Math.ceil(fontSize * 1.9);
    const gutterW = 46;
    const totalW = gutterW + tbl.colWidths.reduce((s, w) => s + w, 0) + 16;

    const headerCells = [
      div().w(gutterW).h_full().flex_none().px(6).flex().items_center().justify_end().border_r(1).border_color(t.border).text_size(10.5).text_color(t.dim).child("#"),
      ...tbl.colWidths.map((w, idx) =>
        h_flex()
          .w(w)
          .h_full()
          .flex_none()
          .px(8)
          .gap(5)
          .items_center()
          .border_r(1)
          .border_color(t.border)
          .child(div().text_size(9.5).font_semibold().text_color(t.accent).child(columnLetter(idx)))
          .child(div().flex_1().min_w(0).truncate().text_size(Math.max(10, fontSize - 1.5)).font_semibold().text_color(t.foreground).child(tbl.headers[idx] ?? "")),
      ),
    ];

    const renderDataRow = (row, rowIdx) =>
      h_flex()
        .w_full()
        .h(rowH)
        .flex_none()
        .border_b(1)
        .border_color(t.border)
        .when(rowIdx % 2 === 1, el => el.bg(t.surface + "66"))
        .child(
          div()
            .w(gutterW)
            .h_full()
            .flex_none()
            .px(6)
            .flex()
            .items_center()
            .justify_end()
            .bg(t.surface)
            .border_r(1)
            .border_color(t.border)
            .text_size(10.5)
            .text_color(t.dim)
            .child(String(rowIdx + 1)),
        )
        .children(
          tbl.colWidths.map((w, c) =>
            div()
              .w(w)
              .h_full()
              .flex_none()
              .px(8)
              .flex()
              .items_center()
              .border_r(1)
              .border_color(t.border)
              .child(div().w_full().truncate().text_size(Math.max(10, fontSize - 1)).text_color(t.foreground).child(row[c] ?? "")),
          ),
        );

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child(`${tbl.dataRows.length}${tbl.truncated ? "+" : ""} rows × ${tbl.colCount} cols`)
          .child(`· delim "${tbl.delimiter === "\t" ? "TAB" : tbl.delimiter}"`),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            div()
              .id("fv-csv-x")
              .size_full()
              .overflow_x_scrollbar()
              .child(
                v_flex()
                  .w(totalW)
                  .h_full()
                  .child(
                    h_flex()
                      .h(rowH + 2)
                      .flex_none()
                      .bg(t.raised)
                      .border_b(1)
                      .border_color(t.border)
                      .children(headerCells),
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_h(0)
                      .child(
                        v_virtual_list(
                          "fv-csv-rows",
                          tbl.dataRows.length,
                          rowH,
                          (i) => String(i),
                          (range) => tbl.dataRows.slice(range.start, range.end).map((r, offset) => renderDataRow(r, range.start + offset)),
                        ).size_full(),
                      ),
                  ),
              ),
          )
          .child(Scrollbar.vertical("fv-csv-rows").viewport_from_layout().absolute().inset_0()),
      );
  }

  render(cx) {
    if (!checking()) {
      this.checkSharedTarget(cx);
      this.checkCommands(cx);
      this.checkHibernation(cx);
      this.publishMeta();
    }
    const t = theme();
    const font = settings();
    const baseSize = font.font_size ?? 14;
    const fontSize = Math.max(9, Math.min(28, baseSize + this.fontDelta));
    const zoomScale = fontSize / baseSize;

    let body;
    if (this.error) {
      body = div().p(14).text_size(12.5).text_color(t.ansi1).child(this.error);
    } else if ((this.kind === "image" || (this.kind === "svg" && this.previewMode)) && this.imageRelPath) {
      body = this.renderImageBody(t, zoomScale);
    } else if (this.kind === "pdf" && this.pdfRelPath) {
      body = this.renderPdfBody(t, zoomScale);
    } else if (this.kind === "csv" && this.previewMode && this.csvTable) {
      body = this.renderCsvBody(t, fontSize);
    } else if (this.kind === "markdown" && this.previewMode && this.rawText !== null) {
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
      const placeholder = this.loading || this.hibernated ? "Loading file…" : "Select a file from the Files panel";
      body = div().p(14).text_size(12.5).text_color(t.dim).child(placeholder);
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
