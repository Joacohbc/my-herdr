import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list, Input, InputState } from "gpui-base";
import { props, readTextFile, theme, settings, shared, setShared, panes, spaces, focused, window, nextCommand, checking } from "herdr";
import {
  detectFileKind,
  columnLetter,
  parseCsvTable,
  serializeCsvTable,
  saveTextFile,
  stageImagePreview,
  inspectPdf,
  renderPdfPage,
  removePreviewFile,
} from "./preview.js";

const MAX_FILE_CHARS = 250_000;
const CSV_PAGE_SIZE = 200;
const MAX_UNIQUE_SUGGESTIONS = 200;
const MAX_UNIQUE_SCAN_ROWS = 2500;
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

function createEditorState(file, content, softWrap, readOnly = false) {
  const t = theme();
  const ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "txt";
  return EditorState.new({
    language: LANG[ext] ?? ext,
    readonly: readOnly,
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
      heading: t.accent,
      strong: t.foreground,
      emphasis: t.ansi3,
      code: t.ansi2,
      quote: t.muted,
      list: t.ansi5,
      link: t.ansi4,
    },
  });
}

export default class FileViewer extends View {
  init(initialProps, cx) {
    const p = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();
    this.code = null;
    this.rawText = null;
    this.originalContent = null;
    this.fileTruncated = false;
    this.codeDirty = false;
    this.codeSaving = false;
    this.codeSaveError = null;
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
    this.imageAspect = 1;
    this.csvTable = null;
    this.csvOriginalText = null;
    this.csvFilter = "";
    this.csvSortCol = -1;
    this.csvSortDir = 0;
    this.csvSelected = null;
    this.csvEditedCells = new Set();
    this.csvUniqueCache?.clear();
    this.csvDirty = false;
    this.csvSaving = false;
    this.csvSaveError = null;
    this.csvViewRows = [];
    this.csvPage = 0;
    this.csvColFilters = new Map();
    this.csvUniqueCache = new Map();
    this.csvFilterMenuCol = -1;
    this.csvMenuQuery = "";
    this.csvAcIndex = 0;
    this.resizingCol = null;
    this.csvFilterInput = InputState.new({ placeholder: "Search or @Col:val1,val2…" });
    this.csvFilterInput.on("change", (_e, cx) => {
      this.csvFilter = this.csvFilterInput.value();
      this.csvAcIndex = 0;
      this.rebuildCsvViewRows();
      cx.notify();
    });
    this.csvFilterInput.on("submit", (_e, cx) => {
      this.acceptSelectedCsvSuggestion(cx);
    });
    this.csvMenuInput = InputState.new({ placeholder: "Search values…" });
    this.csvMenuInput.on("change", (_e, cx) => {
      this.csvMenuQuery = this.csvMenuInput.value();
      cx.notify();
    });
    this.csvCellInput = InputState.new({ placeholder: "Click a cell to edit (Enter to apply)" });
    this.csvCellInput.on("submit", (_e, cx) => this.applyCellEdit(cx));
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
    this.handle = cx.focus_handle();

    if (checking()) return;
    if (p?.file && p?.root) {
      this.openTarget(p, cx);
    }
    cx.timer.every(IDLE_CHECK_MS, cx => this.checkHibernation(cx));
    cx.spawn(async () => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          if (this.code) this.code.focus();
          else this.handle.focus();
        }
      }
    });
  }

  close() {
    this.releaseBuffers();
    this.csvFilterInput?.release();
    this.csvMenuInput?.release();
    this.csvCellInput?.release();
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
    this.originalContent = null;
    this.fileTruncated = false;
    this.codeDirty = false;
    this.codeSaving = false;
    this.codeSaveError = null;
    this.lineStarts = null;
    this.textLen = 0;
    this.csvTable = null;
    this.csvOriginalText = null;
    this.csvFilter = "";
    this.csvSortCol = -1;
    this.csvSortDir = 0;
    this.csvAcIndex = 0;
    this.csvViewRows = [];
    this.csvPage = 0;
    this.csvColFilters = new Map();
    this.csvUniqueCache = new Map();
    this.csvFilterMenuCol = -1;
    this.csvMenuQuery = "";
    this.csvSelected = null;
    this.csvEditedCells = new Set();
    this.csvDirty = false;
    this.csvSaveError = null;
    this.csvFilterInput?.set_value("");
    this.csvMenuInput?.set_value("");
    this.csvCellInput?.set_value("");
    this.invalidateStagedImage();
    if (this.pdfRelPath) {
      const old = this.pdfRelPath;
      this.pdfRelPath = null;
      removePreviewFile(old);
    }
  }

  invalidateStagedImage() {
    if (!this.imageRelPath) return;
    const old = this.imageRelPath;
    this.imageRelPath = null;
    removePreviewFile(old);
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

  isDirty() {
    return Boolean(this.csvDirty || this.codeDirty);
  }

  hibernate(cx, fromRender = false) {
    if (this.hibernated || this.isDirty() || !this.hasLoadedContent()) return;
    this.loadSeq++;
    this.releaseBuffers();
    this.loading = false;
    this.pdfPageLoading = false;
    this.hibernated = true;
    if (!fromRender) cx?.notify();
  }

  checkHibernation(cx, fromRender = false) {
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
        }, cx, fromRender);
      }
      return;
    }

    const now = Date.now();
    if (!this.hiddenSince) this.hiddenSince = now;
    if (forceGc || now - this.hiddenSince >= HIBERNATE_IDLE_MS) {
      this.hibernate(cx, fromRender);
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
      dirty: this.isDirty(),
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
      prev.zoomPct === next.zoomPct &&
      Boolean(prev.dirty) === next.dirty
    ) {
      return;
    }
    setShared("file-viewer.meta", { ...all, [paneId]: next });
  }

  attachEditor(file, content) {
    this.code?.release();
    const ed = createEditorState(file, content, this.softWrap, this.fileTruncated);
    if (!this.fileTruncated) {
      ed.on("change", (_e, cx) => {
        if (this.code !== ed) return;
        const nextVal = ed.value();
        this.codeDirty = nextVal !== this.originalContent;
        this.codeSaveError = null;
        if (this.kind === "markdown" || this.kind === "csv" || this.kind === "svg") {
          this.rawText = nextVal;
        }
        this.publishMeta();
        cx.notify();
      });
    }
    this.code = ed;
    return ed;
  }

  discardCodeEdits(cx) {
    if (this.originalContent === null) return;
    this.codeDirty = false;
    this.codeSaveError = null;
    if (this.code) this.code.set_value(this.originalContent);
    if (this.kind === "svg") this.invalidateStagedImage();
    if (this.kind === "markdown" || this.kind === "csv" || this.kind === "svg") {
      this.rawText = this.originalContent;
      if (this.kind === "csv") {
        this.csvDirty = false;
        this.csvEditedCells = new Set();
        this.csvTable = parseCsvTable(this.originalContent, this.file.toLowerCase().endsWith(".tsv"));
        this.csvUniqueCache.clear();
        this.rebuildCsvViewRows();
      }
    }
    this.publishMeta();
    cx.notify();
  }

  saveCodeEdits(cx) {
    if (!this.code || !this.codeDirty || this.codeSaving || this.fileTruncated || !this.file || !this.root) return;
    const content = this.code.value();
    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;
    const expected = this.originalContent;
    this.codeSaving = true;
    this.codeSaveError = null;
    cx.notify();

    cx.spawn(async cx => {
      try {
        await saveTextFile(fullPath, on, content, expected);
        this.originalContent = content;
        this.codeDirty = false;
        this.codeSaveError = null;
        if (this.kind === "svg") this.invalidateStagedImage();
        if (this.kind === "markdown" || this.kind === "csv" || this.kind === "svg") {
          this.rawText = content;
        }
        if (this.kind === "csv") {
          this.csvOriginalText = content;
          this.csvTable = parseCsvTable(content, this.file.toLowerCase().endsWith(".tsv"));
          this.csvEditedCells = new Set();
          this.csvDirty = false;
          this.csvUniqueCache.clear();
          this.rebuildCsvViewRows();
        }
      } catch (e) {
        this.codeSaveError = String(e?.message || e || "Save failed");
      } finally {
        this.codeSaving = false;
        this.publishMeta();
        cx.notify();
      }
    });
  }

  togglePreviewMode(cx) {
    if (!this.supportsRawToggle()) return;
    this.previewMode = !this.previewMode;
    if (this.previewMode) {
      if (this.code) {
        const currentVal = this.code.value();
        this.rawText = currentVal;
        if (this.kind === "csv") {
          if (this.codeDirty || !this.csvTable) {
            this.csvTable = parseCsvTable(currentVal, this.file.toLowerCase().endsWith(".tsv"));
            this.csvUniqueCache.clear();
            this.rebuildCsvViewRows();
          }
          if (this.codeDirty) {
            this.csvDirty = !this.fileTruncated && this.csvOriginalText !== null && currentVal !== this.csvOriginalText;
            this.codeDirty = false;
          }
        }
        this.code.release();
        this.code = null;
      }
      if (this.kind === "svg" && this.file && this.root) {
        this.invalidateStagedImage();
        const seq = ++this.loadSeq;
        const fullPath = `${this.root}/${this.file}`;
        const on = this.on;
        const svgOverride = this.rawText;
        this.loading = true;
        cx.spawn(async cx => {
          try {
            const staged = await stageImagePreview(fullPath, on, `${this.token}-${seq}`, svgOverride);
            if (this.loadSeq !== seq || !this.previewMode) {
              removePreviewFile(staged.relPath);
              return;
            }
            this.imageRelPath = staged.relPath;
            this.imageSizeBytes = staged.sizeBytes;
            this.imageAspect = staged.aspect || 1;
          } catch (e) {
            if (this.loadSeq === seq) this.error = String(e?.message || e);
          } finally {
            if (this.loadSeq === seq) {
              this.loading = false;
              cx.notify();
            }
          }
        });
      }
      this.publishMeta();
      return;
    }
    const seq = ++this.loadSeq;
    const file = this.file;
    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;
    const existingRaw = this.rawText;
    const isSvg = this.kind === "svg";
    cx.spawn(async cx => {
      try {
        await cx.sleep(0);
        if (this.loadSeq !== seq || this.previewMode) return;
        let content = existingRaw;
        if (content === null && isSvg && file && this.root) {
          const text = await readTextFile(fullPath, { on });
          if (this.loadSeq !== seq || text === null) return;
          this.fileTruncated = text.length > MAX_FILE_CHARS;
          content = this.fileTruncated ? text.slice(0, MAX_FILE_CHARS) + "\n… (truncated)" : text;
          this.originalContent = this.fileTruncated ? null : text;
          this.rawText = content;
        }
        if (this.loadSeq !== seq || this.previewMode || content === null) return;
        const ed = this.attachEditor(file, content);
        this.codeDirty = !this.fileTruncated && this.originalContent !== null && content !== this.originalContent;
        if (this.kind === "csv") this.csvDirty = false;
        this.publishMeta();
        if (this.highlightRange) ed.set_selected_range(this.highlightRange);
      } catch (e) {
        if (this.loadSeq === seq) this.error = String(e?.message || e);
      } finally {
        if (this.loadSeq === seq) cx.notify();
      }
    });
  }

  checkCommands(cx, fromRender = false) {
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
    if (!fromRender) cx.notify();
  }

  checkSharedTarget(cx, fromRender = false) {
    const req = shared("file-viewer.open");
    if (!req || !req.seq || req.seq === this.lastSharedSeq) return;
    const paneId = this.resolvePaneId();
    const targetedHere = Boolean(req.pane && paneId && req.pane === paneId);
    if (this.solo && !((req.jumpOnly || req.replace) && targetedHere)) return;
    if (this.tabId && req.tab && req.tab !== this.tabId) return;
    if (req.pane && paneId && req.pane !== paneId) return;
    this.lastSharedSeq = req.seq;
    this.openTarget(req, cx, fromRender);
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

  openTarget(target, cx, fromRender = false) {
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
      if (!fromRender) cx.notify();
      return;
    }

    this.releaseBuffers();
    this.highlightRange = null;
    const editFirst = Boolean(target.editFirst ?? shared("editor.mode")?.enabled);
    this.previewMode = this.kind === "code" ? false : (this.supportsRawToggle() ? !editFirst : true);
    this.loading = true;
    this.publishMeta();

    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;
    const kind = this.kind;

    cx.spawn(async cx => {
      try {
        if (kind === "image" || (kind === "svg" && this.previewMode)) {
          const staged = await stageImagePreview(fullPath, on, `${this.token}-${seq}`);
          if (this.loadSeq !== seq) {
            removePreviewFile(staged.relPath);
            return;
          }
          this.imageRelPath = staged.relPath;
          this.imageSizeBytes = staged.sizeBytes;
          this.imageAspect = staged.aspect || 1;
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
        this.fileTruncated = text.length > MAX_FILE_CHARS;
        const content = this.fileTruncated
          ? text.slice(0, MAX_FILE_CHARS) + "\n… (file truncated at 250 KB to save RAM)"
          : text;
        this.originalContent = this.fileTruncated ? null : text;
        this.lineStarts = buildLineStarts(content);
        this.textLen = content.length;

        const range = target.line
          ? offsetFromLineStarts(this.lineStarts, this.textLen, target.line, target.col, target.matchLen)
          : null;
        this.highlightRange = range && range.end > range.start ? range : null;

        if (kind === "csv" && this.previewMode) {
          this.rawText = content;
          this.csvOriginalText = text;
          this.csvTable = parseCsvTable(content, this.file.toLowerCase().endsWith(".tsv"));
          this.csvFilter = "";
          this.csvFilterInput?.set_value("");
          this.csvMenuQuery = "";
          this.csvMenuInput?.set_value("");
          this.csvCellInput?.set_value("");
          this.csvColFilters = new Map();
          this.csvUniqueCache.clear();
          this.csvFilterMenuCol = -1;
          this.csvSortCol = -1;
          this.csvSortDir = 0;
          this.csvSelected = null;
          this.csvEditedCells = new Set();
          this.csvDirty = false;
          this.csvSaveError = null;
          this.rebuildCsvViewRows();
          this.code = null;
        } else if (kind === "markdown" && this.previewMode) {
          this.rawText = content;
          this.code = null;
        } else {
          if (kind === "csv") this.csvOriginalText = text;
          const ed = this.attachEditor(this.file, content);
          if (range) ed.set_selected_range(range);
          this.rawText = this.supportsRawToggle() ? content : null;
          if (editFirst && this.isPaneVisible()) ed.focus();
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
    const base = Math.round(Math.max(160, Math.min(1800, 460 * zoomScale)));
    const aspect = Math.max(0.2, Math.min(5, this.imageAspect || 1));
    const imgW = aspect >= 1 ? base : Math.round(base * aspect);
    const imgH = aspect >= 1 ? Math.round(base / aspect) : base;
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
          .child(this.kind === "svg" ? "SVG Preview (1024px vector)" : "Image Preview")
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
              .child(image(this.imageRelPath).w(imgW).h(imgH)),
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

  findCsvColIndex(token) {
    const tbl = this.csvTable;
    if (!tbl || !token) return -1;
    const clean = token.replace(/^@/, "").trim().toLowerCase();
    if (!clean) return -1;
    for (let c = 0; c < tbl.colCount; c++) {
      if (columnLetter(c).toLowerCase() === clean || (tbl.headers[c] || "").toLowerCase() === clean) {
        return c;
      }
    }
    return -1;
  }

  splitQuoted(str, separator) {
    const out = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (quote) {
        if (ch === quote) quote = null;
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      const isSep = separator === "space" ? /\s/.test(ch) : ch === separator;
      if (isSep) {
        if (cur) out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  stripQuotes(s) {
    const t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      return t.slice(1, -1);
    }
    return t.replace(/^["']|["']$/g, "");
  }

  formatTokenVal(valStr) {
    const s = String(valStr ?? "");
    if (/[\s,"']/.test(s)) return `"${s.replace(/"/g, "'")}"`;
    return s;
  }

  parseCsvSearchTokens() {
    const raw = (this.csvFilter || "").trim();
    if (!raw) return { colRules: [], textTerms: [] };
    const colRules = [];
    const textTerms = [];
    const parts = this.splitQuoted(raw, "space");
    for (const part of parts) {
      const colon = part.indexOf(":");
      if (colon > 0 && !part.startsWith('"') && !part.startsWith("'")) {
        const colIdx = this.findCsvColIndex(part.slice(0, colon));
        if (colIdx >= 0) {
          const vals = this.splitQuoted(part.slice(colon + 1), ",")
            .map(v => this.stripQuotes(v).toLowerCase())
            .filter(Boolean);
          if (vals.length > 0) colRules.push({ colIdx, vals });
          continue;
        }
      }
      if (part.startsWith("@")) continue;
      const cleanTerm = this.stripQuotes(part).toLowerCase();
      if (cleanTerm) textTerms.push(cleanTerm);
    }
    return { colRules, textTerms };
  }

  getCsvAutocompleteState() {
    const tbl = this.csvTable;
    const raw = this.csvFilter || "";
    if (!tbl || !raw || /\s$/.test(raw)) return null;
    const parts = this.splitQuoted(raw, "space");
    const token = parts[parts.length - 1];
    if (!token) return null;
    const tokenStart = raw.length - token.length;
    const prefix = raw.slice(0, tokenStart);
    const colon = token.indexOf(":");

    if (colon === -1) {
      if (!token.startsWith("@")) return null;
      const needle = token.slice(1).toLowerCase();
      const cols = [];
      for (let c = 0; c < tbl.colCount; c++) {
        const letter = columnLetter(c);
        const header = tbl.headers[c] || letter;
        if (!needle || letter.toLowerCase().includes(needle) || header.toLowerCase().includes(needle)) {
          cols.push({ colIdx: c, letter, header });
        }
      }
      return { mode: "columns", prefix, cols: cols.slice(0, 12) };
    }

    const colToken = token.slice(0, colon);
    const colIdx = this.findCsvColIndex(colToken);
    if (colIdx < 0) return null;
    const rhs = token.slice(colon + 1);
    const segs = this.splitQuoted(rhs, ",");
    const trailingComma = rhs.endsWith(",");
    const currentPartial = trailingComma ? "" : this.stripQuotes(segs[segs.length - 1] || "").toLowerCase();
    const committedRaw = trailingComma ? segs : segs.slice(0, -1);
    const committed = committedRaw.map(s => this.stripQuotes(s)).filter(Boolean);
    const selectedLower = new Set(committed.map(s => s.toLowerCase()));
    const allVals = this.uniqueValuesForCol(colIdx);
    const values = allVals
      .filter(v => !currentPartial || v.value.toLowerCase().includes(currentPartial))
      .slice(0, 16);

    return {
      mode: "values",
      prefix,
      colIdx,
      colName: tbl.headers[colIdx] || columnLetter(colIdx),
      colToken: colToken.startsWith("@") ? colToken : `@${colToken}`,
      committed,
      selectedLower,
      values,
    };
  }

  applyColumnSuggestion(ac, col, cx) {
    const name = col.header.includes(" ") ? col.letter : col.header;
    const next = `${ac.prefix}@${name}:`;
    this.csvFilter = next;
    this.csvAcIndex = 0;
    this.csvFilterInput.set_value(next);
    this.rebuildCsvViewRows();
    cx.notify();
  }

  toggleValueSuggestion(ac, valStr, cx) {
    const lower = valStr.toLowerCase();
    const nextVals = [...ac.committed];
    const existingIdx = nextVals.findIndex(v => v.toLowerCase() === lower);
    if (existingIdx >= 0) nextVals.splice(existingIdx, 1);
    else nextVals.push(valStr);
    const formatted = nextVals.map(v => this.formatTokenVal(v)).join(",");
    const next = `${ac.prefix}${ac.colToken}:${formatted}`;
    this.csvFilter = next;
    this.csvAcIndex = 0;
    this.csvFilterInput.set_value(next);
    this.rebuildCsvViewRows();
    cx.notify();
  }

  cycleCsvSuggestion(delta, cx) {
    const ac = this.getCsvAutocompleteState();
    if (!ac) return false;
    const count = ac.mode === "columns" ? ac.cols.length : ac.values.length;
    if (count === 0) return false;
    this.csvAcIndex = ((this.csvAcIndex % count) + count + delta) % count;
    cx.notify();
    return true;
  }

  acceptSelectedCsvSuggestion(cx) {
    const ac = this.getCsvAutocompleteState();
    if (!ac) return false;
    if (ac.mode === "columns" && ac.cols.length > 0) {
      const idx = Math.max(0, Math.min(ac.cols.length - 1, this.csvAcIndex));
      this.applyColumnSuggestion(ac, ac.cols[idx], cx);
      return true;
    }
    if (ac.mode === "values" && ac.values.length > 0) {
      const idx = Math.max(0, Math.min(ac.values.length - 1, this.csvAcIndex));
      this.toggleValueSuggestion(ac, ac.values[idx].value, cx);
      return true;
    }
    return false;
  }

  renderCsvAutocompleteBar(t) {
    const ac = this.getCsvAutocompleteState();
    if (!ac) return null;

    if (ac.mode === "columns") {
      if (!ac.cols.length) return null;
      const activeIdx = Math.max(0, Math.min(ac.cols.length - 1, this.csvAcIndex));
      return h_flex()
        .id("fv-ac-cols")
        .h(36)
        .flex_none()
        .px(10)
        .pb(2)
        .gap(5)
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.accent)
        .overflow_x_scrollbar()
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Columns:"))
        .children(
          ac.cols.map((col, idx) => {
            const isActive = idx === activeIdx;
            return h_flex()
              .id(`fv-ac-col-${col.colIdx}`)
              .flex_none()
              .px(7)
              .py(2)
              .gap(4)
              .items_center()
              .rounded(5)
              .bg(isActive ? t.selected : t.raised)
              .border_1()
              .border_color(isActive ? t.accent : t.border)
              .cursor_pointer()
              .hover(s => s.bg(t.selected).border_color(t.accent))
              .on_click((_e, cx) => this.applyColumnSuggestion(ac, col, cx))
              .child(div().text_size(10).font_semibold().text_color(t.accent).child(col.letter))
              .child(div().text_size(11).text_color(t.foreground).child(col.header));
          }),
        )
        .child(div().flex_1())
        .child(div().flex_none().text_size(10).text_color(t.dim).child("Tab ↹ · Enter ↵"));
    }

    if (!ac.values.length) return null;
    const activeIdx = Math.max(0, Math.min(ac.values.length - 1, this.csvAcIndex));
    return h_flex()
      .id("fv-ac-vals")
      .h(36)
      .flex_none()
      .px(10)
      .pb(2)
      .gap(5)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.accent)
      .overflow_x_scrollbar()
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${ac.colName}:`))
      .children(
        ac.values.map((item, idx) => {
          const isPicked = ac.selectedLower.has(item.value.toLowerCase());
          const isActive = idx === activeIdx;
          return h_flex()
            .id(`fv-ac-val-${ac.colIdx}-${idx}`)
            .flex_none()
            .px(7)
            .py(2)
            .gap(4)
            .items_center()
            .rounded(5)
            .bg(isActive || isPicked ? t.selected : t.raised)
            .border_1()
            .border_color(isActive ? t.accent : isPicked ? t.accent + "88" : t.border)
            .cursor_pointer()
            .hover(s => s.bg(t.selected).border_color(t.accent))
            .on_click((_e, cx) => this.toggleValueSuggestion(ac, item.value, cx))
            .child(div().text_size(10.5).font_bold().text_color(isPicked ? t.accent : t.dim).child(isPicked ? "✓" : "+"))
            .child(div().text_size(11).text_color(t.foreground).child(item.value || "(empty)"))
            .child(div().text_size(10).text_color(t.dim).child(String(item.count)));
        }),
      )
      .child(div().flex_1())
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Tab ↹ · Enter ↵"));
  }

  rebuildCsvViewRows() {
    const tbl = this.csvTable;
    if (!tbl) {
      this.csvViewRows = [];
      return;
    }
    const { colRules, textTerms } = this.parseCsvSearchTokens();

    const items = [];
    for (let i = 0; i < tbl.dataRows.length; i++) {
      const row = tbl.dataRows[i];
      let blockedByCol = false;
      for (const [colIdx, allowedSet] of this.csvColFilters.entries()) {
        const cellVal = String(row[colIdx] ?? "");
        if (!allowedSet.has(cellVal)) {
          blockedByCol = true;
          break;
        }
      }
      if (blockedByCol) continue;

      for (const rule of colRules) {
        const cellLower = String(row[rule.colIdx] ?? "").toLowerCase();
        if (!rule.vals.some(v => cellLower.includes(v))) {
          blockedByCol = true;
          break;
        }
      }
      if (blockedByCol) continue;

      if (textTerms.length > 0) {
        let allTermsMatch = true;
        for (const term of textTerms) {
          let matched = false;
          for (let c = 0; c < tbl.colCount; c++) {
            if (String(row[c] ?? "").toLowerCase().includes(term)) {
              matched = true;
              break;
            }
          }
          if (!matched) {
            allTermsMatch = false;
            break;
          }
        }
        if (!allTermsMatch) continue;
      }
      items.push({ origIdx: i, row });
    }

    if (this.csvSortCol >= 0 && this.csvSortDir !== 0) {
      const col = this.csvSortCol;
      const dir = this.csvSortDir;
      items.sort((a, b) => {
        const av = String(a.row[col] ?? "").trim();
        const bv = String(b.row[col] ?? "").trim();
        const an = av !== "" ? Number(av) : NaN;
        const bn = bv !== "" ? Number(bv) : NaN;
        if (Number.isFinite(an) && Number.isFinite(bn)) {
          return (an - bn) * dir || a.origIdx - b.origIdx;
        }
        return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) * dir || a.origIdx - b.origIdx;
      });
    }

    this.csvViewRows = items;
    const maxPage = Math.max(0, Math.ceil(items.length / CSV_PAGE_SIZE) - 1);
    if (this.csvPage > maxPage) this.csvPage = maxPage;
  }

  toggleCsvSort(colIdx, cx) {
    if (this.csvSortCol !== colIdx) {
      this.csvSortCol = colIdx;
      this.csvSortDir = 1;
    } else if (this.csvSortDir === 1) {
      this.csvSortDir = -1;
    } else {
      this.csvSortCol = -1;
      this.csvSortDir = 0;
    }
    this.rebuildCsvViewRows();
    cx.notify();
  }

  selectCsvCell(origRowIdx, colIdx, cx) {
    if (!this.csvTable) return;
    this.csvSelected = { row: origRowIdx, col: colIdx };
    const val = this.csvTable.dataRows[origRowIdx]?.[colIdx] ?? "";
    this.csvCellInput.set_value(String(val));
    this.csvSaveError = null;
    cx.notify();
  }

  applyCellEdit(cx) {
    if (!this.csvTable || !this.csvSelected) return;
    const { row, col } = this.csvSelected;
    const targetRow = this.csvTable.dataRows[row];
    if (!targetRow) return;
    const nextVal = this.csvCellInput.value();
    const prevVal = String(targetRow[col] ?? "");
    if (nextVal === prevVal) return;
    while (targetRow.length <= col) targetRow.push("");
    targetRow[col] = nextVal;
    this.csvEditedCells.add(`${row}:${col}`);
    this.csvUniqueCache?.delete(col);
    this.csvDirty = true;
    this.csvSaveError = null;
    this.rawText = serializeCsvTable(this.csvTable);
    this.rebuildCsvViewRows();
    this.publishMeta();
    cx.notify();
  }

  discardCsvEdits(cx) {
    if (!this.csvOriginalText || !this.file) return;
    const content = this.csvOriginalText.length > MAX_FILE_CHARS
      ? this.csvOriginalText.slice(0, MAX_FILE_CHARS) + "\n… (file truncated at 250 KB to save RAM)"
      : this.csvOriginalText;
    this.originalContent = this.fileTruncated ? null : this.csvOriginalText;
    this.rawText = content;
    this.csvTable = parseCsvTable(content, this.file.toLowerCase().endsWith(".tsv"));
    this.csvEditedCells = new Set();
    this.csvUniqueCache?.clear();
    this.csvDirty = false;
    this.codeDirty = false;
    this.csvSaveError = null;
    if (this.csvSelected) {
      const { row, col } = this.csvSelected;
      this.csvCellInput.set_value(String(this.csvTable.dataRows[row]?.[col] ?? ""));
    }
    this.rebuildCsvViewRows();
    this.publishMeta();
    cx.notify();
  }

  saveCsvEdits(cx) {
    if (!this.csvTable || !this.csvDirty || this.csvSaving || !this.file || !this.root) return;
    if (this.csvTable.truncated) {
      this.csvSaveError = "Cannot overwrite truncated CSV (>5,000 rows)";
      cx.notify();
      return;
    }
    const serialized = serializeCsvTable(this.csvTable);
    const fullPath = `${this.root}/${this.file}`;
    const on = this.on;
    const expected = this.csvOriginalText;
    this.csvSaving = true;
    this.csvSaveError = null;
    cx.notify();

    cx.spawn(async cx => {
      try {
        await saveTextFile(fullPath, on, serialized, expected);
        this.csvOriginalText = serialized;
        this.originalContent = serialized;
        this.rawText = serialized;
        this.csvEditedCells = new Set();
        this.csvDirty = false;
        this.codeDirty = false;
        this.csvSaveError = null;
      } catch (e) {
        this.csvSaveError = String(e?.message || e || "Save failed");
      } finally {
        this.csvSaving = false;
        this.publishMeta();
        cx.notify();
      }
    });
  }

  uniqueValuesForCol(colIdx) {
    if (!this.csvTable) return [];
    const cached = this.csvUniqueCache.get(colIdx);
    if (cached) return cached;
    const rows = this.csvTable.dataRows;
    const scanLimit = Math.min(rows.length, MAX_UNIQUE_SCAN_ROWS);
    const counts = new Map();
    for (let i = 0; i < scanLimit; i++) {
      const v = String(rows[i][colIdx] ?? "");
      const prev = counts.get(v);
      if (prev !== undefined) {
        counts.set(v, prev + 1);
      } else if (counts.size < MAX_UNIQUE_SUGGESTIONS) {
        counts.set(v, 1);
      }
    }
    const result = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }))
      .map(([value, count]) => ({ value, count }));
    if (this.csvUniqueCache.size >= 8) {
      this.csvUniqueCache.delete(this.csvUniqueCache.keys().next().value);
    }
    this.csvUniqueCache.set(colIdx, result);
    return result;
  }

  openColFilterMenu(colIdx, cx) {
    if (this.csvFilterMenuCol === colIdx) {
      this.csvFilterMenuCol = -1;
      cx.notify();
      return;
    }
    this.csvFilterMenuCol = colIdx;
    this.csvMenuQuery = "";
    this.csvMenuInput.set_value("");
    cx.notify();
  }

  toggleColFilterValue(colIdx, value, allValues, cx) {
    let set = this.csvColFilters.get(colIdx);
    if (!set) {
      set = new Set(allValues.map(v => v.value));
    } else {
      set = new Set(set);
    }
    if (set.has(value)) set.delete(value);
    else set.add(value);

    if (set.size >= allValues.length) this.csvColFilters.delete(colIdx);
    else this.csvColFilters.set(colIdx, set);

    this.rebuildCsvViewRows();
    cx.notify();
  }

  renderCsvFilterDropdown(t) {
    const colIdx = this.csvFilterMenuCol;
    if (colIdx < 0 || !this.csvTable) return null;
    const allValues = this.uniqueValuesForCol(colIdx);
    const q = (this.csvMenuQuery || "").trim().toLowerCase();
    const visibleValues = q
      ? allValues.filter(v => v.value.toLowerCase().includes(q))
      : allValues;
    const activeSet = this.csvColFilters.get(colIdx);
    const selectedCount = activeSet ? activeSet.size : allValues.length;
    const colTitle = `${columnLetter(colIdx)} ${this.csvTable.headers[colIdx] || ""}`.trim();

    return v_flex()
      .flex_none()
      .max_h(220)
      .px(10)
      .py(8)
      .gap(6)
      .bg(t.surface)
      .border_b(1)
      .border_color(t.accent)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(`Filter: ${colTitle}`))
          .child(div().text_size(11).text_color(t.dim).child(`(${selectedCount}/${allValues.length})`))
          .child(div().flex_1())
          .child(
            div()
              .id("fv-fmenu-all")
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.raised)
              .text_size(10.5)
              .text_color(t.foreground)
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => {
                if (q) {
                  const next = new Set(activeSet ? [...activeSet] : []);
                  for (const item of visibleValues) next.add(item.value);
                  if (next.size >= allValues.length) this.csvColFilters.delete(colIdx);
                  else this.csvColFilters.set(colIdx, next);
                } else {
                  this.csvColFilters.delete(colIdx);
                }
                this.rebuildCsvViewRows();
                cx.notify();
              })
              .child(q ? "Select matches" : "Select all"),
          )
          .child(
            div()
              .id("fv-fmenu-none")
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.raised)
              .text_size(10.5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.csvColFilters.set(colIdx, new Set());
                this.rebuildCsvViewRows();
                cx.notify();
              })
              .child("Clear"),
          )
          .child(
            div()
              .id("fv-fmenu-close")
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.solid)
              .text_size(10.5)
              .font_semibold()
              .text_color(t.solid_foreground)
              .cursor_pointer()
              .on_click((_e, cx) => {
                this.csvFilterMenuCol = -1;
                cx.notify();
              })
              .child("Done"),
          ),
      )
      .child(
        h_flex()
          .h(24)
          .px(7)
          .items_center()
          .rounded(5)
          .bg(t.background)
          .border_1()
          .border_color(t.border)
          .child(Input.new(this.csvMenuInput).flex_1().h_full().text_size(11.5).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("fv-fmenu-list")
          .flex_1()
          .min_h(48)
          .max_h(132)
          .overflow_y_scrollbar()
          .gap(1)
          .children(
            visibleValues.slice(0, 120).map((item, idx) => {
              const checked = !activeSet || activeSet.has(item.value);
              return h_flex()
                .id(`fv-fval-${colIdx}-${idx}`)
                .h(22)
                .flex_none()
                .px(6)
                .gap(7)
                .items_center()
                .rounded(4)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => this.toggleColFilterValue(colIdx, item.value, allValues, cx))
                .child(div().w(14).text_size(11).font_bold().text_color(checked ? t.accent : t.dim).child(checked ? "☑" : "☐"))
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(checked ? t.foreground : t.dim).child(item.value || "(empty)"))
                .child(div().text_size(10.5).text_color(t.dim).child(String(item.count)));
            }),
          )
          .when(visibleValues.length === 0, el =>
            el.child(div().p(6).text_size(11).text_color(t.dim).child("No matching values")),
          ),
      );
  }

  renderCsvBody(t, fontSize) {
    const tbl = this.csvTable;
    if (tbl && this.csvViewRows.length === 0 && !this.csvFilter && this.csvColFilters.size === 0 && tbl.dataRows.length > 0) {
      this.rebuildCsvViewRows();
    }
    const viewRows = this.csvViewRows;
    const rowH = Math.ceil(fontSize * 1.9);
    const gutterW = 46;
    const totalW = gutterW + tbl.colWidths.reduce((s, w) => s + w, 0) + 16;
    const cellRef = this.csvSelected ? `${columnLetter(this.csvSelected.col)}${this.csvSelected.row + 1}` : "—";
    const hasAnyFilter = Boolean(this.csvFilter) || this.csvColFilters.size > 0;

    const headerCells = [
      div().w(gutterW).h_full().flex_none().px(6).flex().items_center().justify_end().border_r(1).border_color(t.border).text_size(10.5).text_color(t.dim).child("#"),
      ...tbl.colWidths.map((w, idx) => {
        const isSorted = this.csvSortCol === idx && this.csvSortDir !== 0;
        const sortGlyph = !isSorted ? "" : this.csvSortDir === 1 ? "▲" : "▼";
        const isFiltered = this.csvColFilters.has(idx);
        const isMenuOpen = this.csvFilterMenuCol === idx;
        return h_flex()
          .w(w)
          .h_full()
          .flex_none()
          .pl(7)
          .gap(2)
          .items_center()
          .when(isSorted || isMenuOpen, el => el.bg(t.selected))
          .child(
            h_flex()
              .id(`fv-csv-hdr-${idx}`)
              .flex_1()
              .min_w(0)
              .h_full()
              .gap(4)
              .items_center()
              .cursor_pointer()
              .tooltip(`Click to sort by ${columnLetter(idx)} (${tbl.headers[idx] || ""})`)
              .on_click((_e, cx) => this.toggleCsvSort(idx, cx))
              .child(div().text_size(9.5).font_semibold().text_color(t.accent).child(columnLetter(idx)))
              .child(div().flex_1().min_w(0).truncate().text_size(Math.max(10, fontSize - 1.5)).font_semibold().text_color(t.foreground).child(tbl.headers[idx] ?? ""))
              .when(Boolean(sortGlyph), el => el.child(div().text_size(9.5).font_bold().text_color(t.accent).child(sortGlyph))),
          )
          .child(
            div()
              .id(`fv-csv-flt-${idx}`)
              .px(4)
              .py(1)
              .rounded(4)
              .cursor_pointer()
              .text_size(10)
              .when(isFiltered || isMenuOpen, el => el.bg(t.accent + "30"))
              .text_color(isFiltered || isMenuOpen ? t.accent : t.dim)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip(`Filter values in ${tbl.headers[idx] || columnLetter(idx)}`)
              .on_click((_e, cx) => this.openColFilterMenu(idx, cx))
              .child("▾"),
          )
          .child(
            div()
              .id(`fv-csv-col-res-${idx}`)
              .w(6)
              .h_full()
              .flex_none()
              .cursor_col_resize()
              .flex()
              .items_center()
              .justify_end()
              .hover(s => s.bg(t.accent + "44"))
              .when(this.resizingCol?.idx === idx, el => el.bg(t.accent + "66"))
              .tooltip("Drag left/right to resize column")
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.resizingCol = { idx, startX: e.position?.x ?? 0, startW: tbl.colWidths[idx] };
                cx.notify();
              })
              .child(div().w(1).h_full().bg(this.resizingCol?.idx === idx ? t.accent : t.border)),
          );
      }),
    ];

    const renderDataRow = (item, visIdx) =>
      h_flex()
        .w_full()
        .h(rowH)
        .flex_none()
        .border_b(1)
        .border_color(t.border)
        .when(visIdx % 2 === 1, el => el.bg(t.surface + "66"))
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
            .child(String(item.origIdx + 1)),
        )
        .children(
          tbl.colWidths.map((w, c) => {
            const isSel = this.csvSelected?.row === item.origIdx && this.csvSelected?.col === c;
            const isEdited = this.csvEditedCells.has(`${item.origIdx}:${c}`);
            return div()
              .id(`fv-csv-c-${item.origIdx}-${c}`)
              .w(w)
              .h_full()
              .flex_none()
              .px(8)
              .flex()
              .items_center()
              .cursor_pointer()
              .border_r(1)
              .border_color(isSel ? t.accent : t.border)
              .when(isSel, el => el.bg(t.selected))
              .when(!isSel && isEdited, el => el.bg(t.blocked + "22"))
              .hover(s => s.bg(isSel ? t.selected : t.hover))
              .on_click((_e, cx) => this.selectCsvCell(item.origIdx, c, cx))
              .child(div().w_full().truncate().text_size(Math.max(10, fontSize - 1)).text_color(isEdited ? t.blocked : t.foreground).child(item.row[c] ?? ""));
          }),
        );

    const filterDropdown = this.renderCsvFilterDropdown(t);
    const autocompleteBar = this.renderCsvAutocompleteBar(t);

    const totalPages = Math.max(1, Math.ceil(viewRows.length / CSV_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(totalPages - 1, this.csvPage || 0));
    const pageStart = safePage * CSV_PAGE_SIZE;
    const pageRows = viewRows.slice(pageStart, pageStart + CSV_PAGE_SIZE);

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .id("fv-csv-filter-box")
              .flex_1()
              .min_w(160)
              .h(24)
              .px(7)
              .gap(4)
              .items_center()
              .rounded(5)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .on_key_down((e, cx) => {
                if (e.key === "tab") {
                  if (this.cycleCsvSuggestion(e.modifiers?.shift ? -1 : 1, cx)) {
                    cx.stop_propagation();
                  }
                } else if (e.key === "enter") {
                  if (this.acceptSelectedCsvSuggestion(cx)) {
                    cx.stop_propagation();
                  }
                }
              })
              .child(Input.new(this.csvFilterInput).flex_1().h_full().text_size(11.5).text_color(t.foreground))
              .when(Boolean(this.csvFilter), el =>
                el.child(
                  div()
                    .id("fv-csv-filter-clear")
                    .px(3)
                    .rounded(4)
                    .text_size(11)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.csvFilter = "";
                      this.csvFilterInput.set_value("");
                      this.rebuildCsvViewRows();
                      cx.notify();
                    })
                    .child("×"),
                ),
              ),
          )
          .child(
            div()
              .flex_none()
              .text_size(11)
              .text_color(t.dim)
              .child(
                hasAnyFilter
                  ? `${viewRows.length} / ${tbl.dataRows.length} rows`
                  : `${tbl.dataRows.length}${tbl.truncated ? "+" : ""} rows × ${tbl.colCount} cols`,
              ),
          )
          .when(totalPages > 1, el =>
            el
              .child(
                div()
                  .id("fv-csv-pg-prev")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg(t.raised)
                  .text_size(10.5)
                  .text_color(safePage > 0 ? t.foreground : t.dim)
                  .when(safePage > 0, b => b.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.csvPage = safePage - 1; cx.notify(); }))
                  .child("←"),
              )
              .child(div().text_size(10.5).text_color(t.dim).child(`${safePage + 1}/${totalPages}`))
              .child(
                div()
                  .id("fv-csv-pg-next")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg(t.raised)
                  .text_size(10.5)
                  .text_color(safePage + 1 < totalPages ? t.foreground : t.dim)
                  .when(safePage + 1 < totalPages, b => b.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.csvPage = safePage + 1; cx.notify(); }))
                  .child("→"),
              ),
          )
          .when(this.csvColFilters.size > 0, el =>
            el.child(
              div()
                .id("fv-csv-clear-col-filters")
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.accent + "26")
                .text_size(10.5)
                .font_semibold()
                .text_color(t.accent)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.csvColFilters.clear();
                  this.csvFilterMenuCol = -1;
                  this.rebuildCsvViewRows();
                  cx.notify();
                })
                .child(`${this.csvColFilters.size} filter${this.csvColFilters.size === 1 ? "" : "s"} ×`),
            ),
          )
          .when(this.csvDirty, el =>
            el
              .child(
                div()
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .bg(t.blocked + "26")
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.blocked)
                  .child(`* ${this.csvEditedCells.size} edit${this.csvEditedCells.size === 1 ? "" : "s"}`),
              )
              .child(
                div()
                  .id("fv-csv-discard")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.discardCsvEdits(cx))
                  .child("↺ Discard"),
              )
              .child(
                div()
                  .id("fv-csv-save")
                  .px(8)
                  .py(2)
                  .rounded(5)
                  .bg(t.solid)
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.solid_foreground)
                  .cursor_pointer()
                  .on_click((_e, cx) => this.saveCsvEdits(cx))
                  .child(this.csvSaving ? "Saving…" : "✓ Save"),
              ),
          ),
      )
      .when(Boolean(autocompleteBar), el => el.child(autocompleteBar))
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .bg(t.background)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .min_w(36)
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.surface)
              .text_center()
              .text_size(11)
              .font_semibold()
              .text_color(this.csvSelected ? t.accent : t.dim)
              .child(cellRef),
          )
          .child(
            h_flex()
              .flex_1()
              .h(23)
              .px(7)
              .items_center()
              .rounded(5)
              .bg(t.surface)
              .border_1()
              .border_color(this.csvSelected ? t.accent : t.border)
              .child(Input.new(this.csvCellInput).flex_1().h_full().text_size(11.5).text_color(t.foreground)),
          )
          .when(Boolean(this.csvSelected), el =>
            el.child(
              div()
                .id("fv-csv-apply")
                .px(7)
                .py(2)
                .rounded(5)
                .bg(t.raised)
                .text_size(11)
                .font_semibold()
                .text_color(t.foreground)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => this.applyCellEdit(cx))
                .child("Apply"),
            ),
          )
          .when(Boolean(this.csvSaveError), el =>
            el.child(div().text_size(11).text_color(t.ansi1).child(this.csvSaveError)),
          ),
      )
      .when(Boolean(filterDropdown), el => el.child(filterDropdown))
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .child(
            div()
              .id("fv-csv-x")
              .absolute()
              .inset_0()
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
                    v_flex()
                      .id("fv-csv-rows")
                      .flex_1()
                      .min_h(0)
                      .overflow_y_scrollbar()
                      .children(pageRows.map((item, offset) => renderDataRow(item, pageStart + offset)))
                      .when(pageRows.length === 0, el =>
                        el.child(div().p(12).text_size(12).text_color(t.dim).child("No matching rows")),
                      ),
                  ),
              ),
          ),
      );
  }

  render(cx) {
    if (!checking()) {
      this.checkSharedTarget(cx, true);
      this.checkCommands(cx, true);
      this.checkHibernation(cx, true);
      this.publishMeta();
    }
    const t = theme();
    const font = settings();
    const fontFamily = font.font_family ?? font.font;
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
      body = v_flex()
        .flex_1()
        .min_h(0)
        .when(this.codeDirty || Boolean(this.codeSaveError), el =>
          el.child(
            h_flex()
              .h(30)
              .flex_none()
              .px(10)
              .gap(8)
              .items_center()
              .bg(t.surface)
              .border_b(1)
              .border_color(t.border)
              .child(
                div()
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .bg(t.blocked + "26")
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.blocked)
                  .child("* Unsaved changes"),
              )
              .when(Boolean(this.codeSaveError), err =>
                err.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi1).child(this.codeSaveError)),
              )
              .when(!this.codeSaveError, sp => sp.child(div().flex_1()))
              .child(
                div()
                  .id("fv-code-discard")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.discardCodeEdits(cx))
                  .child("↺ Discard"),
              )
              .child(
                div()
                  .id("fv-code-save")
                  .px(8)
                  .py(2)
                  .rounded(5)
                  .bg(t.solid)
                  .text_size(11)
                  .font_semibold()
                  .text_color(t.solid_foreground)
                  .cursor_pointer()
                  .on_click((_e, cx) => this.saveCodeEdits(cx))
                  .child(this.codeSaving ? "Saving…" : "✓ Save (Ctrl+S)"),
              ),
          ),
        )
        .child(Editor.new(this.code).font_family(font.font_family).text_size(fontSize).flex_1().min_h(0));
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
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .track_focus(this.handle)
      .on_window_mouse_move((e, cx) => {
        if (!this.resizingCol || !this.csvTable) return;
        if (e.pressed_button !== "left") {
          this.resizingCol = null;
          cx.notify();
          return;
        }
        const z = settings().zoom || 1;
        const dx = ((e.position?.x ?? 0) - this.resizingCol.startX) / z;
        this.csvTable.colWidths[this.resizingCol.idx] = Math.round(Math.max(56, Math.min(640, this.resizingCol.startW + dx)));
        cx.notify();
      })
      .on_window_mouse_up("left", (_e, cx) => {
        if (!this.resizingCol) return;
        this.resizingCol = null;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if ((e.modifiers?.control || e.modifiers?.platform) && e.key?.toLowerCase() === "s") {
          if (this.kind === "csv" && this.previewMode && this.csvDirty) {
            cx.stop_propagation();
            this.saveCsvEdits(cx);
          } else if (this.code && this.codeDirty) {
            cx.stop_propagation();
            this.saveCodeEdits(cx);
          }
        }
      })
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
