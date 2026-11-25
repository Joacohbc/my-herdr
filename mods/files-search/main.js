// A lazy file browser for the focused pane's folder, with VS Code-style search and read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, checking, run, shared, setShared } from "herdr";
import { searchContent, searchFiles, MAX_MATCHES } from "./search.js";
import { fileIcon, folderIcon } from "./material-icons.js";

const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25);
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue;
    return scan;
  }
  return null;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const fallbackTermPane = pane && !pane.cwd && f?.tab
    ? allPanes.find(p => p.tab === f.tab && p.cwd)
    : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || fallbackTermPane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;
const DEBOUNCE_MS = 180;

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class FilesSearch extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};

    this.query = "";
    this.searchMode = "content";
    this.caseSensitive = false;
    this.wholeWord = false;
    this.useRegex = false;
    this.useDefaultExcludes = true;
    this.showFilters = false;
    this.searchFocused = false;
    this.includeGlob = "";
    this.excludeGlob = "";

    this.searchSeq = 0;
    this.searching = false;
    this.searchError = null;
    this.searchGroups = [];
    this.searchTotal = 0;
    this.searchLimited = false;
    this.collapsedResults = new Set();
    this.fileResults = [];
    this.fileResultsLimited = false;

    this.searchInput = InputState.new({ placeholder: "Search in files…" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      this.scheduleSearch(cx);
      cx.notify();
    });
    this.searchInput.on("submit", (_e, cx) => {
      this.scheduleSearch(cx, true);
      cx.notify();
    });
    this.searchInput.on("focus", (_e, cx) => {
      this.searchFocused = true;
      cx.notify();
    });
    this.searchInput.on("blur", (_e, cx) => {
      this.searchFocused = false;
      cx.notify();
    });

    this.includeInput = InputState.new({ placeholder: "Include: *.ts, src/**" });
    this.includeInput.on("change", (_e, cx) => {
      this.includeGlob = this.includeInput.value();
      this.scheduleSearch(cx);
      cx.notify();
    });
    this.includeInput.on("submit", (_e, cx) => {
      this.scheduleSearch(cx, true);
      cx.notify();
    });

    this.excludeInput = InputState.new({ placeholder: "Extra exclude: *.test.ts, docs" });
    this.excludeInput.on("change", (_e, cx) => {
      this.excludeGlob = this.excludeInput.value();
      this.scheduleSearch(cx);
      cx.notify();
    });
    this.excludeInput.on("submit", (_e, cx) => {
      this.scheduleSearch(cx, true);
      cx.notify();
    });

    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
  }

  close() {
    this.context?.watch?.pending?.cancel();
    this.searchInput?.release();
    this.includeInput?.release();
    this.excludeInput?.release();
  }

  scheduleSearch(cx, immediate = false) {
    const seq = ++this.searchSeq;
    const trimmed = this.query.trim();
    if (!trimmed) {
      this.searching = false;
      this.searchError = null;
      this.searchGroups = [];
      this.searchTotal = 0;
      this.searchLimited = false;
      this.fileResults = [];
      this.fileResultsLimited = false;
      return;
    }

    const context = this.context;
    if (!context?.cwd) return;

    this.searching = true;
    this.searchError = null;
    const opts = {
      query: this.query,
      caseSensitive: this.caseSensitive,
      wholeWord: this.wholeWord,
      regex: this.useRegex,
      useDefaultExcludes: this.useDefaultExcludes,
      include: this.includeGlob,
      exclude: this.excludeGlob,
    };
    const mode = this.searchMode;

    cx.spawn(async cx => {
      if (!immediate) await cx.sleep(DEBOUNCE_MS);
      if (this.searchSeq !== seq || !this.current(context)) return;

      try {
        if (mode === "content") {
          const res = await searchContent(context.cwd, context.on, opts);
          if (this.searchSeq !== seq || !this.current(context)) return;
          this.searchGroups = res.groups;
          this.searchTotal = res.totalMatches;
          this.searchLimited = res.limited;
          this.collapsedResults = new Set();
        } else {
          const res = await searchFiles(context.cwd, context.on, opts);
          if (this.searchSeq !== seq || !this.current(context)) return;
          this.fileResults = res.files;
          this.fileResultsLimited = res.limited;
        }
        this.searchError = null;
      } catch (e) {
        if (this.searchSeq !== seq || !this.current(context)) return;
        this.searchError = String(e.message || e);
        this.searchGroups = [];
        this.searchTotal = 0;
        this.searchLimited = false;
        this.fileResults = [];
        this.fileResultsLimited = false;
      } finally {
        if (this.searchSeq === seq && this.current(context)) {
          this.searching = false;
          cx.notify();
        }
      }
    });
  }

  clearSearch(cx) {
    this.query = "";
    this.searchInput.set_value("");
    this.scheduleSearch(cx);
    cx.notify();
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async cx => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, dirtyAt: 0 };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.error = null;
      this.limited = false;
      this.loading = false;
      if (this.query.trim()) this.scheduleSearch(cx, true);
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks;
        this.error = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, locationTarget = null, event = null) {
    if (!path || !this.root) return;
    const f = focused();
    const tabId = f?.tab ?? null;
    const openInNewTab = Boolean(event?.modifiers?.control || event?.modifiers?.platform);
    const forceNewPane = Boolean(event?.modifiers?.shift);

    const fileName = path.split(/[\\/]/).pop() || path;
    const payload = {
      file: path,
      root: this.root,
      on: this.on ?? null,
      tab: tabId,
      line: locationTarget?.line ?? null,
      col: locationTarget?.col ?? null,
      matchLen: locationTarget?.matchLen ?? null,
    };

    if (openInNewTab) {
      const res = run("tab.new", {
        name: fileName,
        mod: "file-viewer",
        props: { ...payload, tab: null, solo: true },
      });
      if (res?.pane) {
        run("pane.rename", { pane: res.pane, name: fileName });
      }
      return;
    }

    const existing = !forceNewPane && tabId
      ? panes().find(p => p.tab === tabId && p.mod === "file-viewer")
      : null;

    if (existing) {
      const prevSeq = shared("file-viewer.open")?.seq ?? 0;
      setShared("file-viewer.open", { ...payload, pane: existing.pane, seq: prevSeq + 1 });
      run("pane.focus", { pane: existing.pane });
      run("pane.rename", { pane: existing.pane, name: fileName });
      return;
    }

    const res = run("pane.split", {
      direction: "right",
      mod: "file-viewer",
      props: payload,
    });
    if (res?.pane) {
      run("pane.rename", { pane: res.pane, name: fileName });
    }
  }

  toggleChip(id, label, active, onClick, t) {
    return div()
      .id(id)
      .px(5)
      .py(2)
      .rounded(5)
      .text_size(11)
      .font_semibold()
      .cursor_pointer()
      .when(active, el => el.bg(t.selected))
      .text_color(active ? t.accent : t.dim)
      .hover(s => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
      .on_click(onClick)
      .child(label);
  }

  renderSearchBar(t) {
    const hasQuery = this.query.trim().length > 0;
    const showToolbar = hasQuery || this.showFilters || this.searchFocused;
    const allCollapsed = this.searchGroups.length > 0 && this.collapsedResults.size === this.searchGroups.length;

    const statusText = this.searching
      ? "Searching…"
      : this.searchMode === "content"
        ? hasQuery
          ? `${this.searchTotal}${this.searchLimited ? "+" : ""} in ${this.searchGroups.length} file${this.searchGroups.length === 1 ? "" : "s"}`
          : ""
        : hasQuery
          ? `${this.fileResults.length}${this.fileResultsLimited ? "+" : ""} file${this.fileResults.length === 1 ? "" : "s"}`
          : "";

    return v_flex()
      .flex_none()
      .px(8)
      .py(7)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(30)
          .px(8)
          .gap(4)
          .items_center()
          .rounded(7)
          .bg(t.surface)
          .border_1()
          .border_color(this.searchFocused ? t.accent : t.border)
          .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(this.searchFocused ? t.accent : t.dim))
          .child(Input.new(this.searchInput).flex_1().h_full().text_size(12.5).text_color(t.foreground))
          .when(Boolean(this.query), el =>
            el.child(
              div()
                .id("files-search-clear")
                .px(4)
                .py(1)
                .rounded(4)
                .text_size(12)
                .text_color(t.dim)
                .cursor_pointer()
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.clearSearch(cx))
                .child("×"),
            ),
          )
          .child(this.toggleChip("opt-case", "Aa", this.caseSensitive, (_e, cx) => {
            this.caseSensitive = !this.caseSensitive;
            this.scheduleSearch(cx, true);
            cx.notify();
          }, t))
          .when(this.searchMode === "content", el =>
            el.child(this.toggleChip("opt-word", "ab", this.wholeWord, (_e, cx) => {
              this.wholeWord = !this.wholeWord;
              this.scheduleSearch(cx, true);
              cx.notify();
            }, t)),
          )
          .child(this.toggleChip("opt-regex", ".*", this.useRegex, (_e, cx) => {
            this.useRegex = !this.useRegex;
            this.scheduleSearch(cx, true);
            cx.notify();
          }, t))
          .child(this.toggleChip("opt-filters", "⋯", this.showFilters, (_e, cx) => {
            this.showFilters = !this.showFilters;
            cx.notify();
          }, t)),
      )
      .when(showToolbar, el =>
        el.child(
          h_flex()
            .items_center()
            .gap(4)
            .child(this.toggleChip("mode-content", "Text", this.searchMode === "content", (_e, cx) => {
              if (this.searchMode === "content") return;
              this.searchMode = "content";
              this.scheduleSearch(cx, true);
              cx.notify();
            }, t))
            .child(this.toggleChip("mode-files", "Files", this.searchMode === "files", (_e, cx) => {
              if (this.searchMode === "files") return;
              this.searchMode = "files";
              this.scheduleSearch(cx, true);
              cx.notify();
            }, t))
            .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(statusText))
            .when(this.searchMode === "content" && this.searchGroups.length > 0, row =>
              row.child(
                div()
                  .id("toggle-all-results")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .text_size(11)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    if (allCollapsed) this.collapsedResults = new Set();
                    else this.collapsedResults = new Set(this.searchGroups.map(g => g.path));
                    cx.notify();
                  })
                  .child(allCollapsed ? "Expand" : "Collapse"),
              ),
            ),
        ),
      )
      .when(this.showFilters, el =>
        el.child(
          v_flex()
            .gap(5)
            .pt(2)
            .child(
              h_flex()
                .h(26)
                .px(7)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .child(Input.new(this.includeInput).flex_1().h_full().text_size(11.5).text_color(t.foreground)),
            )
            .child(
              h_flex()
                .h(26)
                .px(7)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .child(Input.new(this.excludeInput).flex_1().h_full().text_size(11.5).text_color(t.foreground)),
            )
            .child(
              h_flex()
                .id("opt-default-excludes")
                .px(6)
                .py(3)
                .gap(6)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.useDefaultExcludes = !this.useDefaultExcludes;
                  this.scheduleSearch(cx, true);
                  cx.notify();
                })
                .child(
                  div()
                    .w(12)
                    .text_size(11)
                    .font_bold()
                    .text_color(this.useDefaultExcludes ? t.ansi2 : t.dim)
                    .child(this.useDefaultExcludes ? "✓" : "○"),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .text_color(this.useDefaultExcludes ? t.muted : t.dim)
                    .child("Exclude node_modules, target, dist, .gitignore"),
                ),
            ),
        ),
      );
  }

  renderContentResults(t) {
    if (this.searchError) {
      return v_flex().p(10).child(div().text_size(12).text_color(t.ansi1).child(this.searchError));
    }
    if (this.searching && !this.searchGroups.length) {
      return v_flex().p(10).child(div().text_size(12).text_color(t.dim).child("Searching…"));
    }
    if (!this.searchGroups.length) {
      return v_flex().p(10).child(div().text_size(12).text_color(t.dim).child("No results found"));
    }

    const out = [];
    for (const group of this.searchGroups) {
      const collapsed = this.collapsedResults.has(group.path);
      out.push(
        h_flex()
          .id(`sr-file-${group.path}`)
          .h(26)
          .flex_none()
          .px(6)
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (collapsed) this.collapsedResults.delete(group.path);
            else this.collapsedResults.add(group.path);
            cx.notify();
          })
          .child(svg(`mods/files-search/chevron-${collapsed ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
          .child(image(fileIcon(group.name)).w(15).h(15).flex_none())
          .child(div().font_semibold().text_size(12.5).text_color(t.foreground).child(group.name))
          .when(Boolean(group.dir), el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(group.dir)))
          .when(!group.dir, el => el.child(div().flex_1()))
          .child(
            div()
              .px(5)
              .py(1)
              .rounded(999)
              .bg(t.surface)
              .text_size(10.5)
              .text_color(t.muted)
              .child(String(group.matches.length)),
          ),
      );

      if (!collapsed) {
        for (let idx = 0; idx < group.matches.length; idx++) {
          const m = group.matches[idx];
          out.push(
            h_flex()
              .id(`sr-m-${group.path}-${m.line}-${idx}`)
              .h(24)
              .flex_none()
              .pl(24)
              .pr(8)
              .gap(6)
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .on_click((e, cx) => {
                this.show(group.path, cx, {
                  line: m.line,
                  col: m.col,
                  matchLen: m.match.length || this.query.length,
                }, e);
              })
              .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.dim).child(String(m.line)))
              .child(
                h_flex()
                  .flex_1()
                  .min_w(0)
                  .overflow_hidden()
                  .items_center()
                  .text_size(12)
                  .when(Boolean(m.before), el => el.child(div().text_color(t.muted).child(m.before)))
                  .when(Boolean(m.match), el =>
                    el.child(
                      div()
                        .px(2)
                        .rounded(3)
                        .bg(t.selection)
                        .text_color(t.accent)
                        .font_semibold()
                        .child(m.match),
                    ),
                  )
                  .when(Boolean(m.after), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(m.after))),
              ),
          );
        }
      }
    }

    if (this.searchLimited) {
      out.push(
        div()
          .p(8)
          .text_size(11)
          .text_color(t.dim)
          .child(`Showing first ${MAX_MATCHES} matches — refine your query or include filter`),
      );
    }

    return v_flex().id("files-search-results").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1).children(out);
  }

  renderFileResults(t) {
    if (this.searchError) {
      return v_flex().p(10).child(div().text_size(12).text_color(t.ansi1).child(this.searchError));
    }
    if (this.searching && !this.fileResults.length) {
      return v_flex().p(10).child(div().text_size(12).text_color(t.dim).child("Searching files…"));
    }
    if (!this.fileResults.length) {
      return v_flex().p(10).child(div().text_size(12).text_color(t.dim).child("No matching files"));
    }

    const out = this.fileResults.map(f =>
      h_flex()
        .id(`sf-${f.path}`)
        .h(28)
        .flex_none()
        .px(8)
        .gap(7)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .hover(s => s.bg(t.hover))
        .on_click((e, cx) => this.show(f.path, cx, null, e))
        .child(image(fileIcon(f.name)).w(16).h(16).flex_none())
        .child(div().font_medium().text_color(t.foreground).child(f.name))
        .when(Boolean(f.dir), el => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(f.dir))),
    );

    if (this.fileResultsLimited) {
      out.push(div().p(8).text_size(11).text_color(t.dim).child("Showing top 200 matching files"));
    }

    return v_flex().id("files-name-results").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(out);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx, null, e))
          .child(entry.dir ? svg(`mods/files-search/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
          .child(image(entry.dir ? folderIcon(entry.name, open) : fileIcon(entry.name)).w(16).h(16).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (!checking()) {
      if (key() !== this.context?.key) this.refresh(cx);
      else this.refreshIfDue(cx);
    }
    const t = theme();
    const isSearching = this.query.trim().length > 0;
    const headerRight = this.root?.split(/[\\/]/).pop() ?? "";

    return v_flex()
      .id("files")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Files"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(headerRight)),
      )
      .child(this.renderSearchBar(t))
      .when(isSearching && this.searchMode === "content", body => body.child(this.renderContentResults(t)))
      .when(isSearching && this.searchMode === "files", body => body.child(this.renderFileResults(t)))
      .when(!isSearching, body =>
        body.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, empty =>
              empty.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))),
            )
            .when(this.limited, lim => lim.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))),
        ),
      );
  }
}
