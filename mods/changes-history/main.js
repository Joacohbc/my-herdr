import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, layout, checking, run, shared, setShared, props } from "herdr";
import { fileIcon, releaseIconCache } from "./material-icons.js";
import { listPullRequests, loadPullRequestDetail, checkoutPullRequest, buildRemoteBranchUrl } from "./github.js";
import { SCM_COLORS, DIFF_COLORS, scmColor, parseStatusZ, parseNameStatusZ } from "./scm-status.js";
import { splitDiff, buildHunkPatch, applyHunk } from "./hunks.js";
import { stashPushArgs, stashApplyArgs, loadStashFiles, loadStashFileDiff } from "./stash.js";
import { openInVSCode } from "./vscode.js";

const scans = globalThis[Symbol.for("herdr.changesStatus.v4")] ??= new Map();
const MAX_SCANS = 4;
const MAX_DIFF_LINES = 1000;
const MAX_DIFF_LINE_CHARS = 2000;
const MAX_UNTRACKED_DIFF_CHARS = 250_000;
const MAX_BADGE_STATUS_FILES = 999;
const MAX_COMMIT_FILES = 400;
const MAX_RULER_BUCKETS = 120;
const MIN_DIFF_WIDTH_PX = 300;
const DIFF_ROW_EXTRA_PX = 42;
const GIT_CHECK_TIMEOUT_MS = 5_000;
const GIT_READ_TIMEOUT_MS = 8_000;
const GIT_ACTION_TIMEOUT_MS = 15_000;
const MAX_HISTORY_LIMIT = 1000;
const MAX_HISTORY_PAGES = 20;
const MAX_BRANCHES = 150;
const GRAPH_SEARCH_DEBOUNCE_MS = 220;
const PR_SEARCH_DEBOUNCE_MS = 280;
const IDLE_CLEAN_MS = 30_000;
const HIBERNATE_IDLE_MS = 45_000;
const HIDDEN_BADGE_POLL_MS = 15_000;

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function isChangesPanelVisible() {
  if (window()?.visible === false) return false;
  const root = layout();
  const panel = findLayoutNode(root, "panel");
  if (!panel || panel.hidden) return false;
  const body = findLayoutNode(root, "panel-body");
  return !body || body.active === "changes";
}

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [k, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(k);
  }
  while (scans.size > MAX_SCANS) {
    scans.delete(scans.keys().next().value);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.ok && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25);
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, on });
          next.ok = r.code === 0;
          if (next.ok) next.parsed = parseStatusZ(r.stdout);
          else next.stderr = r.stderr;
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (!next.ok && scans.get(repo) === next) scans.delete(repo);
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
  const space = spaces().find((s) => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const viewerRoot = pane?.mod === "file-viewer" ? shared("file-viewer.meta")?.[pane.pane]?.root : null;
  const fallbackTermPane = pane && !pane.cwd && f?.tab
    ? allPanes.find(p => p.tab === f.tab && p.cwd)
    : null;
  const spaceTabIds = new Set((space?.tabs ?? []).map(t => t.id));
  const spaceTermPane = !pane?.cwd && !viewerRoot && !fallbackTermPane?.cwd
    ? allPanes.find(p => spaceTabIds.has(p.tab) && p.cwd)
    : null;
  const sameSpaceFocusedCwd = f?.space === space?.id ? f?.cwd : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || viewerRoot || fallbackTermPane?.cwd || spaceTermPane?.cwd || space?.folder || sameSpaceFocusedCwd, on, space: space?.id ?? null };
}
const key = () => JSON.stringify(location());
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const wideGlyph = /[\p{Ideographic}\p{Emoji_Presentation}\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/gu;

function displayColumns(text) {
  let columns = text.length;
  for (const glyph of text.match(wideGlyph) ?? []) {
    if (glyph.length === 1) columns++;
  }
  return columns;
}

const rowHeight = size => Math.ceil(size * 1.8), charWidth = size => size * 0.64;
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function truncateDiffLine(line) {
  return line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}…` : line;
}

function diffRows(lines) {
  let old = 0, next = 0, hunkIndex = -1;
  return lines.map((rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; hunkIndex += 1; return { kind: "@", text: line, hunk: hunkIndex }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " ", hunk: hunkIndex };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " ", hunk: hunkIndex };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " ", hunk: hunkIndex }; }
    return { kind: "", text: line, hunk: hunkIndex };
  });
}

function computeOverviewBuckets(rows) {
  if (!rows.length) return [];
  const bucketCount = Math.min(MAX_RULER_BUCKETS, rows.length);
  const buckets = [];
  let hasAnyChange = false;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor((b * rows.length) / bucketCount);
    const end = Math.max(start + 1, Math.floor(((b + 1) * rows.length) / bucketCount));
    let hasAdd = false;
    let hasDel = false;
    for (let i = start; i < end; i++) {
      const kind = rows[i]?.kind;
      if (kind === "+") hasAdd = true;
      else if (kind === "-") hasDel = true;
    }
    if (hasAdd || hasDel) hasAnyChange = true;
    buckets.push({ hasAdd, hasDel });
  }
  return hasAnyChange ? buckets : [];
}

function parseDiffOutput(stdout) {
  const raw = stdout || "";
  if (!raw.trim()) return { lines: ["No changes"], parsed: null };
  const parsed = splitDiff(raw);
  if (parsed.binary || !parsed.hunks.length) {
    return { lines: ["Binary file or empty diff"], parsed: null };
  }
  const boundedHunks = [];
  const lines = [];
  for (const hunk of parsed.hunks) {
    if (hunk.bodyStart >= MAX_DIFF_LINES) break;
    const isTruncated = hunk.bodyEnd > MAX_DIFF_LINES;
    boundedHunks.push(isTruncated ? { ...hunk, lines: [], truncated: true } : { ...hunk, truncated: false });
    if (lines.length < MAX_DIFF_LINES) lines.push(truncateDiffLine(hunk.header));
    for (const bodyLine of hunk.lines) {
      if (lines.length >= MAX_DIFF_LINES) break;
      lines.push(truncateDiffLine(bodyLine));
    }
  }
  return {
    lines: lines.length ? lines : ["Binary file or empty diff"],
    parsed: { header: parsed.header, hunks: boundedHunks, binary: false },
  };
}

async function loadUntrackedDiffLines(root, path, on) {
  const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
  if (text === null) return ["Cannot preview this file"];
  if (text.includes("\0")) return ["Binary file · no text diff"];
  const count = countLines(text);
  const rawLines = text.slice(0, MAX_UNTRACKED_DIFF_CHARS).replace(/\n$/, "").split("\n").slice(0, MAX_DIFF_LINES);
  return [`@@ -0,0 +1,${count} @@`, ...rawLines.map(l => truncateDiffLine(`+${l}`))];
}

async function fetchFileDiff(root, file, on) {
  if (file.untracked) {
    return { lines: await loadUntrackedDiffLines(root, file.path, on), parsed: null };
  }
  const pathArgs = file.staged && file.origPath ? [file.origPath, file.path] : [file.path];
  const args = file.staged
    ? [...READ, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...pathArgs]
    : [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...pathArgs];
  const r = await exec("git", args, { cwd: root, on, timeout: GIT_READ_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot load diff");
  return parseDiffOutput(r.stdout);
}

function buildCommitCommands(mode, message, hasStaged) {
  if (mode === "amend") {
    return [message ? ["commit", "--amend", "-m", message] : ["commit", "--amend", "--no-edit"]];
  }
  if (mode === "staged") return [["commit", "-m", message]];
  const base = hasStaged ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
  return mode === "push" ? [...base, ["push"]] : base;
}

function prStateColor(pr, t) {
  if (pr.isDraft) return t.dim;
  if (pr.state === "MERGED") return t.ansi5;
  if (pr.state === "CLOSED") return t.ansi1;
  return t.ansi2;
}

function prStateLabel(pr) {
  if (pr.isDraft) return "Draft";
  if (pr.state === "MERGED") return "Merged";
  if (pr.state === "CLOSED") return "Closed";
  return "Open";
}

export default class ChangesHistory extends View {
  init(initialProps, cx) {
    const p = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();
    this.standaloneCommit = Boolean(p?.commit && p?.root);
    this.standaloneFileDiff = Boolean(p?.fileDiff && p?.root);
    this.standalonePr = Boolean(p?.pr && p?.root);
    this.standalone = this.standaloneCommit || this.standaloneFileDiff || this.standalonePr;
    this.standaloneFile = this.standaloneFileDiff ? p.fileDiff : null;
    this.branch = "";
    this.remoteBranchUrl = null;
    this.staged = [];
    this.unstaged = [];
    this.conflicts = [];
    this.stashes = [];
    this.open = null;
    this.rows = [];
    this.overviewBuckets = [];
    this.diffParsed = null;
    this.selectedHunk = 0;
    this.hunkBusy = false;
    this.diffSeq = 0;
    this.actionOpSeq = 0;
    this.hunkOpSeq = 0;
    this.rulerHeights = {};
    this.diffScroll = VirtualListScrollHandle.new();
    this.commitDiffScroll = VirtualListScrollHandle.new();
    this.prDiffScroll = VirtualListScrollHandle.new();
    this.longest = 0;
    this.gutterChars = 4;
    this.message = "";
    this.handle = cx.focus_handle();

    this.secMerge = true;
    this.secStaged = true;
    this.secChanges = true;
    this.secStashes = false;
    this.secGraph = false;
    this.secPrs = false;
    this.stashMenuOpen = false;
    this.commitMenuOpen = false;
    this.stashKeepIndex = localStorage.getItem("sc.stashIndex") === "1";
    this.hoveredRow = null;
    this.pendingConfirm = null;
    const savedH = Number(localStorage.getItem("sc.bottomH"));
    this.bottomPaneH = Number.isFinite(savedH) && savedH >= 80 && savedH <= 700 ? savedH : 240;
    this.draggingSplit = null;
    this.panelHeight = 600;

    this.commits = [];
    this.historyLimit = 50;
    this.historyLoading = false;
    this.historyError = null;
    this.historyLoadedFor = null;
    this.historySeq = 0;
    this.historyBefore = null;
    this.historyBeforeStack = [];
    this.graphQuery = "";
    this.graphBranchRef = "";
    this.graphBranchLabel = "";
    this.branches = [];
    this.branchesLoadedFor = null;
    this.branchPickerOpen = false;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.commitRows = [];
    this.commitOverviewBuckets = [];
    this.commitLongest = 0;
    this.commitGutterChars = 4;
    this.commitDetailLoading = false;

    this.prs = [];
    this.prState = "open";
    this.prQuery = "";
    this.prLoading = false;
    this.prError = null;
    this.prLoadedFor = null;
    this.prSeq = 0;
    this.selectedPr = null;
    this.prFiles = [];
    this.prOpenFile = null;
    this.prDiffByFile = new Map();
    this.prRows = [];
    this.prOverviewBuckets = [];
    this.prLongest = 0;
    this.prGutterChars = 4;
    this.prDetailLoading = false;
    this.prCheckingOut = false;

    this.hiddenSince = 0;
    this.evicted = false;
    this.hibernated = false;
    this.lastGcSeq = shared("herdr.gc")?.seq ?? 0;
    this.lastDiffOpenSeq = shared("changes.diff.open")?.seq ?? 0;
    this.lastChangesRefreshSeq = shared("changes.refresh")?.seq ?? 0;
    this.lastBadgeAt = 0;
    this.lastBadgeLoc = "";
    this.badgeChecking = false;
    this.standalonePaneId = null;
    this.standaloneTabId = p?.tab ?? null;
    this.standaloneRenamedFor = null;

    if (!this.standalone) {
      this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
      this.input.on("change", (_e, cx) => {
        const hadMessage = Boolean(this.message.trim());
        this.message = this.input.value();
        if (hadMessage !== Boolean(this.message.trim())) cx.notify();
      });
      this.input.on("submit", (_e, cx) => this.commit(cx));
      this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

      this.graphSearchInput = InputState.new({ placeholder: "Search commits..." });
      this.graphSearchInput.on("change", (_e, cx) => {
        this.graphQuery = this.graphSearchInput.value();
        this.scheduleHistorySearch(cx);
        cx.notify();
      });
      this.graphSearchInput.on("submit", (_e, cx) => this.loadHistory(cx, true));
      this.graphSearchInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.graphSearchInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

      this.prSearchInput = InputState.new({ placeholder: "Search PRs (title, author, #)..." });
      this.prSearchInput.on("change", (_e, cx) => {
        this.prQuery = this.prSearchInput.value();
        this.schedulePrSearch(cx);
        cx.notify();
      });
      this.prSearchInput.on("submit", (_e, cx) => this.loadPullRequests(cx));
      this.prSearchInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.prSearchInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    }

    if (checking()) return;
    if (this.standaloneCommit) {
      this.root = p.root;
      this.on = p.on ?? null;
      this.context = { key: `commit:${p.commit.hash}`, on: this.on, dirtyAt: 0 };
      this.openCommit(p.commit, cx);
      cx.timer.every(15_000, cx => this.checkStandaloneHibernation(cx));
      return;
    }
    if (this.standaloneFileDiff) {
      this.root = p.root;
      this.on = p.on ?? null;
      this.context = { key: `filediff:${p.fileDiff.path}`, on: this.on, dirtyAt: 0 };
      this.open = { path: p.fileDiff.path, staged: Boolean(p.fileDiff.staged) };
      this.loadStandaloneFileDiff(cx);
      cx.timer.every(15_000, cx => this.checkStandaloneHibernation(cx));
      return;
    }
    if (this.standalonePr) {
      this.root = p.root;
      this.on = p.on ?? null;
      this.context = { key: `pr:${p.pr.number}`, on: this.on, dirtyAt: 0 };
      this.openPullRequest(p.pr, cx);
      cx.timer.every(15_000, cx => this.checkStandaloneHibernation(cx));
      return;
    }
    if (isChangesPanelVisible()) this.refresh(cx);
    else this.refreshBadgeCount(cx);
    cx.timer.every(1000, cx => this.refreshIfDue(cx));
  }

  close() {
    this.context?.watch?.pending?.cancel();
    this.evictCaches();
    this.diffScroll?.release();
    this.commitDiffScroll?.release();
    this.prDiffScroll?.release();
    this.input?.release();
    this.graphSearchInput?.release();
    this.prSearchInput?.release();
  }

  publishBadgeCount(count, spaceId) {
    const prev = shared("changes.badge") ?? {};
    if (prev.count === count && prev.space === spaceId) return;
    setShared("changes.badge", { count, space: spaceId });
  }

  refreshBadgeCount(cx) {
    if (this.badgeChecking || window()?.active === false) return;
    const loc = location();
    if (!loc.cwd) {
      this.publishBadgeCount(0, loc.space);
      return;
    }
    const locKey = `${loc.space}:${loc.on ?? ""}:${loc.cwd}`;
    const now = Date.now();
    if (locKey === this.lastBadgeLoc && now - this.lastBadgeAt < HIDDEN_BADGE_POLL_MS) return;
    this.lastBadgeLoc = locKey;
    this.lastBadgeAt = now;
    this.badgeChecking = true;
    cx.spawn(async () => {
      try {
        const r = await exec(
          "git",
          [...READ, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { cwd: loc.cwd, on: loc.on, timeout: GIT_CHECK_TIMEOUT_MS },
        );
        if (r.code !== 0) {
          this.publishBadgeCount(0, loc.space);
          return;
        }
        const { count } = parseStatusZ(r.stdout, MAX_BADGE_STATUS_FILES);
        this.publishBadgeCount(count, loc.space);
      } catch {
      } finally {
        this.badgeChecking = false;
      }
    });
  }

  evictCaches() {
    this.context?.watch?.pending?.cancel();
    if (this.context) this.context.watch = null;
    this.staged = [];
    this.unstaged = [];
    this.conflicts = [];
    this.stashes = [];
    this.pendingConfirm = null;
    this.stashMenuOpen = false;
    this.commitMenuOpen = false;
    this.open = null;
    this.setLines([]);
    this.commits = [];
    this.historyLimit = 50;
    this.historyLoadedFor = null;
    this.historyBefore = null;
    this.historyBeforeStack = [];
    this.branches = [];
    this.branchesLoadedFor = null;
    this.branchPickerOpen = false;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.setCommitLines([]);
    this.prs = [];
    this.prLoadedFor = null;
    this.selectedPr = null;
    this.prFiles = [];
    this.prOpenFile = null;
    this.prDiffByFile.clear();
    this.setPrLines([]);
    scans.clear();
    releaseIconCache();
    this.evicted = true;
  }

  isStandaloneVisible() {
    if (window()?.visible === false) return false;
    const activeSpace = spaces().find(s => s.active);
    const activeTabId = activeSpace?.tabs?.find(t => t.active)?.id;
    if (!activeTabId) return false;
    const allPanes = panes().filter(p => p.mod === "changes-history");
    if (!this.standalonePaneId) {
      const scoped = this.standaloneTabId ? allPanes.filter(p => p.tab === this.standaloneTabId) : allPanes;
      const match = scoped.find(p => p.focused) ?? scoped.find(p => p.tab === activeTabId) ?? allPanes.find(p => p.focused) ?? allPanes.find(p => p.tab === activeTabId);
      if (match) {
        this.standalonePaneId = match.pane;
        this.standaloneTabId = match.tab;
      }
    }
    if (!this.standalonePaneId) return true;
    const me = allPanes.find(p => p.pane === this.standalonePaneId);
    if (me && this.standaloneFileDiff && this.standaloneFile) {
      const wantName = `${this.standaloneFile.staged ? "Staged · " : "Diff · "}${this.standaloneFile.path}`;
      if (!me.name && this.standaloneRenamedFor !== wantName) {
        this.standaloneRenamedFor = wantName;
        run("pane.rename", { pane: me.pane, name: wantName });
      }
    }
    return Boolean(me && me.tab === activeTabId);
  }

  checkSharedDiffOpen(cx, fromRender = false) {
    if (!this.standaloneFileDiff) return;
    const req = shared("changes.diff.open");
    if (!req || !req.seq || req.seq === this.lastDiffOpenSeq) return;
    if (req.pane && this.standalonePaneId && req.pane !== this.standalonePaneId) return;
    if (!req.pane && req.tab && this.standaloneTabId && req.tab !== this.standaloneTabId) return;
    this.lastDiffOpenSeq = req.seq;
    this.standaloneFile = req.fileDiff;
    this.root = req.root;
    this.on = req.on ?? null;
    this.context = { key: JSON.stringify({ cwd: this.root, on: this.on }), cwd: this.root, on: this.on };
    this.standaloneRenamedFor = null;
    this.pendingConfirm = null;
    this.hunkOpSeq += 1;
    this.hunkBusy = false;
    this.hibernated = false;
    this.loadStandaloneFileDiff(cx, fromRender);
  }

  checkStandaloneHibernation(cx, fromRender = false) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    const forceGc = gcSeq !== this.lastGcSeq;
    this.lastGcSeq = gcSeq;

    if (this.isStandaloneVisible()) {
      this.hiddenSince = 0;
      if (this.hibernated) {
        this.hibernated = false;
        if (this.standaloneCommit && this.selectedCommit) this.openCommit(this.selectedCommit, cx, fromRender);
        else if (this.standaloneFileDiff && this.standaloneFile) this.loadStandaloneFileDiff(cx, fromRender);
        else if (this.standalonePr && this.selectedPr) this.openPullRequest(this.selectedPr, cx, fromRender);
      }
      return;
    }

    const now = Date.now();
    if (!this.hiddenSince) this.hiddenSince = now;
    if (forceGc || now - this.hiddenSince >= HIBERNATE_IDLE_MS) {
      if (!this.hibernated) {
        this.hibernated = true;
        this.pendingConfirm = null;
        this.commitFiles = [];
        this.setCommitLines([]);
        this.prFiles = [];
        this.prDiffByFile.clear();
        this.setPrLines([]);
        this.setLines([]);
        releaseIconCache();
        if (!fromRender) cx.notify();
      }
    }
  }

  consumeChangesRefresh() {
    const refresh = shared("changes.refresh");
    const refreshSeq = refresh?.seq ?? 0;
    if (refreshSeq === this.lastChangesRefreshSeq) return false;
    this.lastChangesRefreshSeq = refreshSeq;
    if (refresh?.root) {
      for (const cacheKey of scans.keys()) {
        if (cacheKey.includes(JSON.stringify(refresh.root))) scans.delete(cacheKey);
      }
    }
    return !refresh?.root || !this.root || refresh.root === this.root;
  }

  refreshIfDue(cx) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    const forceGc = gcSeq !== this.lastGcSeq;
    this.lastGcSeq = gcSeq;
    const needSync = this.consumeChangesRefresh();

    const visible = isChangesPanelVisible();
    if (!visible) {
      this.context?.watch?.pending?.cancel();
      if (this.context) this.context.watch = null;
      const now = Date.now();
      if (!this.hiddenSince) this.hiddenSince = now;
      if (forceGc || (!this.evicted && now - this.hiddenSince >= IDLE_CLEAN_MS)) {
        this.evictCaches();
      }
      if (needSync) {
        this.lastBadgeAt = 0;
        if (this.context) this.context.dirtyAt = now + 1;
      }
      this.refreshBadgeCount(cx);
      return;
    }

    const wasEvicted = this.evicted;
    this.hiddenSince = 0;
    this.evicted = false;

    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context || wasEvicted || needSync) {
      this.refresh(cx, true);
      return;
    }
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading || this.busy || this.hunkBusy) return;
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
    if (this.standalone) return this.context === context;
    return this.context === context && key() === context.key;
  }

  resetHistory() {
    this.commits = [];
    this.historyLimit = 50;
    this.historyLoading = false;
    this.historyError = null;
    this.historyLoadedFor = null;
    this.historyBefore = null;
    this.historyBeforeStack = [];
    this.graphQuery = "";
    this.graphSearchInput?.set_value("");
    this.graphBranchRef = "";
    this.graphBranchLabel = "";
    this.branches = [];
    this.branchesLoadedFor = null;
    this.branchPickerOpen = false;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.setCommitLines([]);
    this.prs = [];
    this.prLoading = false;
    this.prError = null;
    this.prLoadedFor = null;
    this.prQuery = "";
    this.prSearchInput?.set_value("");
    this.selectedPr = null;
    this.prFiles = [];
    this.prOpenFile = null;
    this.prDiffByFile.clear();
    this.setPrLines([]);
  }

  refresh(cx, force = false) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      this.context?.watch?.pending?.cancel();
      this.context = { key: next, on, dirtyAt: 0 };
      this.root = null;
      this.branch = "";
      this.remoteBranchUrl = null;
      this.staged = [];
      this.unstaged = [];
      this.conflicts = [];
      this.stashes = [];
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.pendingConfirm = null;
      this.stashMenuOpen = false;
      this.commitMenuOpen = false;
      this.busy = false;
      this.hunkBusy = false;
      this.actionOpSeq += 1;
      this.hunkOpSeq += 1;
      this.limited = false;
      this.loading = false;
      this.resetHistory();
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading || this.busy || this.hunkBusy) return;
    if (force || (context.catchUp && !context.dirtyAt)) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: force || visiting || context.catchUp,
      allowInactive: force || visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;

    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!this.current(context)) return;
        if (top.code !== 0) {
          this.root = null;
          this.branch = "";
          this.remoteBranchUrl = null;
          this.staged = [];
          this.unstaged = [];
          this.conflicts = [];
          this.stashes = [];
          this.setLines([]);
          this.open = null;
          this.error = "Not a git repository";
          return;
        }
        const root = top.stdout.trim();
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        this.watch(root, context, cx);

        const [scan, brRes, stashRes, upRes] = await Promise.all([
          repoStatus(root, on, request, cx, () => this.context === context),
          git(["branch", "--show-current"]),
          git(["stash", "list", "--pretty=format:%gd%x1f%gs%x1f%cr"]),
          git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
        ]);
        if (!scan || !this.current(context)) return;

        const currentBranch = (brRes.stdout || "").trim();
        let remoteBranchUrl = null;
        if (currentBranch) {
          let remoteName = null;
          let remoteBranch = null;
          if (upRes.code === 0) {
            const upstream = (upRes.stdout || "").trim();
            const slash = upstream.indexOf("/");
            if (slash > 0) {
              remoteName = upstream.slice(0, slash);
              remoteBranch = upstream.slice(slash + 1);
            }
          } else {
            const refCheck = await git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${currentBranch}`]);
            if (refCheck.code === 0) {
              remoteName = "origin";
              remoteBranch = currentBranch;
            }
          }
          if (remoteName && remoteBranch) {
            const urlRes = await git(["remote", "get-url", remoteName]);
            if (urlRes.code === 0) {
              remoteBranchUrl = buildRemoteBranchUrl(urlRes.stdout, remoteBranch);
            }
          }
        }
        if (!this.current(context)) return;

        const { started, pollAt, watchAt } = scan;
        context.lastStatus = started;
        context.pollAt = pollAt;
        context.watchAt = watchAt;
        if (context.dirtyAt <= started) context.dirtyAt = 0;
        if (scan.error) throw scan.error;
        if (!scan.ok) throw new Error(scan.stderr || "git status failed");
        if (request.urgent && request.after > started) context.catchUp = true;

        const { staged, unstaged, conflicts, limited, count } = scan.parsed;

        const stashes = [];
        if (stashRes.code === 0) {
          for (const line of (stashRes.stdout || "").split("\n")) {
            if (!line) continue;
            const [ref, msg, rel] = line.split("\x1f");
            if (ref) stashes.push({ ref, message: msg || ref, relDate: rel || "" });
          }
        }

        if (!this.current(context)) return;
        this.root = root;
        this.on = on;
        this.branch = currentBranch || "HEAD";
        this.remoteBranchUrl = remoteBranchUrl;
        this.staged = staged;
        this.unstaged = unstaged;
        this.conflicts = conflicts;
        this.stashes = stashes;
        this.limited = limited;
        this.error = null;
        this.publishBadgeCount(count, location().space);

        if (this.open) {
          const exists = this.open.staged
            ? staged.some(f => f.path === this.open.path)
            : unstaged.some(f => f.path === this.open.path) || conflicts.some(f => f.path === this.open.path);
          if (!exists) {
            this.open = null;
            this.setLines([]);
          } else {
            await this.loadDiff(this.open, context).catch(() => {});
          }
        }

        if (this.secGraph && (force || this.historyLoadedFor !== root)) {
          this.loadBranches(cx);
          this.loadHistory(cx, true);
        }
        if (this.secPrs && (force || this.prLoadedFor !== root)) {
          this.loadPullRequests(cx);
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  runGitAction(args, cx, successNote = null) {
    if (!this.root || this.busy || this.hunkBusy) return;
    const root = this.root, on = this.on, context = this.context;
    const opSeq = ++this.actionOpSeq;
    this.busy = true;
    this.note = null;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", args, { cwd: root, on, timeout: GIT_ACTION_TIMEOUT_MS });
        if (!this.current(context)) return;
        if (r.code !== 0) {
          this.note = (r.stderr || r.stdout || "Git command failed").trim();
        } else {
          this.note = successNote;
          this.historyLoadedFor = null;
        }
      } catch (e) {
        if (this.current(context)) this.note = String(e.message || e);
      } finally {
        if (this.actionOpSeq === opSeq) this.busy = false;
        if (this.current(context)) {
          this.refresh(cx, true);
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  stageFile(path, cx) { this.runGitAction(["add", "--", path], cx); }
  unstageFile(file, cx) {
    const pathArgs = typeof file === "string"
      ? [file]
      : (file.origPath ? [file.origPath, file.path] : [file.path]);
    this.runGitAction(["reset", "HEAD", "--", ...pathArgs], cx);
  }
  stageAll(cx) { this.runGitAction(["add", "-A"], cx); }
  unstageAll(cx) { this.runGitAction(["reset", "HEAD"], cx); }

  requestDiscardFile(file, cx) {
    this.pendingConfirm = { kind: "discard", file };
    cx.notify();
  }

  requestDropStash(stash, cx) {
    this.pendingConfirm = { kind: "drop-stash", stash };
    cx.notify();
  }

  requestRevertHunk(index, cx) {
    this.pendingConfirm = { kind: "revert-hunk", index };
    cx.notify();
  }

  requestClearStashes(cx) {
    if (!this.stashes.length) return;
    this.pendingConfirm = { kind: "clear-stashes" };
    cx.notify();
  }

  confirmPendingAction(cx) {
    const confirmRequest = this.pendingConfirm;
    if (!confirmRequest) return;
    this.pendingConfirm = null;
    if (confirmRequest.kind === "discard") {
      this.discardFile(confirmRequest.file, cx);
    } else if (confirmRequest.kind === "drop-stash") {
      this.stashDrop(confirmRequest.stash.ref, cx);
    } else if (confirmRequest.kind === "revert-hunk") {
      this.runHunkAction(confirmRequest.index, "revert", cx);
    } else if (confirmRequest.kind === "clear-stashes") {
      this.runGitAction(["stash", "clear"], cx);
    } else if (confirmRequest.kind === "amend-pushed") {
      this.executeCommit("amend", cx);
    }
  }

  discardFile(file, cx) {
    if (file.untracked) {
      this.runGitAction(["clean", "-fd", "--", file.path], cx);
    } else {
      this.runGitAction(["checkout", "--", file.path], cx);
    }
  }

  stashPush(cx, mode = "all", paths = []) {
    const wasOpen = this.stashMenuOpen;
    this.stashMenuOpen = false;
    if (!this.root || this.busy || this.hunkBusy) {
      if (wasOpen) cx.notify();
      return;
    }
    const msg = this.message.trim();
    const args = stashPushArgs({ mode, message: msg, paths });
    if (msg) {
      this.message = "";
      this.input.set_value("");
    }
    this.secStashes = true;
    this.runGitAction(args, cx);
  }

  stashApply(ref, cx) {
    this.runGitAction(stashApplyArgs(ref, { pop: false, keepIndex: this.stashKeepIndex }), cx);
  }

  stashPop(ref, cx) {
    this.runGitAction(stashApplyArgs(ref, { pop: true, keepIndex: this.stashKeepIndex }), cx);
  }

  stashDrop(ref, cx) { this.runGitAction(["stash", "drop", ref], cx); }

  notifyChangesRefresh(root) {
    const prevSeq = shared("changes.refresh")?.seq ?? 0;
    setShared("changes.refresh", { seq: prevSeq + 1, root });
  }

  async finishHunkAction(opSeq, context, root, cx) {
    if (this.hunkOpSeq === opSeq) this.hunkBusy = false;
    if (!this.current(context)) return;
    if (this.standaloneFileDiff) {
      this.loadStandaloneFileDiff(cx);
      this.notifyChangesRefresh(root);
      cx.notify();
      return;
    }
    if (this.open) await this.loadDiff(this.open, context).catch(() => {});
    this.refresh(cx, true);
    cx.notify();
  }

  runHunkAction(index, mode, cx) {
    if (this.busy || this.hunkBusy || !this.root || !this.diffParsed) return;
    const hunk = this.diffParsed.hunks[index];
    if (!hunk || hunk.truncated) return;
    const patch = buildHunkPatch(this.diffParsed.header, hunk);
    const context = this.context, root = this.root, on = this.on;
    const opSeq = ++this.hunkOpSeq;
    this.hunkBusy = true;
    this.note = null;
    cx.spawn(async cx => {
      try {
        const hunkResult = await applyHunk(exec, { root, on, patch, mode });
        if (this.current(context) && !hunkResult.ok) this.note = hunkResult.error;
      } catch (e) {
        if (this.current(context)) this.note = String(e.message || e);
      } finally {
        await this.finishHunkAction(opSeq, context, root, cx);
      }
    });
    cx.notify();
  }

  runStandaloneFileAction(stage, cx) {
    const file = this.standaloneFile;
    if (!file || !this.root || this.busy || this.hunkBusy) return;
    const context = this.context, root = this.root, on = this.on;
    const opSeq = ++this.hunkOpSeq;
    const pathArgs = !stage && file.origPath ? [file.origPath, file.path] : [file.path];
    const args = stage ? ["add", "--", ...pathArgs] : ["reset", "HEAD", "--", ...pathArgs];
    this.hunkBusy = true;
    this.note = null;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", args, { cwd: root, on, timeout: GIT_ACTION_TIMEOUT_MS });
        if (this.current(context) && r.code !== 0) {
          this.note = (r.stderr || r.stdout || "Git command failed").trim();
        }
      } catch (e) {
        if (this.current(context)) this.note = String(e.message || e);
      } finally {
        await this.finishHunkAction(opSeq, context, root, cx);
      }
    });
    cx.notify();
  }

  toggleStandaloneStaged(cx) {
    if (!this.standaloneFile) return;
    this.standaloneFile = { ...this.standaloneFile, staged: !this.standaloneFile.staged };
    this.standaloneRenamedFor = null;
    this.pendingConfirm = null;
    if (this.standalonePaneId) {
      const wantName = `${this.standaloneFile.staged ? "Staged · " : "Diff · "}${this.standaloneFile.path}`;
      this.standaloneRenamedFor = wantName;
      run("pane.rename", { pane: this.standalonePaneId, name: wantName });
    }
    this.loadStandaloneFileDiff(cx);
  }

  launchVSCode(filePath, cx) {
    if (!this.root) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      const launchResult = await openInVSCode(exec, { root, on, file: filePath });
      if (!this.current(context) || launchResult.ok) return;
      this.note = launchResult.error || "Failed to launch VS Code";
      cx.notify();
    });
  }

  openInViewer(path, event) {
    if (!path || !this.root) return;
    const f = focused();
    const tabId = f?.tab ?? null;
    const editorMode = Boolean(shared("editor.mode")?.enabled);
    const openInNewTab = Boolean(event?.modifiers?.control || event?.modifiers?.platform);
    const fileName = path.split(/[\\/]/).pop() || path;
    const payload = { file: path, root: this.root, on: this.on ?? null, tab: tabId, line: null, col: null, matchLen: null, editFirst: editorMode };

    if (openInNewTab) {
      run("tab.new", { name: fileName, mod: "file-viewer", props: { ...payload, tab: null, solo: true } });
      return;
    }

    const tabPanes = tabId ? panes().filter(p => p.tab === tabId) : [];
    const existing = tabPanes.find(p => p.pane === f?.pane && p.mod === "file-viewer") ?? tabPanes.find(p => p.mod === "file-viewer");
    const meta = shared("file-viewer.meta") ?? {};
    if (existing && !meta[existing.pane]?.dirty) {
      const prevSeq = shared("file-viewer.open")?.seq ?? 0;
      setShared("file-viewer.open", { ...payload, pane: existing.pane, replace: true, seq: prevSeq + 1 });
      run("pane.focus", { pane: existing.pane });
      run("pane.rename", { pane: existing.pane, name: fileName });
      if (tabPanes.length === 1) run("tab.rename", { id: tabId, name: fileName });
      return;
    }
    if (existing && meta[existing.pane]?.dirty) {
      run("tab.new", { name: fileName, mod: "file-viewer", props: { ...payload, tab: null, solo: true } });
      return;
    }
    run("pane.split", { direction: "right", mod: "file-viewer", props: payload });
  }

  async loadDiff(target, context) {
    const root = this.root, on = this.on;
    const list = target.staged ? this.staged : [...this.unstaged, ...this.conflicts];
    const file = list.find(f => f.path === target.path);
    if (!file) return;
    const seq = ++this.diffSeq;
    const { lines, parsed } = await fetchFileDiff(root, file, on);
    if (seq !== this.diffSeq) return;
    if (this.current(context) && this.open?.path === target.path && this.open?.staged === target.staged) {
      this.setLines(lines, parsed);
    }
  }

  openFileDiff(file, openInNewTab = false) {
    if (!file || !this.root) return;
    const plainFile = {
      path: file.path,
      origPath: file.origPath || "",
      staged: Boolean(file.staged),
      untracked: Boolean(file.untracked),
      conflict: Boolean(file.conflict),
      status: file.status || "M",
    };
    const fileName = file.path.split("/").pop() || file.path;
    const tabTitle = `${plainFile.staged ? "Staged: " : ""}${fileName}`.slice(0, 32);
    const paneTitle = `${plainFile.staged ? "Staged · " : "Diff · "}${file.path}`;

    if (openInNewTab) {
      run("tab.new", {
        name: tabTitle,
        mod: "changes-history",
        props: { fileDiff: plainFile, root: this.root, on: this.on ?? null },
      });
      return;
    }

    const f = focused();
    const tabId = f?.tab ?? null;
    const tabPanes = tabId ? panes().filter(p => p.tab === tabId) : [];
    const existing = tabPanes.find(p => p.pane === f?.pane && p.mod === "changes-history") ?? tabPanes.find(p => p.mod === "changes-history");

    if (existing) {
      const prevSeq = shared("changes.diff.open")?.seq ?? 0;
      setShared("changes.diff.open", {
        pane: existing.pane,
        tab: tabId,
        fileDiff: plainFile,
        root: this.root,
        on: this.on ?? null,
        seq: prevSeq + 1,
      });
      run("pane.focus", { pane: existing.pane });
      run("pane.rename", { pane: existing.pane, name: paneTitle });
      if (tabPanes.length === 1) run("tab.rename", { id: tabId, name: tabTitle });
      return;
    }

    run("pane.split", {
      direction: "right",
      mod: "changes-history",
      props: { fileDiff: plainFile, root: this.root, on: this.on ?? null, tab: tabId },
    });
  }

  openFileDiffInNewTab(file) {
    this.openFileDiff(file, true);
  }

  async refreshStandaloneFileState(file, root, on) {
    const statusArgs = [...READ, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...(file.origPath ? [file.origPath, file.path] : [file.path])];
    const r = await exec("git", statusArgs, { cwd: root, on, timeout: GIT_CHECK_TIMEOUT_MS }).catch(() => null);
    if (!r || r.code !== 0) return file;
    const parsed = parseStatusZ(r.stdout, 20);
    const match = file.staged
      ? parsed.staged.find(f => f.path === file.path)
      : (parsed.conflicts.find(f => f.path === file.path) ?? parsed.unstaged.find(f => f.path === file.path));
    if (!match) {
      return { ...file, untracked: false, conflict: false };
    }
    return {
      ...file,
      origPath: match.origPath || file.origPath || "",
      status: match.status,
      untracked: Boolean(match.untracked),
      conflict: Boolean(match.conflict),
    };
  }

  loadStandaloneFileDiff(cx, fromRender = false) {
    const file = this.standaloneFile;
    if (!file || !this.root) return;
    const context = this.context, root = this.root, on = this.on;
    const seq = ++this.diffSeq;
    this.loading = true;
    this.setLines([]);
    cx.spawn(async cx => {
      try {
        const freshFile = await this.refreshStandaloneFileState(file, root, on);
        if (!this.current(context) || seq !== this.diffSeq) return;
        this.standaloneFile = freshFile;
        const { lines, parsed } = await fetchFileDiff(root, freshFile, on);
        if (this.current(context) && seq === this.diffSeq) {
          this.setLines(lines, parsed);
        }
      } catch (e) {
        if (this.current(context) && seq === this.diffSeq) this.setLines([`Diff error: ${e}`]);
      } finally {
        if (this.current(context) && seq === this.diffSeq) {
          this.loading = false;
          cx.notify();
        }
      }
    });
    if (!fromRender) cx.notify();
  }

  pickDiff(file, cx) {
    const same = this.open && this.open.path === file.path && this.open.staged === file.staged;
    this.open = same ? null : { path: file.path, staged: file.staged };
    this.setLines([]);
    const context = this.context;
    if (this.open) {
      const target = this.open;
      cx.spawn(async cx => {
        try { await this.loadDiff(target, context); }
        catch (e) { if (this.current(context)) this.note = `Diff error: ${e}`; }
        cx.notify();
      });
    }
    cx.notify();
  }

  commit(cx, mode = "smart") {
    const wasMenuOpen = this.commitMenuOpen;
    this.commitMenuOpen = false;
    if (!this.root || this.busy || this.hunkBusy || this.loading || this.context?.key !== key()) {
      if (wasMenuOpen) cx.notify();
      return;
    }
    if (this.conflicts.length > 0) {
      this.note = "Resolve merge conflicts before committing";
      cx.notify();
      return;
    }
    if (mode === "staged" && this.staged.length === 0) {
      this.note = "Nothing staged";
      cx.notify();
      return;
    }
    if (mode !== "amend" && !this.message.trim()) {
      if (wasMenuOpen) cx.notify();
      return;
    }
    if (mode === "amend") {
      this.prepareAmend(cx);
      return;
    }
    this.executeCommit(mode, cx);
  }

  prepareAmend(cx) {
    if (this.staged.length === 0 && !this.message.trim()) {
      this.note = "Nothing staged and no new message to amend";
      cx.notify();
      return;
    }
    const context = this.context, root = this.root, on = this.on;
    const opSeq = ++this.actionOpSeq;
    this.busy = true;
    this.note = null;
    cx.spawn(async cx => {
      try {
        const headCheck = await exec("git", [...READ, "rev-parse", "--verify", "HEAD"], { cwd: root, on, timeout: GIT_CHECK_TIMEOUT_MS }).catch(() => ({ code: 1 }));
        if (!this.current(context)) return;
        if (headCheck.code !== 0) {
          this.note = "No commits to amend yet";
          return;
        }
        const ancestorCheck = await exec("git", [...READ, "merge-base", "--is-ancestor", "HEAD", "@{u}"], { cwd: root, on, timeout: GIT_CHECK_TIMEOUT_MS }).catch(() => ({ code: 1 }));
        if (!this.current(context)) return;
        if (ancestorCheck.code === 0) {
          this.pendingConfirm = { kind: "amend-pushed" };
          return;
        }
        if (this.actionOpSeq === opSeq) this.busy = false;
        this.executeCommit("amend", cx);
      } finally {
        if (this.actionOpSeq === opSeq) this.busy = false;
        if (this.current(context)) cx.notify();
      }
    });
    cx.notify();
  }

  executeCommit(mode, cx) {
    if (!this.root || this.busy || this.hunkBusy || this.conflicts.length > 0) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    const cmds = buildCommitCommands(mode, message, this.staged.length > 0);
    const opSeq = ++this.actionOpSeq;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      let committed = false;
      try {
        for (const args of cmds) {
          const timeout = args[0] === "push" ? GIT_ACTION_TIMEOUT_MS : undefined;
          const r = await exec("git", args, { cwd: root, on, timeout });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
          if (args[0] === "commit") committed = true;
        }
      } catch (e) {
        if (this.current(context)) {
          this.note = committed ? `Committed locally, but push failed: ${e}` : `Commit failed: ${e}`;
        }
      } finally {
        if (this.actionOpSeq === opSeq) this.busy = false;
        if (this.current(context)) {
          if (committed) {
            if (message) {
              this.message = "";
              this.input.set_value("");
            }
            this.historyLoadedFor = null;
          }
          this.refresh(cx, true);
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  scheduleHistorySearch(cx) {
    this.historyBefore = null;
    this.historyBeforeStack = [];
    const seq = ++this.historySeq;
    cx.spawn(async cx => {
      await cx.sleep(GRAPH_SEARCH_DEBOUNCE_MS);
      if (seq !== this.historySeq) return;
      this.loadHistory(cx, true);
    });
  }

  loadBranches(cx) {
    const context = this.context, root = this.root, on = this.on;
    if (!root) return;
    cx.spawn(async cx => {
      try {
        const r = await exec(
          "git",
          [...READ, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"],
          { cwd: root, on, timeout: 6000 },
        );
        if (!this.current(context) || r.code !== 0) return;
        const parsed = [];
        for (const line of (r.stdout || "").split("\n")) {
          if (!line) continue;
          const [label, fullRef] = line.split("\t");
          if (!label || !fullRef || label.endsWith("/HEAD")) continue;
          parsed.push({ label, fullRef, isRemote: fullRef.startsWith("refs/remotes/") });
          if (parsed.length >= MAX_BRANCHES) break;
        }
        this.branches = parsed;
        this.branchesLoadedFor = root;
        cx.notify();
      } catch {
        // Ignore transient branch listing errors
      }
    });
  }

  selectGraphBranch(ref, label, cx) {
    this.graphBranchRef = ref;
    this.graphBranchLabel = label;
    this.branchPickerOpen = false;
    this.historyBefore = null;
    this.historyBeforeStack = [];
    this.loadHistory(cx, true);
  }

  pageHistoryOlder(cx) {
    const last = this.commits[this.commits.length - 1];
    if (!last || !last.ts) return;
    this.historyBeforeStack.push(this.historyBefore);
    if (this.historyBeforeStack.length > MAX_HISTORY_PAGES) {
      this.historyBeforeStack.shift();
    }
    this.historyBefore = { ts: last.ts - 1, label: last.date || String(last.ts) };
    this.loadHistory(cx, true);
  }

  pageHistoryNewer(cx) {
    if (!this.historyBeforeStack.length) {
      this.historyBefore = null;
    } else {
      this.historyBefore = this.historyBeforeStack.pop() ?? null;
    }
    this.loadHistory(cx, true);
  }

  resetHistoryDatePage(cx) {
    this.historyBefore = null;
    this.historyBeforeStack = [];
    this.loadHistory(cx, true);
  }

  loadHistory(cx, reset = false) {
    const context = this.context, root = this.root, on = this.on;
    if (!root) return;
    if (reset) this.historyLimit = 50;
    const limit = this.historyLimit;
    const seq = ++this.historySeq;
    const query = this.graphQuery.trim();
    const branchRef = this.graphBranchRef;
    const beforeTs = this.historyBefore?.ts ?? null;
    this.historyLoading = true;
    this.historyError = null;

    const args = [
      ...READ,
      "log",
      "-n",
      String(limit),
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%cs%x1f%ct%x1f%D%x1f%s",
    ];
    if (beforeTs !== null) {
      args.push(`--before=${beforeTs}`);
    }
    if (query) {
      args.push("--fixed-strings", "--regexp-ignore-case", `--grep=${query}`);
    }
    if (branchRef === "__all__") {
      args.push("--all");
    } else if (branchRef) {
      args.push(branchRef);
    }

    cx.spawn(async cx => {
      try {
        const r = await exec("git", args, { cwd: root, on, timeout: 8000 });
        if (!this.current(context) || seq !== this.historySeq) return;
        if (r.code !== 0) {
          const err = (r.stderr || "").trim();
          if (err.includes("does not have any commits")) { this.commits = []; this.historyError = null; }
          else this.historyError = err || "Cannot read git log";
          return;
        }
        const parsed = [];
        for (const line of (r.stdout || "").split("\n")) {
          if (!line) continue;
          const [hash, shortHash, author, relDate, date, tsStr, refs, ...subjectParts] = line.split("\x1f");
          if (!hash) continue;
          parsed.push({
            hash,
            shortHash: shortHash || hash.slice(0, 7),
            author: author || "",
            relDate: relDate || "",
            date: date || "",
            ts: Number(tsStr) || 0,
            refs: (refs || "").split(",").map(s => s.trim()).filter(Boolean),
            subject: subjectParts.join("\x1f") || "(no message)",
          });
        }
        this.commits = parsed;
        this.historyLoadedFor = root;
        this.historyError = null;
      } catch (e) {
        if (this.current(context) && seq === this.historySeq) this.historyError = String(e.message || e);
      } finally {
        if (this.current(context) && seq === this.historySeq) { this.historyLoading = false; cx.notify(); }
      }
    });
    cx.notify();
  }

  openCommitInNewTab(commit) {
    if (!commit || !this.root) return;
    const plainCommit = {
      hash: commit.hash,
      shortHash: commit.shortHash,
      author: commit.author,
      relDate: commit.relDate,
      date: commit.date || "",
      subject: commit.subject,
      ...(commit.stash ? { stash: commit.stash } : {}),
    };
    const tabTitle = `${commit.shortHash} ${commit.subject}`.slice(0, 32);
    const res = run("tab.new", {
      name: tabTitle,
      mod: "changes-history",
      props: { commit: plainCommit, root: this.root, on: this.on ?? null },
    });
    if (res?.pane) {
      run("pane.rename", { pane: res.pane, name: `${commit.shortHash} · ${commit.subject}` });
    }
  }

  async loadRegularCommitFiles(hash, root, on) {
    const [nameStatusRes, numstatRes] = await Promise.all([
      exec("git", [...READ, "diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "-z", hash], { cwd: root, on, timeout: GIT_READ_TIMEOUT_MS }),
      exec("git", [...READ, "diff-tree", "--no-commit-id", "--numstat", "-r", "--root", "-z", hash], { cwd: root, on, timeout: GIT_READ_TIMEOUT_MS }),
    ]);
    const stats = {};
    if (numstatRes.code === 0) {
      for (const entry of (numstatRes.stdout || "").split("\0")) {
        const [added, deleted, ...parts] = entry.split("\t");
        if (parts.length) stats[parts.join("\t")] = { add: Number(added) || 0, del: Number(deleted) || 0 };
      }
    }
    if (nameStatusRes.code !== 0) return [];
    return parseNameStatusZ(nameStatusRes.stdout, MAX_COMMIT_FILES).map(file => ({
      ...file,
      ...(stats[file.path] ?? { add: 0, del: 0 }),
    }));
  }

  openCommit(commit, cx, fromRender = false) {
    this.selectedCommit = commit;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.setCommitLines([]);
    this.commitDetailLoading = true;

    const context = this.context, root = this.root, on = this.on, hash = commit.hash;
    cx.spawn(async cx => {
      try {
        const files = commit.stash
          ? await loadStashFiles(exec, { root, on, ref: commit.stash })
          : await this.loadRegularCommitFiles(hash, root, on);
        if (!this.current(context) || this.selectedCommit?.hash !== hash) return;

        this.commitFiles = files;
        if (files.length) {
          this.commitOpenFile = files[0].path;
          await this.loadCommitFileDiff(hash, files[0].path, context);
        }
      } catch (e) {
        if (this.current(context)) this.setCommitLines([`Cannot load commit: ${e}`]);
      } finally {
        if (this.current(context)) { this.commitDetailLoading = false; cx.notify(); }
      }
    });
    if (!fromRender) cx.notify();
  }

  async loadCommitFileDiff(hash, path, context) {
    const root = this.root, on = this.on;
    let rawStdout;
    if (this.selectedCommit?.stash) {
      const file = this.commitFiles.find(f => f.path === path);
      rawStdout = await loadStashFileDiff(exec, {
        root,
        on,
        ref: this.selectedCommit.stash,
        path,
        untracked: Boolean(file?.untracked),
        stagedOnly: Boolean(file?.stagedOnly),
        origPath: file?.origPath || "",
      });
      if (!this.current(context) || this.selectedCommit?.hash !== hash || this.commitOpenFile !== path) return;
    } else {
      const r = await exec("git", [...READ, "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", hash, "--", path], { cwd: root, on, timeout: GIT_READ_TIMEOUT_MS });
      if (!this.current(context) || this.selectedCommit?.hash !== hash || this.commitOpenFile !== path) return;
      if (r.code !== 0) { this.setCommitLines([r.stderr || "Cannot load diff"]); return; }
      rawStdout = r.stdout || "";
    }
    this.setCommitLines(parseDiffOutput(rawStdout).lines);
  }

  pickCommitFile(path, cx) {
    if (!this.selectedCommit) return;
    this.commitOpenFile = path;
    this.setCommitLines([]);
    const context = this.context, hash = this.selectedCommit.hash;
    cx.spawn(async cx => {
      try { await this.loadCommitFileDiff(hash, path, context); }
      catch (e) { if (this.current(context)) this.setCommitLines([`Diff error: ${e}`]); }
      cx.notify();
    });
    cx.notify();
  }

  setLines(lines, parsed = null) {
    this.diffParsed = parsed;
    if (this.pendingConfirm?.kind === "revert-hunk") this.pendingConfirm = null;
    const hunkCount = parsed?.hunks?.length ?? 0;
    if (hunkCount === 0) this.selectedHunk = 0;
    else if (this.selectedHunk >= hunkCount) this.selectedHunk = hunkCount - 1;
    this.rows = diffRows(lines);
    this.overviewBuckets = computeOverviewBuckets(this.rows);
    this.longest = Math.max(0, ...this.rows.map(r => displayColumns(r.text)));
    this.gutterChars = Math.max(4, String(Math.max(0, ...this.rows.map(r => r.number ?? 0))).length);
  }

  selectHunkByRowKey(rowKey, cx) {
    const rowIndex = Number(rowKey);
    if (!Number.isInteger(rowIndex)) return;
    const row = this.rows[rowIndex];
    if (!row || row.hunk === undefined || row.hunk < 0) return;
    if (this.selectedHunk === row.hunk) return;
    this.selectedHunk = row.hunk;
    cx.notify();
  }

  stepHunk(delta, cx) {
    const hunks = this.diffParsed?.hunks ?? [];
    if (hunks.length <= 1) return;
    this.selectedHunk = (this.selectedHunk + delta + hunks.length) % hunks.length;
    const targetRow = hunks[this.selectedHunk]?.bodyStart;
    if (targetRow !== undefined) this.diffScroll?.scroll_to_item(targetRow, "center");
    cx.notify();
  }

  setCommitLines(lines) {
    this.commitRows = diffRows(lines);
    this.commitOverviewBuckets = computeOverviewBuckets(this.commitRows);
    this.commitLongest = Math.max(0, ...this.commitRows.map(r => displayColumns(r.text)));
    this.commitGutterChars = Math.max(4, String(Math.max(0, ...this.commitRows.map(r => r.number ?? 0))).length);
  }

  setPrLines(lines) {
    this.prRows = diffRows(lines);
    this.prOverviewBuckets = computeOverviewBuckets(this.prRows);
    this.prLongest = Math.max(0, ...this.prRows.map(r => displayColumns(r.text)));
    this.prGutterChars = Math.max(4, String(Math.max(0, ...this.prRows.map(r => r.number ?? 0))).length);
  }

  schedulePrSearch(cx) {
    const seq = ++this.prSeq;
    cx.spawn(async cx => {
      await cx.sleep(PR_SEARCH_DEBOUNCE_MS);
      if (seq !== this.prSeq) return;
      this.loadPullRequests(cx);
    });
  }

  loadPullRequests(cx) {
    const context = this.context, root = this.root, on = this.on;
    if (!root) return;
    const seq = ++this.prSeq;
    const state = this.prState;
    const query = this.prQuery.trim();
    this.prLoading = true;
    this.prError = null;

    cx.spawn(async cx => {
      const result = await listPullRequests(root, on, { state, query, limit: 30 });
      if (!this.current(context) || seq !== this.prSeq) return;
      this.prLoading = false;
      this.prLoadedFor = root;
      if (!result.ok) {
        this.prs = [];
        this.prError = result.error;
      } else {
        this.prs = result.prs;
        this.prError = null;
      }
      cx.notify();
    });
    cx.notify();
  }

  openPullRequestInNewTab(pr) {
    if (!pr || !this.root) return;
    const plainPr = { ...pr };
    const tabTitle = `#${pr.number} ${pr.title}`.slice(0, 32);
    const res = run("tab.new", {
      name: tabTitle,
      mod: "changes-history",
      props: { pr: plainPr, root: this.root, on: this.on ?? null },
    });
    if (res?.pane) {
      run("pane.rename", { pane: res.pane, name: `PR #${pr.number} · ${pr.title}` });
    }
  }

  openPullRequest(pr, cx, fromRender = false) {
    this.selectedCommit = null;
    this.selectedPr = pr;
    this.prFiles = [];
    this.prOpenFile = null;
    this.prDiffByFile.clear();
    this.setPrLines([]);
    this.prDetailLoading = true;

    const context = this.context, root = this.root, on = this.on, num = pr.number;
    cx.spawn(async cx => {
      const result = await loadPullRequestDetail(root, on, num, MAX_DIFF_LINES, MAX_DIFF_LINE_CHARS);
      if (!this.current(context) || this.selectedPr?.number !== num) return;
      this.prDetailLoading = false;
      if (!result.ok) {
        this.setPrLines([result.error || "Cannot load pull request"]);
        cx.notify();
        return;
      }
      this.selectedPr = result.pr || pr;
      this.prFiles = result.files;
      this.prDiffByFile = result.diffByFile;
      if (this.prFiles.length) {
        this.prOpenFile = this.prFiles[0].path;
        this.setPrLines(this.prDiffByFile.get(this.prOpenFile) ?? ["Binary file or empty diff"]);
      } else {
        this.setPrLines(["No files changed"]);
      }
      cx.notify();
    });
    if (!fromRender) cx.notify();
  }

  pickPrFile(path, cx) {
    if (!this.selectedPr) return;
    this.prOpenFile = path;
    this.setPrLines(this.prDiffByFile.get(path) ?? ["Binary file or empty diff"]);
    cx.notify();
  }

  checkoutSelectedPr(cx) {
    const pr = this.selectedPr;
    if (!pr || !this.root || this.prCheckingOut) return;
    const context = this.context, root = this.root, on = this.on;
    this.prCheckingOut = true;
    this.note = null;
    cx.spawn(async cx => {
      const res = await checkoutPullRequest(root, on, pr.number);
      if (!this.current(context)) return;
      this.prCheckingOut = false;
      if (!res.ok) {
        this.note = res.error || "Checkout failed";
      } else {
        this.historyLoadedFor = null;
        if (!this.standalone) this.refresh(cx, true);
      }
      cx.notify();
    });
    cx.notify();
  }

  gutter(chars, size) { return Math.ceil(chars * charWidth(size)) + 2; }

  diffMinWidth(longest, gutterChars, size) {
    return Math.max(MIN_DIFF_WIDTH_PX, longest * charWidth(size) + this.gutter(gutterChars, size) + DIFF_ROW_EXTRA_PX);
  }

  canActOnHunks(file) {
    if (!file || file.untracked || file.conflict) return false;
    if (file.status === "R" || file.status === "C") return false;
    if (!this.diffParsed?.hunks?.length) return false;
    const isRenameHeader = this.diffParsed.header.some(line => line.startsWith("rename from ") || line.startsWith("copy from "));
    return !isRenameHeader;
  }

  renderVSCodeButton(t, id, filePath) {
    return this.actionBtn(
      t,
      id,
      image("mods/changes-history/vscode.svg").w(16).h(16).flex_none(),
      this.on ? "Open in VS Code (local repositories only)" : "Open in VS Code (clean profile)",
      (_e, cx) => this.launchVSCode(filePath, cx),
    ).when(Boolean(this.on), b => b.opacity(0.45));
  }

  renderHunkBar(file, t, prefix) {
    const hunks = this.diffParsed?.hunks ?? [];
    if (!this.canActOnHunks(file)) return null;
    const activeIndex = Math.max(0, Math.min(this.selectedHunk, hunks.length - 1));
    const activeHunk = hunks[activeIndex];
    const hasMany = hunks.length > 1;
    const lineLabel = activeHunk.newStart || activeHunk.oldStart;
    return h_flex()
      .h(28)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .child(
        div()
          .px(6)
          .py(1)
          .rounded(4)
          .bg(t.selected)
          .text_size(10.5)
          .font_semibold()
          .text_color(t.foreground)
          .child(`Block ${activeIndex + 1}/${hunks.length}`),
      )
      .child(div().text_size(10.5).text_color(t.dim).child(`L${lineLabel}`))
      .when(hasMany, el =>
        el
          .child(this.actionBtn(t, `${prefix}-hunk-prev`, "↑", "Previous block", (_e, cx) => this.stepHunk(-1, cx)))
          .child(this.actionBtn(t, `${prefix}-hunk-next`, "↓", "Next block", (_e, cx) => this.stepHunk(1, cx))),
      )
      .child(div().flex_1().min_w(0))
      .when(activeHunk.truncated, el =>
        el.child(div().text_size(10.5).text_color(t.dim).child("Block truncated — use file actions")),
      )
      .when(!activeHunk.truncated && file.staged, el =>
        el.child(
          div()
            .id(`${prefix}-hunk-unstage`)
            .px(7)
            .py(2)
            .rounded(5)
            .bg(t.raised)
            .text_size(11)
            .font_medium()
            .text_color(t.foreground)
            .cursor_pointer()
            .hover(s => s.bg(t.hover))
            .tooltip("Unstage selected block")
            .on_click((_e, cx) => this.runHunkAction(activeIndex, "unstage", cx))
            .child(this.hunkBusy ? "Working…" : "− Unstage block"),
        ),
      )
      .when(!activeHunk.truncated && !file.staged, el =>
        el
          .child(
            div()
              .id(`${prefix}-hunk-stage`)
              .px(7)
              .py(2)
              .rounded(5)
              .bg(DIFF_COLORS.addBg)
              .text_size(11)
              .font_medium()
              .text_color(DIFF_COLORS.addSign)
              .cursor_pointer()
              .hover(s => s.bg(DIFF_COLORS.rulerAdd + "66"))
              .tooltip("Stage selected block")
              .on_click((_e, cx) => this.runHunkAction(activeIndex, "stage", cx))
              .child(this.hunkBusy ? "Working…" : "+ Stage block"),
          )
          .child(
            div()
              .id(`${prefix}-hunk-revert`)
              .px(7)
              .py(2)
              .rounded(5)
              .bg(DIFF_COLORS.delBg)
              .text_size(11)
              .font_medium()
              .text_color(DIFF_COLORS.delSign)
              .cursor_pointer()
              .hover(s => s.bg(DIFF_COLORS.rulerDel + "66"))
              .tooltip("Revert selected block")
              .on_click((_e, cx) => this.requestRevertHunk(activeIndex, cx))
              .child("↺ Revert block"),
          ),
      );
  }

  renderPendingConfirm(t) {
    const confirmRequest = this.pendingConfirm;
    const isDelete = confirmRequest.kind === "discard" && confirmRequest.file?.untracked;
    const confirmMeta = {
      discard: {
        label: isDelete ? `Delete "${confirmRequest.file.path}"?` : `Discard changes in "${confirmRequest.file.path}"?`,
        confirmText: isDelete ? "Delete" : "Discard",
      },
      "drop-stash": {
        label: `Drop stash "${confirmRequest.stash?.ref}"?`,
        confirmText: "Drop",
      },
      "revert-hunk": {
        label: `Revert block #${(confirmRequest.index ?? 0) + 1}?`,
        confirmText: "Revert",
      },
      "clear-stashes": {
        label: `Clear all ${this.stashes.length} stashes?`,
        confirmText: "Clear",
      },
      "amend-pushed": {
        label: "HEAD is already pushed to upstream. Amend anyway?",
        confirmText: "Amend",
      },
    }[confirmRequest.kind] ?? { label: "Confirm action?", confirmText: "Confirm" };

    return v_flex()
      .flex_none()
      .px(10)
      .py(7)
      .gap(6)
      .bg(DIFF_COLORS.delBg)
      .border_b(1)
      .border_color(SCM_COLORS.conflict)
      .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(confirmMeta.label))
      .child(
        h_flex()
          .gap(6)
          .justify_end()
          .child(
            div()
              .id("sc-confirm-cancel")
              .px(8)
              .py(3)
              .rounded(5)
              .bg(t.raised)
              .text_size(11)
              .text_color(t.foreground)
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.pendingConfirm = null;
                cx.notify();
              })
              .child("Cancel"),
          )
          .child(
            div()
              .id("sc-confirm-ok")
              .px(8)
              .py(3)
              .rounded(5)
              .bg(t.ansi1)
              .text_size(11)
              .font_semibold()
              .text_color(t.solid_foreground)
              .cursor_pointer()
              .on_click((_e, cx) => this.confirmPendingAction(cx))
              .child(confirmMeta.confirmText),
          ),
      );
  }

  renderNoteBar(t) {
    const flatNote = String(this.note || "").replace(/\s*\n\s*/g, " · ");
    return h_flex()
      .px(10)
      .py(5)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .tooltip(this.note)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(SCM_COLORS.conflict).child(flatNote))
      .child(this.actionBtn(t, "sc-note-x", "×", "Dismiss", (_e, cx) => { this.note = null; cx.notify(); }));
  }

  renderHunkHeaderRow(text, hunk, parsedHunk, t, height) {
    const isSelected = hunk === this.selectedHunk;
    return h_flex()
      .w_full()
      .px(8)
      .h(height)
      .flex_none()
      .gap(6)
      .items_center()
      .bg(isSelected ? t.selected : t.raised)
      .child(
        div()
          .flex_none()
          .px(5)
          .py(0)
          .rounded(4)
          .bg(isSelected ? t.accent : t.surface)
          .text_size(10.5)
          .font_semibold()
          .text_color(isSelected ? t.accent_foreground : t.muted)
          .child(`#${hunk + 1}`),
      )
      .child(div().flex_1().min_w(0).truncate().text_color(isSelected ? t.foreground : t.dim).child(text))
      .when(parsedHunk.truncated, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child("truncated")));
  }

  diffRow({ kind, number, text, hunk }, t, size, gutterChars, showHunkBadges = false) {
    const height = rowHeight(size);
    if (kind === "@") {
      const parsedHunk = showHunkBadges ? this.diffParsed?.hunks?.[hunk] : null;
      if (parsedHunk) return this.renderHunkHeaderRow(text, hunk, parsedHunk, t, height);
      return div().w_full().px(10).h(height).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    }
    const isAdd = kind === "+";
    const isDel = kind === "-";
    const signColor = isAdd ? DIFF_COLORS.addSign : isDel ? DIFF_COLORS.delSign : t.dim;
    const sign = isAdd || isDel ? kind : " ";
    return h_flex()
      .w_full()
      .h(height)
      .flex_none()
      .gap(6)
      .when(isAdd, (e) => e.bg(DIFF_COLORS.addBg))
      .when(isDel, (e) => e.bg(DIFF_COLORS.delBg))
      .child(
        div()
          .w(3)
          .h_full()
          .flex_none()
          .when(isAdd, el => el.bg(DIFF_COLORS.rulerEdgeAdd))
          .when(isDel, el => el.bg(DIFF_COLORS.rulerEdgeDel)),
      )
      .child(div().w(this.gutter(gutterChars, size)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_center().font_semibold().text_color(signColor).child(sign))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderDiffOverviewRuler({ listId, rows, buckets, scrollHandle, t, selectHunks }) {
    if (!buckets.length || !rows.length) return null;
    const rulerId = `${listId}-ruler`;
    return v_flex()
      .id(rulerId)
      .w(16)
      .h_full()
      .flex_none()
      .bg(DIFF_COLORS.rulerTrack)
      .border_l(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip("Click to jump to diff position")
      .on_size_change((sz) => {
        this.rulerHeights[listId] = sz.height / (settings().zoom || 1);
      })
      .on_mouse_down("left", (e, cx) => {
        const zoom = settings().zoom || 1;
        const height = e.bounds?.height ?? (this.rulerHeights[listId] || 1) * zoom;
        const localY = e.local_position?.y ?? 0;
        const ratio = Math.max(0, Math.min(1, localY / Math.max(1, height)));
        const targetRow = Math.min(rows.length - 1, Math.floor(ratio * rows.length));
        scrollHandle?.scroll_to_item(targetRow, "center");
        if (selectHunks) this.selectHunkByRowKey(String(targetRow), cx);
        cx.notify();
      })
      .children(
        buckets.map((bucket) =>
          h_flex()
            .flex_1()
            .w_full()
            .child(
              div()
                .w(2)
                .h_full()
                .flex_none()
                .bg(bucket.hasDel ? DIFF_COLORS.rulerEdgeDel : bucket.hasAdd ? DIFF_COLORS.rulerEdgeAdd : DIFF_COLORS.rulerTrack),
            )
            .child(
              div()
                .w(7)
                .h_full()
                .flex_none()
                .bg(bucket.hasDel ? DIFF_COLORS.rulerDel : DIFF_COLORS.rulerTrack),
            )
            .child(
              div()
                .w(7)
                .h_full()
                .flex_none()
                .bg(bucket.hasAdd ? DIFF_COLORS.rulerAdd : DIFF_COLORS.rulerTrack),
            ),
        ),
      );
  }

  renderVirtualizedDiff({ listId, xId, rows, longest, gutterChars, size, t, scrollHandle, overviewBuckets, showHunkBadges = false, selectHunks = false }) {
    const ruler = this.renderDiffOverviewRuler({ listId, rows, buckets: overviewBuckets, scrollHandle, t, selectHunks });
    return h_flex()
      .flex_1()
      .min_h(0)
      .font_family(settings().font_family ?? "JetBrains Mono")
      .text_size(size)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .h_full()
          .relative()
          .child(
            div()
              .id(xId)
              .size_full()
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(this.diffMinWidth(longest, gutterChars, size))
                  .h_full()
                  .child(
                    v_virtual_list(
                      listId,
                      rows.length,
                      rowHeight(size),
                      (i) => String(i),
                      (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size, gutterChars, showHunkBadges)),
                    )
                      .when(Boolean(scrollHandle), list => list.track_scroll(scrollHandle))
                      .when(selectHunks, list =>
                        list
                          .on_item_click((rowKey, cx) => this.selectHunkByRowKey(rowKey, cx))
                          .on_item_secondary_click((rowKey, _e, cx) => this.selectHunkByRowKey(rowKey, cx)),
                      )
                      .size_full(),
                  ),
              ),
          )
          .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0()),
      )
      .when(Boolean(ruler), el => el.child(ruler));
  }

  actionBtn(t, id, label, tip, onClick) {
    return div()
      .id(id)
      .px(5)
      .py(2)
      .rounded(5)
      .flex()
      .items_center()
      .justify_center()
      .text_size(11.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(e, cx);
      })
      .child(label);
  }

  sectionHeader(t, id, title, open, count, onToggle, actions = []) {
    return h_flex()
      .id(id)
      .h(26)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_click(onToggle)
      .child(div().w(10).text_size(10).text_color(t.dim).child(open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.muted).child(title))
      .children(actions)
      .when(count !== null, el =>
        el.child(
          div()
            .px(6)
            .py(1)
            .rounded(999)
            .bg(t.surface)
            .text_size(10)
            .text_color(t.muted)
            .child(String(count)),
        ),
      );
  }

  fileRow(file, t) {
    const parts = file.path.split("/");
    const name = parts.pop();
    const dir = parts.join("/");
    const rowPrefix = file.conflict ? "c" : file.staged ? "s" : "u";
    const rowId = `sc-${rowPrefix}-${file.path}`;
    const isSelected = this.open?.path === file.path && this.open?.staged === file.staged;
    const isHovered = this.hoveredRow === rowId;
    const color = scmColor(file.status);
    const subtitle = file.origPath ? (dir ? `${file.origPath} → ${dir}` : `${file.origPath} →`) : dir;

    return h_flex()
      .id(rowId)
      .h(26)
      .flex_none()
      .pl(14)
      .pr(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(isSelected, el => el.bg(t.selected))
      .hover(s => s.bg(isSelected ? t.selected : t.hover))
      .on_hover((h, cx) => {
        if (h) this.hoveredRow = rowId;
        else if (this.hoveredRow === rowId) this.hoveredRow = null;
        cx.notify();
      })
      .tooltip(`${file.origPath ? `${file.origPath} → ` : ""}${file.path}\nClick: open diff in current tab · Ctrl+Click: open diff in new tab`)
      .on_click((e) => {
        const openInNewTab = Boolean(e?.modifiers?.control || e?.modifiers?.platform);
        this.openFileDiff(file, openInNewTab);
      })
      .child(image(fileIcon(name)).w(16).h(16).flex_none())
      .child(div().flex_none().max_w(165).truncate().text_size(12).text_color(color).when(file.status === "D", el => el.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(subtitle))
      .when(isHovered, el =>
        el
          .child(this.actionBtn(t, `${rowId}-open`, "↗", "Open file (Ctrl+Click: new tab)", (e) => this.openInViewer(file.path, e)))
          .when(Boolean(file.conflict), r => r
            .child(this.actionBtn(t, `${rowId}-res`, "+", "Mark as resolved", (_e, cx) => this.stageFile(file.path, cx))))
          .when(!file.staged && !file.conflict, r => r
            .child(this.actionBtn(t, `${rowId}-stash`, "S", "Stash this file (incl. staged)", (_e, cx) => this.stashPush(cx, file.untracked ? "all" : "tracked", [file.path])))
            .child(this.actionBtn(t, `${rowId}-disc`, "↺", file.untracked ? "Delete untracked file" : "Discard changes", (_e, cx) => this.requestDiscardFile(file, cx)))
            .child(this.actionBtn(t, `${rowId}-add`, "+", "Stage changes", (_e, cx) => this.stageFile(file.path, cx))))
          .when(file.staged, r => r
            .child(this.actionBtn(t, `${rowId}-un`, "−", "Unstage changes", (_e, cx) => this.unstageFile(file, cx)))),
      )
      .child(div().w(14).text_right().text_size(11).font_semibold().text_color(color).child(file.status));
  }

  renderCommitDetail(t, size) {
    const c = this.selectedCommit;
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .flex_none()
          .px(10)
          .py(8)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(!this.standaloneCommit, el =>
                el.child(this.actionBtn(t, "hist-back", "←", "Back to Source Control", (_e, cx) => {
                  this.selectedCommit = null;
                  this.commitFiles = [];
                  this.commitOpenFile = null;
                  this.setCommitLines([]);
                  cx.notify();
                })),
              )
              .child(div().px(5).py(1).rounded(4).bg(t.selected).text_size(11).font_semibold().text_color(t.accent).child(c.shortHash))
              .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12).text_color(t.foreground).child(c.subject)),
          )
          .child(div().pl(this.standaloneCommit ? 4 : 24).text_size(11).text_color(t.dim).child(`${c.author} · ${c.date ? `${c.date} (${c.relDate})` : c.relDate} · ${this.commitFiles.length} file${this.commitFiles.length === 1 ? "" : "s"}`)),
      )
      .child(
        div()
          .flex_1()
          .min_h(44)
          .max_h(Math.min(200, this.commitFiles.length * 26 + 12))
          .relative()
          .border_b(1)
          .border_color(t.border)
          .child(
            v_flex()
              .id("hist-files-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .children(
                this.commitFiles.map(f => {
                  const parts = f.path.split("/"), name = parts.pop();
                  return h_flex()
                    .id(`hf-${f.path}`)
                    .h(26)
                    .flex_none()
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(this.commitOpenFile === f.path, e => e.bg(t.selected))
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.pickCommitFile(f.path, cx))
                    .child(image(fileIcon(name)).w(15).h(15).flex_none())
                    .child(div().flex_none().max_w(160).truncate().text_size(12).text_color(scmColor(f.status)).when(f.status === "D", e => e.line_through()).child(name))
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
                    .when(f.add > 0, e => e.child(div().text_size(10.5).text_color(DIFF_COLORS.addSign).child(`+${f.add}`)))
                    .when(f.del > 0, e => e.child(div().text_size(10.5).text_color(DIFF_COLORS.delSign).child(`−${f.del}`)))
                    .child(div().w(14).text_right().text_size(11).font_semibold().text_color(scmColor(f.status)).child(f.status));
                }),
              )
              .when(!this.commitFiles.length, e =>
                e.child(div().p(8).text_size(12).text_color(t.dim).child(this.commitDetailLoading ? "Loading commit…" : "No files changed")),
              ),
          )
          .child(Scrollbar.vertical("hist-files-list").absolute().inset_0()),
      )
      .child(
        this.renderVirtualizedDiff({
          listId: "hist-diff",
          xId: "hist-diff-x",
          rows: this.commitRows,
          longest: this.commitLongest,
          gutterChars: this.commitGutterChars,
          size,
          t,
          scrollHandle: this.commitDiffScroll,
          overviewBuckets: this.commitOverviewBuckets,
        }),
      );
  }

  renderPrDetail(t, size) {
    const pr = this.selectedPr;
    const stateColor = prStateColor(pr, t);
    const prDate = pr.updatedDate || pr.createdDate || "";
    const branchSummary = pr.headRefName && pr.baseRefName ? `${pr.headRefName} → ${pr.baseRefName}` : pr.headRefName;

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .flex_none()
          .px(10)
          .py(8)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(!this.standalonePr, el =>
                el.child(this.actionBtn(t, "pr-back", "←", "Back to Source Control", (_e, cx) => {
                  this.selectedPr = null;
                  this.prFiles = [];
                  this.prOpenFile = null;
                  this.prDiffByFile.clear();
                  this.setPrLines([]);
                  cx.notify();
                })),
              )
              .child(div().px(5).py(1).rounded(4).bg(stateColor + "22").text_size(10.5).font_semibold().text_color(stateColor).child(`#${pr.number} · ${prStateLabel(pr)}`))
              .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12).text_color(t.foreground).child(pr.title))
              .when(!this.standalonePr, el =>
                el.child(this.actionBtn(t, "pr-tab", "↗Tab", "Open PR in new tab", () => this.openPullRequestInNewTab(pr))),
              )
              .child(this.actionBtn(t, "pr-checkout", this.prCheckingOut ? "…" : "Checkout", "Checkout PR branch locally (gh pr checkout)", (_e, cx) => this.checkoutSelectedPr(cx)))
              .when(Boolean(pr.url), el =>
                el.child(this.actionBtn(t, "pr-browser", "↗", "Open PR in browser", (_e, cx) => cx.open_url(pr.url))),
              ),
          )
          .child(
            div()
              .pl(this.standalonePr ? 4 : 24)
              .text_size(11)
              .text_color(t.dim)
              .truncate()
              .child(`@${pr.author}${prDate ? ` · ${prDate}` : ""}${branchSummary ? ` · ${branchSummary}` : ""} · +${pr.additions} −${pr.deletions} · ${this.prFiles.length} file${this.prFiles.length === 1 ? "" : "s"}`),
          ),
      )
      .child(
        div()
          .flex_1()
          .min_h(44)
          .max_h(Math.min(200, this.prFiles.length * 26 + 12))
          .relative()
          .border_b(1)
          .border_color(t.border)
          .child(
            v_flex()
              .id("pr-files-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(6)
              .children(
                this.prFiles.map(f => {
                  const parts = f.path.split("/"), name = parts.pop();
                  return h_flex()
                    .id(`prf-${f.path}`)
                    .h(26)
                    .flex_none()
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(this.prOpenFile === f.path, e => e.bg(t.selected))
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.pickPrFile(f.path, cx))
                    .child(image(fileIcon(name)).w(15).h(15).flex_none())
                    .child(div().flex_none().max_w(160).truncate().text_size(12).text_color(scmColor(f.status)).when(f.status === "D", e => e.line_through()).child(name))
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
                    .when(f.add > 0, e => e.child(div().text_size(10.5).text_color(DIFF_COLORS.addSign).child(`+${f.add}`)))
                    .when(f.del > 0, e => e.child(div().text_size(10.5).text_color(DIFF_COLORS.delSign).child(`−${f.del}`)))
                    .child(div().w(14).text_right().text_size(11).font_semibold().text_color(scmColor(f.status)).child(f.status));
                }),
              )
              .when(!this.prFiles.length, e =>
                e.child(div().p(8).text_size(12).text_color(t.dim).child(this.prDetailLoading ? "Loading pull request…" : "No files changed")),
              ),
          )
          .child(Scrollbar.vertical("pr-files-list").absolute().inset_0()),
      )
      .child(
        this.renderVirtualizedDiff({
          listId: "pr-diff",
          xId: "pr-diff-x",
          rows: this.prRows,
          longest: this.prLongest,
          gutterChars: this.prGutterChars,
          size,
          t,
          scrollHandle: this.prDiffScroll,
          overviewBuckets: this.prOverviewBuckets,
        }),
      );
  }

  renderStandaloneFileDiff(t, size) {
    const file = this.standaloneFile;
    const name = file.path.split("/").pop() || file.path;
    const showHunkBadges = this.canActOnHunks(file);
    return v_flex()
      .id("changes-filediff-tab")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.pendingConfirm) {
          this.pendingConfirm = null;
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(12)
          .gap(7)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(image(fileIcon(name)).w(16).h(16).flex_none())
          .child(div().px(5).py(1).rounded(4).bg(t.surface).text_size(10.5).font_semibold().text_color(scmColor(file.status)).child(file.staged ? `Staged · ${file.status}` : file.status))
          .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12).text_color(t.foreground).child(file.path))
          .child(
            div()
              .id("sfd-toggle-staged")
              .px(6)
              .py(2)
              .rounded(4)
              .bg(file.staged ? t.selected : t.surface)
              .text_size(10.5)
              .text_color(file.staged ? t.foreground : t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip(file.staged ? "Switch to Working Tree diff" : "Switch to Staged diff")
              .on_click((_e, cx) => this.toggleStandaloneStaged(cx))
              .child(file.staged ? "Staged ⇄" : "Working ⇄"),
          )
          .child(
            this.actionBtn(
              t,
              "sfd-file-stage",
              file.staged ? "− File" : "+ File",
              file.staged ? "Unstage entire file" : "Stage entire file",
              (_e, cx) => this.runStandaloneFileAction(!file.staged, cx),
            ),
          )
          .child(this.renderVSCodeButton(t, "sfd-vscode", file.status === "D" ? null : file.path))
          .child(this.actionBtn(t, "sfd-refresh", "↻", "Refresh diff", (_e, cx) => this.loadStandaloneFileDiff(cx)))
          .child(this.actionBtn(t, "sfd-open", "↗", "Open full file", (e) => this.openInViewer(file.path, e))),
      )
      .when(showHunkBadges, el => el.child(this.renderHunkBar(file, t, "sfd")))
      .when(Boolean(this.pendingConfirm), el => el.child(this.renderPendingConfirm(t)))
      .when(Boolean(this.note), el => el.child(this.renderNoteBar(t)))
      .child(
        this.renderVirtualizedDiff({
          listId: "sfd-diff",
          xId: "sfd-diff-x",
          rows: this.rows,
          longest: this.longest,
          gutterChars: this.gutterChars,
          size,
          t,
          scrollHandle: this.diffScroll,
          overviewBuckets: this.overviewBuckets,
          showHunkBadges,
          selectHunks: true,
        }),
      );
  }

  render(cx) {
    const t = theme(), s = settings(), size = s.font_size, fontFamily = s.font_family ?? s.font;
    if (this.standaloneCommit && this.selectedCommit) {
      if (!checking()) this.checkStandaloneHibernation(cx, true);
      return v_flex()
        .id("changes-commit-tab")
        .size_full()
        .min_h(0)
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(13)
        .when(Boolean(fontFamily), el => el.font_family(fontFamily))
        .child(this.renderCommitDetail(t, size));
    }
    if (this.standaloneFileDiff && this.standaloneFile) {
      if (!checking()) {
        this.checkStandaloneHibernation(cx, true);
        this.checkSharedDiffOpen(cx, true);
      }
      return this.renderStandaloneFileDiff(t, size).when(Boolean(fontFamily), el => el.font_family(fontFamily));
    }
    if (this.standalonePr && this.selectedPr) {
      if (!checking()) this.checkStandaloneHibernation(cx, true);
      return v_flex()
        .id("changes-pr-tab")
        .size_full()
        .min_h(0)
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(13)
        .when(Boolean(fontFamily), el => el.font_family(fontFamily))
        .child(this.renderPrDetail(t, size));
    }
    if (!checking()) {
      if (isChangesPanelVisible() && key() !== this.context?.key) this.refresh(cx);
      else this.refreshIfDue(cx);
    }
    const totalChanges = this.staged.length + this.unstaged.length;
    const canCommit = Boolean(this.message.trim() && this.root && !this.busy && !this.hunkBusy && !this.loading && this.conflicts.length === 0 && totalChanges > 0);

    return v_flex()
      .id("changes")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .track_focus(this.handle)
      .on_size_change((size) => {
        this.panelHeight = size.height / (settings().zoom || 1);
      })
      .on_window_mouse_move((e, cx) => {
        if (!this.draggingSplit) return;
        if (e.pressed_button !== "left") {
          this.draggingSplit = null;
          localStorage.setItem("sc.bottomH", String(this.bottomPaneH));
          cx.notify();
          return;
        }
        const z = settings().zoom || 1;
        const dy = ((e.position?.y ?? 0) - this.draggingSplit.startY) / z;
        const maxH = Math.max(140, this.panelHeight - 220);
        this.bottomPaneH = Math.round(Math.max(80, Math.min(maxH, this.draggingSplit.startH - dy)));
        cx.notify();
      })
      .on_window_mouse_up("left", (_e, cx) => {
        if (!this.draggingSplit) return;
        this.draggingSplit = null;
        localStorage.setItem("sc.bottomH", String(this.bottomPaneH));
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.pendingConfirm) {
          this.pendingConfirm = null;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (e.key === "escape" && this.branchPickerOpen) {
          this.branchPickerOpen = false;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (e.key === "escape" && (this.stashMenuOpen || this.commitMenuOpen)) {
          this.stashMenuOpen = false;
          this.commitMenuOpen = false;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (e.key === "escape" && this.typing) {
          this.typing = false;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(10)
          .gap(4)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().text_size(12.5).child("Changes"))
          .when(Boolean(this.branch), el =>
            el.child(
              h_flex()
                .id("sc-branch-link")
                .px(6)
                .py(1)
                .gap(4)
                .items_center()
                .rounded(4)
                .bg(t.surface)
                .text_size(10.5)
                .text_color(this.remoteBranchUrl ? t.accent : t.dim)
                .max_w(140)
                .when(Boolean(this.remoteBranchUrl), b =>
                  b
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover).text_color(t.foreground))
                    .tooltip(`Open remote branch in browser\n${this.remoteBranchUrl}`)
                    .on_click((_e, cx) => cx.open_url(this.remoteBranchUrl)),
                )
                .child(div().flex_1().min_w(0).truncate().child(this.branch))
                .when(Boolean(this.remoteBranchUrl), b => b.child(div().flex_none().text_size(10).child("↗"))),
            ),
          )
          .child(div().flex_1())
          .when(Boolean(this.root), el =>
            el
              .child(this.actionBtn(t, "sc-stash", "S+", "Stash changes (uses message if set)", (_e, cx) => this.stashPush(cx, "all")))
              .child(this.actionBtn(t, "sc-stash-menu", "▾", "Stash options", (_e, cx) => {
                this.commitMenuOpen = false;
                this.stashMenuOpen = !this.stashMenuOpen;
                cx.notify();
              }))
              .child(this.actionBtn(t, "sc-pull", "↓", "Git pull", (_e, cx) => this.runGitAction(["pull"], cx)))
              .child(this.actionBtn(t, "sc-push", "↑", "Git push", (_e, cx) => this.runGitAction(["push"], cx)))
              .child(this.renderVSCodeButton(t, "sc-vscode", null))
              .child(this.actionBtn(t, "sc-refresh", "↻", "Refresh", (_e, cx) => this.refresh(cx, true))),
          ),
      )
      .when(Boolean(this.selectedCommit), el => el.child(this.renderCommitDetail(t, size)))
      .when(!this.selectedCommit && Boolean(this.selectedPr), el => el.child(this.renderPrDetail(t, size)))
      .when(!this.selectedCommit && !this.selectedPr, el =>
        el
          .when(Boolean(this.root) && this.stashMenuOpen, sm =>
            sm.child(
              v_flex()
                .id("sc-stash-dropdown")
                .flex_none()
                .mx(8)
                .mt(4)
                .p(4)
                .gap(2)
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .children([
                  { id: "all", label: "Stash All (incl. untracked)" },
                  { id: "tracked", label: "Stash Tracked" },
                  { id: "staged", label: "Stash Staged" },
                ].map(opt =>
                  h_flex()
                    .id(`stash-opt-${opt.id}`)
                    .h(24)
                    .px(8)
                    .items_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.stashPush(cx, opt.id))
                    .child(div().text_size(11.5).text_color(t.foreground).child(opt.label)),
                )),
            ),
          )
          .when(Boolean(this.root), box =>
            box.child(
              v_flex()
                .flex_none()
                .p(8)
                .gap(6)
                .border_b(1)
                .border_color(t.border)
                .child(
                  div()
                    .id("commit-message")
                    .h(30)
                    .px(8)
                    .flex()
                    .items_center()
                    .rounded(6)
                    .bg(t.surface)
                    .border_1()
                    .border_color(this.typing ? t.accent : t.border)
                    .cursor_text()
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)),
                )
                .child(
                  h_flex()
                    .gap(4)
                    .child(
                      div()
                        .id("commit-btn")
                        .flex_1()
                        .h(28)
                        .rounded(6)
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(canCommit ? t.solid : t.raised)
                        .text_color(canCommit ? t.solid_foreground : t.dim)
                        .text_size(12)
                        .font_medium()
                        .when(canCommit, b => b.cursor_pointer())
                        .on_click((_e, cx) => this.commit(cx, "smart"))
                        .child(this.busy ? "Working…" : this.staged.length > 0 ? `✓ Commit (${this.staged.length} staged)` : "✓ Commit"),
                    )
                    .child(
                      div()
                        .id("commit-menu-btn")
                        .w(28)
                        .h(28)
                        .rounded(6)
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(this.commitMenuOpen ? t.selected : t.raised)
                        .text_color(t.foreground)
                        .text_size(11)
                        .cursor_pointer()
                        .hover(s => s.bg(t.hover))
                        .tooltip("Commit options")
                        .on_click((_e, cx) => {
                          this.stashMenuOpen = false;
                          this.commitMenuOpen = !this.commitMenuOpen;
                          cx.notify();
                        })
                        .child("▾"),
                    ),
                )
                .when(this.commitMenuOpen, cm =>
                  cm.child(
                    v_flex()
                      .id("sc-commit-dropdown")
                      .p(4)
                      .gap(2)
                      .rounded(6)
                      .bg(t.surface)
                      .border_1()
                      .border_color(t.border)
                      .children([
                        { id: "smart", label: "✓ Commit" },
                        { id: "staged", label: "✓ Commit Staged" },
                        { id: "push", label: "↑ Commit & Push" },
                        { id: "amend", label: "✎ Commit (Amend)" },
                      ].map(opt =>
                        h_flex()
                          .id(`commit-opt-${opt.id}`)
                          .h(24)
                          .px(8)
                          .items_center()
                          .rounded(4)
                          .cursor_pointer()
                          .hover(s => s.bg(t.hover))
                          .on_click((_e, cx) => this.commit(cx, opt.id))
                          .child(div().text_size(11.5).text_color(t.foreground).child(opt.label)),
                      )),
                  ),
                ),
            ),
          )
          .when(Boolean(this.pendingConfirm), el => el.child(this.renderPendingConfirm(t)))
          .when(Boolean(this.note), el => el.child(this.renderNoteBar(t)))
          .when(!this.root, e =>
            e.child(div().flex_1().p(12).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : "Not a git repository"))),
          )
          .when(Boolean(this.root), body => {
            const bottomOpen = this.secStashes || this.secGraph || this.secPrs;
            const activeBranchLabel = this.graphBranchRef === "__all__"
              ? "All"
              : (this.graphBranchLabel || this.branch || "HEAD");
            return body
              .child(
                v_flex()
                  .id("sc-sections")
                  .flex_1()
                  .min_h(80)
                  .overflow_y_scrollbar()
                  .py(4)
                  .when(this.conflicts.length > 0, m =>
                    m
                      .child(this.sectionHeader(t, "sec-merge", "Merge Changes", this.secMerge, this.conflicts.length, (_e, cx) => {
                        this.secMerge = !this.secMerge;
                        cx.notify();
                      }))
                      .when(this.secMerge, list => list.child(v_flex().px(4).pb(4).children(this.conflicts.map(f => this.fileRow(f, t))))),
                  )
                  .when(this.staged.length > 0, s =>
                    s
                      .child(this.sectionHeader(t, "sec-staged", "Staged Changes", this.secStaged, this.staged.length, (_e, cx) => {
                        this.secStaged = !this.secStaged;
                        cx.notify();
                      }, [this.actionBtn(t, "sc-unstage-all", "−", "Unstage all", (_e, cx) => this.unstageAll(cx))]))
                      .when(this.secStaged, list => list.child(v_flex().px(4).pb(4).children(this.staged.map(f => this.fileRow(f, t))))),
                  )
                  .child(this.sectionHeader(t, "sec-changes", "Changes", this.secChanges, this.unstaged.length, (_e, cx) => {
                    this.secChanges = !this.secChanges;
                    cx.notify();
                  }, this.unstaged.length > 0 ? [
                    this.actionBtn(t, "sc-stash-sec", "S+", "Stash all changes", (_e, cx) => this.stashPush(cx, "all")),
                    this.actionBtn(t, "sc-stage-all", "+", "Stage all changes", (_e, cx) => this.stageAll(cx)),
                  ] : []))
                  .when(this.secChanges, list =>
                    list.child(
                      v_flex()
                        .px(4)
                        .pb(4)
                        .children(this.unstaged.map(f => this.fileRow(f, t)))
                        .when(!this.unstaged.length && !this.staged.length && !this.conflicts.length, empty =>
                          empty.child(div().px(14).py(6).text_size(11.5).text_color(t.dim).child("No uncommitted changes")),
                        ),
                    ),
                  ),
              )
              .child(
                div()
                  .id("sc-split-drag")
                  .h(6)
                  .flex_none()
                  .cursor_row_resize()
                  .flex()
                  .items_center()
                  .hover(s => s.bg(t.accent + "44"))
                  .when(Boolean(this.draggingSplit), el => el.bg(t.accent + "66"))
                  .tooltip("Drag up/down to resize Stashes & Graph")
                  .on_mouse_down("left", (e, cx) => {
                    cx.stop_propagation();
                    if (!this.secStashes && !this.secGraph && !this.secPrs) {
                      this.secGraph = true;
                      if (this.branchesLoadedFor !== this.root) this.loadBranches(cx);
                      if (this.historyLoadedFor !== this.root && !this.historyLoading) {
                        this.loadHistory(cx, true);
                      }
                    }
                    this.draggingSplit = { startY: e.position?.y ?? 0, startH: this.bottomPaneH };
                    cx.notify();
                  })
                  .child(div().w_full().h(1).bg(this.draggingSplit ? t.accent : t.border)),
              )
              .child(
                v_flex()
                  .id("sc-bottom")
                  .flex_none()
                  .when(bottomOpen, el => el.h(this.bottomPaneH).overflow_y_scrollbar())
                  .pb(4)
                  .child(
                    this.sectionHeader(t, "sec-stashes", "Stashes", this.secStashes, this.stashes.length, (_e, cx) => {
                      this.secStashes = !this.secStashes;
                      cx.notify();
                    }, [
                      div()
                        .id("sc-stash-keep-index")
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(this.stashKeepIndex ? t.selected : t.surface)
                        .text_size(10)
                        .text_color(this.stashKeepIndex ? t.foreground : t.dim)
                        .cursor_pointer()
                        .hover(s => s.bg(this.stashKeepIndex ? t.selected : t.hover).text_color(t.foreground))
                        .tooltip("Restore staged state when applying/popping (--index)")
                        .on_click((_e, cx) => {
                          cx.stop_propagation();
                          this.stashKeepIndex = !this.stashKeepIndex;
                          localStorage.setItem("sc.stashIndex", this.stashKeepIndex ? "1" : "0");
                          cx.notify();
                        })
                        .child("Keep staged"),
                      ...(this.stashes.length > 0 ? [this.actionBtn(t, "sc-stash-clear", "Clear", "Clear all stashes", (_e, cx) => this.requestClearStashes(cx))] : []),
                      this.actionBtn(t, "sc-stash-add", "+", "Create stash", (_e, cx) => this.stashPush(cx, "all")),
                    ]),
                  )
                  .when(this.secStashes, list =>
                    list.child(
                      v_flex()
                        .px(6)
                        .pb(4)
                        .gap(2)
                        .when(!this.stashes.length, empty =>
                          empty.child(div().px(10).py(4).text_size(11.5).text_color(t.dim).child("No stashes")),
                        )
                        .children(
                          this.stashes.map(st =>
                            h_flex()
                              .id(`stash-${st.ref}`)
                              .h(26)
                              .px(8)
                              .gap(4)
                              .items_center()
                              .rounded(6)
                              .cursor_pointer()
                              .hover(s => s.bg(t.hover))
                              .tooltip(`${st.ref}\n${st.message}\n${st.relDate}\nClick: inspect stash · Ctrl+Click: open in new tab`)
                              .on_click((e, cx) => {
                                const stashCommit = {
                                  hash: st.ref,
                                  shortHash: st.ref,
                                  subject: st.message,
                                  author: "stash",
                                  relDate: st.relDate,
                                  date: "",
                                  stash: st.ref,
                                  refs: [],
                                };
                                if (e?.modifiers?.control || e?.modifiers?.platform) {
                                  this.openCommitInNewTab(stashCommit);
                                } else {
                                  this.openCommit(stashCommit, cx);
                                }
                              })
                              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(st.message))
                              .child(this.actionBtn(t, `st-apply-${st.ref}`, "Apply", "Apply stash (keep in list)", (_e, cx) => this.stashApply(st.ref, cx)))
                              .child(this.actionBtn(t, `st-pop-${st.ref}`, "Pop", "Pop stash (apply & remove)", (_e, cx) => this.stashPop(st.ref, cx)))
                              .child(this.actionBtn(t, `st-drop-${st.ref}`, "×", "Drop stash", (_e, cx) => this.requestDropStash(st, cx))),
                          ),
                        ),
                    ),
                  )
                  .child(
                    div()
                      .border_t(1)
                      .border_color(t.border)
                      .child(this.sectionHeader(t, "sec-graph", "Graph", this.secGraph, this.commits.length || null, (_e, cx) => {
                        this.secGraph = !this.secGraph;
                        if (!this.secGraph) {
                          this.commits = [];
                          this.branches = [];
                          this.branchesLoadedFor = null;
                          this.branchPickerOpen = false;
                          this.historyLimit = 50;
                          this.historyLoadedFor = null;
                          this.historyBefore = null;
                          this.historyBeforeStack = [];
                          cx.notify();
                          return;
                        }
                        if (this.branchesLoadedFor !== this.root) this.loadBranches(cx);
                        if (this.historyLoadedFor !== this.root && !this.historyLoading) {
                          this.loadHistory(cx, true);
                        } else {
                          cx.notify();
                        }
                      }, this.secGraph ? [
                        div()
                          .id("sc-branch-picker-btn")
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(this.branchPickerOpen ? t.selected : t.surface)
                          .border_1()
                          .border_color(this.branchPickerOpen ? t.accent : t.border)
                          .text_size(10.5)
                          .text_color(this.branchPickerOpen ? t.foreground : t.muted)
                          .max_w(120)
                          .truncate()
                          .cursor_pointer()
                          .hover(s => s.bg(t.hover).text_color(t.foreground))
                          .tooltip(`Branch filter: ${activeBranchLabel}\nClick to choose branch`)
                          .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.branchPickerOpen = !this.branchPickerOpen;
                            if (this.branchPickerOpen && this.branchesLoadedFor !== this.root) {
                              this.loadBranches(cx);
                            }
                            cx.notify();
                          })
                          .child(`⎇ ${activeBranchLabel} ▾`),
                        this.actionBtn(t, "sc-hist-ref", "↻", "Refresh history", (_e, cx) => {
                          this.loadBranches(cx);
                          this.loadHistory(cx, true);
                        }),
                      ] : [])),
                  )
                  .when(this.secGraph, list =>
                    list.child(
                      v_flex()
                        .px(4)
                        .pb(6)
                        .gap(3)
                        .child(
                          h_flex()
                            .id("graph-search-box")
                            .mx(4)
                            .mt(2)
                            .h(26)
                            .px(7)
                            .gap(4)
                            .items_center()
                            .rounded(6)
                            .bg(t.surface)
                            .border_1()
                            .border_color(t.border)
                            .cursor_text()
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .child(Input.new(this.graphSearchInput).flex_1().h_full().text_size(11.5).text_color(t.foreground))
                            .when(Boolean(this.graphQuery), clr =>
                              clr.child(this.actionBtn(t, "graph-search-clear", "×", "Clear search", (_e, cx) => {
                                this.graphQuery = "";
                                this.graphSearchInput?.set_value("");
                                this.historyBefore = null;
                                this.historyBeforeStack = [];
                                this.loadHistory(cx, true);
                              })),
                            ),
                        )
                        .when(Boolean(this.historyBefore), pg =>
                          pg.child(
                            h_flex()
                              .mx(4)
                              .px(8)
                              .py(4)
                              .gap(6)
                              .items_center()
                              .rounded(6)
                              .bg(t.surface)
                              .border_1()
                              .border_color(t.border)
                              .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(`Page ${this.historyBeforeStack.length + 1} · before ${this.historyBefore.label}`))
                              .child(this.actionBtn(t, "hist-page-newer", "← Newer", "Previous newer page", (_e, cx) => this.pageHistoryNewer(cx)))
                              .child(this.actionBtn(t, "hist-page-latest", "Latest", "Back to latest commits", (_e, cx) => this.resetHistoryDatePage(cx))),
                          ),
                        )
                        .when(this.branchPickerOpen, bp => {
                          const branchListH = Math.min(180, (2 + this.branches.length) * 25 + 10);
                          return bp.child(
                            v_flex()
                              .id("graph-branch-list")
                              .mx(4)
                              .h(branchListH)
                              .flex_none()
                              .overflow_y_scrollbar()
                              .p(4)
                              .gap(1)
                              .rounded(6)
                              .bg(t.surface)
                              .border_1()
                              .border_color(t.border)
                              .child(
                                h_flex()
                                  .id("br-opt-current")
                                  .h(24)
                                  .flex_none()
                                  .px(6)
                                  .gap(6)
                                  .items_center()
                                  .rounded(4)
                                  .cursor_pointer()
                                  .when(!this.graphBranchRef, el => el.bg(t.selected))
                                  .hover(s => s.bg(t.hover))
                                  .on_click((_e, cx) => this.selectGraphBranch("", "", cx))
                                  .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(`Current (${this.branch || "HEAD"})`)),
                              )
                              .child(
                                h_flex()
                                  .id("br-opt-all")
                                  .h(24)
                                  .flex_none()
                                  .px(6)
                                  .gap(6)
                                  .items_center()
                                  .rounded(4)
                                  .cursor_pointer()
                                  .when(this.graphBranchRef === "__all__", el => el.bg(t.selected))
                                  .hover(s => s.bg(t.hover))
                                  .on_click((_e, cx) => this.selectGraphBranch("__all__", "All", cx))
                                  .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child("All branches")),
                              )
                              .children(
                                this.branches.map(br =>
                                  h_flex()
                                    .id(`br-opt-${br.fullRef}`)
                                    .h(24)
                                    .flex_none()
                                    .px(6)
                                    .gap(6)
                                    .items_center()
                                    .rounded(4)
                                    .cursor_pointer()
                                    .when(this.graphBranchRef === br.fullRef, el => el.bg(t.selected))
                                    .hover(s => s.bg(t.hover))
                                    .on_click((_e, cx) => this.selectGraphBranch(br.fullRef, br.label, cx))
                                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(br.isRemote ? t.muted : t.foreground).child(br.label))
                                    .when(br.isRemote, el => el.child(div().text_size(9.5).text_color(t.dim).child("remote"))),
                                ),
                              ),
                          );
                        })
                        .when(Boolean(this.historyError), e => e.child(div().px(10).py(6).text_size(11.5).text_color(t.ansi1).child(this.historyError)))
                        .when(!this.commits.length && !this.historyError, e =>
                          e.child(div().px(10).py(6).text_size(11.5).text_color(t.dim).child(this.historyLoading ? "Loading commits…" : this.graphQuery.trim() ? "No matching commits" : "No commits yet")),
                        )
                        .children(
                          this.commits.map(c =>
                            h_flex()
                              .id(`commit-${c.hash}`)
                              .h(26)
                              .px(8)
                              .gap(6)
                              .items_center()
                              .rounded(6)
                              .cursor_pointer()
                              .hover(s => s.bg(t.hover))
                              .tooltip(`${c.shortHash} · ${c.subject}\n${c.author} · ${c.date ? `${c.date} (${c.relDate})` : c.relDate}\nCtrl+Click: open in new tab`)
                              .on_click((e, cx) => {
                                if (e?.modifiers?.control || e?.modifiers?.platform) {
                                  this.openCommitInNewTab(c);
                                } else {
                                  this.openCommit(c, cx);
                                }
                              })
                              .child(div().size(7).flex_none().rounded(999).bg(c.refs.length ? t.ansi2 : t.accent))
                              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(c.subject))
                              .when(c.refs.length > 0, el =>
                                el.child(div().px(4).py(0.5).rounded(4).bg(t.ansi2 + "22").text_size(9.5).font_semibold().text_color(t.ansi2).truncate().max_w(70).child(c.refs[0].replace(/^HEAD -> /, ""))),
                              )
                              .when(Boolean(c.date), el =>
                                el.child(div().flex_none().text_size(10).text_color(t.muted).child(c.date)),
                              )
                              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.shortHash)),
                          ),
                        )
                        .when(this.commits.length >= this.historyLimit && this.historyLimit < MAX_HISTORY_LIMIT && !this.historyLoading, el =>
                          el.child(
                            div()
                              .id("hist-load-more")
                              .mt(4)
                              .mx(6)
                              .py(5)
                              .rounded(6)
                              .bg(t.surface)
                              .text_center()
                              .text_size(11)
                              .text_color(t.muted)
                              .cursor_pointer()
                              .hover(s => s.bg(t.hover).text_color(t.foreground))
                              .on_click((_e, cx) => {
                                const step = this.historyLimit >= 200 ? 100 : 50;
                                this.historyLimit = Math.min(MAX_HISTORY_LIMIT, this.historyLimit + step);
                                this.loadHistory(cx, false);
                              })
                              .child(this.historyLimit >= 200 ? `Load 100 more commits (max ${MAX_HISTORY_LIMIT}/page)` : `Load 50 more commits (max ${MAX_HISTORY_LIMIT}/page)`),
                          ),
                        )
                        .when(this.commits.length >= MAX_HISTORY_LIMIT && !this.historyLoading, el => {
                          const last = this.commits[this.commits.length - 1];
                          const lastDate = last?.date || "oldest shown";
                          return el.child(
                            v_flex()
                              .mt(4)
                              .mx(6)
                              .p(6)
                              .gap(5)
                              .rounded(6)
                              .bg(t.surface)
                              .border_1()
                              .border_color(t.border)
                              .child(div().text_center().text_size(10.5).text_color(t.dim).child(`Page limit reached (${MAX_HISTORY_LIMIT} commits max per page)`))
                              .child(
                                div()
                                  .id("hist-page-older")
                                  .py(4)
                                  .rounded(5)
                                  .bg(t.raised)
                                  .text_center()
                                  .text_size(11)
                                  .font_medium()
                                  .text_color(t.foreground)
                                  .cursor_pointer()
                                  .hover(s => s.bg(t.hover))
                                  .on_click((_e, cx) => this.pageHistoryOlder(cx))
                                  .child(`Older commits (before ${lastDate}) →`),
                              ),
                          );
                        }),
                    ),
                  )
                  .child(
                    div()
                      .border_t(1)
                      .border_color(t.border)
                      .child(this.sectionHeader(t, "sec-prs", "Pull Requests", this.secPrs, this.prs.length || null, (_e, cx) => {
                        this.secPrs = !this.secPrs;
                        if (!this.secPrs) {
                          this.prs = [];
                          this.prLoadedFor = null;
                          this.prError = null;
                          cx.notify();
                          return;
                        }
                        if (this.prLoadedFor !== this.root && !this.prLoading) {
                          this.loadPullRequests(cx);
                        } else {
                          cx.notify();
                        }
                      }, this.secPrs ? [this.actionBtn(t, "sc-pr-ref", "↻", "Refresh pull requests", (_e, cx) => this.loadPullRequests(cx))] : [])),
                  )
                  .when(this.secPrs, list =>
                    list.child(
                      v_flex()
                        .px(4)
                        .pb(6)
                        .gap(3)
                        .child(
                          h_flex()
                            .id("pr-search-box")
                            .mx(4)
                            .mt(2)
                            .h(26)
                            .px(7)
                            .gap(4)
                            .items_center()
                            .rounded(6)
                            .bg(t.surface)
                            .border_1()
                            .border_color(t.border)
                            .cursor_text()
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .child(Input.new(this.prSearchInput).flex_1().h_full().text_size(11.5).text_color(t.foreground))
                            .when(Boolean(this.prQuery), clr =>
                              clr.child(this.actionBtn(t, "pr-search-clear", "×", "Clear PR search", (_e, cx) => {
                                this.prQuery = "";
                                this.prSearchInput?.set_value("");
                                this.loadPullRequests(cx);
                              })),
                            ),
                        )
                        .child(
                          h_flex()
                            .mx(4)
                            .gap(4)
                            .items_center()
                            .children(
                              [
                                { id: "open", label: "Open" },
                                { id: "merged", label: "Merged" },
                                { id: "closed", label: "Closed" },
                                { id: "all", label: "All" },
                              ].map(opt => {
                                const active = this.prState === opt.id;
                                return div()
                                  .id(`pr-state-${opt.id}`)
                                  .px(7)
                                  .py(2)
                                  .rounded(5)
                                  .bg(active ? t.selected : t.surface)
                                  .text_size(10.5)
                                  .when(active, el => el.font_semibold().text_color(t.foreground))
                                  .when(!active, el => el.text_color(t.muted))
                                  .cursor_pointer()
                                  .hover(s => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
                                  .on_click((_e, cx) => {
                                    if (this.prState === opt.id) return;
                                    this.prState = opt.id;
                                    this.loadPullRequests(cx);
                                  })
                                  .child(opt.label);
                              }),
                            ),
                        )
                        .when(Boolean(this.prError), e => e.child(div().px(10).py(6).text_size(11.5).text_color(t.ansi1).child(this.prError)))
                        .when(!this.prs.length && !this.prError, e =>
                          e.child(div().px(10).py(6).text_size(11.5).text_color(t.dim).child(this.prLoading ? "Loading pull requests…" : "No pull requests found")),
                        )
                        .children(
                          this.prs.map(pr => {
                            const dotColor = prStateColor(pr, t);
                            const prDate = pr.updatedDate || pr.createdDate || "";
                            return h_flex()
                              .id(`pr-row-${pr.number}`)
                              .h(26)
                              .px(8)
                              .gap(6)
                              .items_center()
                              .rounded(6)
                              .cursor_pointer()
                              .hover(s => s.bg(t.hover))
                              .tooltip(`#${pr.number} · ${pr.title}\n@${pr.author} · ${prStateLabel(pr)}${prDate ? ` · ${prDate}` : ""}${pr.headRefName ? `\n${pr.headRefName} → ${pr.baseRefName}` : ""}\nClick: inspect PR · Ctrl+Click: open in new tab`)
                              .on_click((e, cx) => {
                                if (e?.modifiers?.control || e?.modifiers?.platform) {
                                  this.openPullRequestInNewTab(pr);
                                } else {
                                  this.openPullRequest(pr, cx);
                                }
                              })
                              .child(div().size(7).flex_none().rounded(999).bg(dotColor))
                              .child(div().flex_none().text_size(10.5).font_semibold().text_color(dotColor).child(`#${pr.number}`))
                              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(pr.title))
                              .when(Boolean(prDate), el =>
                                el.child(div().flex_none().text_size(10).text_color(t.muted).child(prDate)),
                              )
                              .when(Boolean(pr.url), el =>
                                el.child(this.actionBtn(t, `pr-open-${pr.number}`, "↗", "Open PR in GitHub", (_e, cx) => cx.open_url(pr.url))),
                              );
                          }),
                        ),
                    ),
                  ),
              );
          })
          .when(Boolean(this.open), diffArea => {
            const openFile = (this.open.staged ? this.staged : [...this.unstaged, ...this.conflicts]).find(f => f.path === this.open.path) ?? this.open;
            const showHunkBadges = this.canActOnHunks(openFile);
            return diffArea.child(
              v_flex()
                .flex_1()
                .min_h(120)
                .border_t(1)
                .border_color(t.border)
                .child(
                  h_flex()
                    .h(26)
                    .flex_none()
                    .px(10)
                    .gap(6)
                    .items_center()
                    .bg(t.surface)
                    .border_b(1)
                    .border_color(t.border)
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(`${this.open.staged ? "Staged: " : ""}${this.open.path}`))
                    .child(this.actionBtn(t, "sc-diff-open", "↗", "Open in viewer", (e) => this.openInViewer(this.open.path, e)))
                    .child(this.actionBtn(t, "sc-diff-x", "×", "Close diff", (_e, cx) => { this.open = null; this.setLines([]); cx.notify(); })),
                )
                .when(showHunkBadges, el => el.child(this.renderHunkBar(openFile, t, "inl")))
                .child(
                  this.renderVirtualizedDiff({
                    listId: "changes-diff",
                    xId: "changes-diff-x",
                    rows: this.rows,
                    longest: this.longest,
                    gutterChars: this.gutterChars,
                    size,
                    t,
                    scrollHandle: this.diffScroll,
                    overviewBuckets: this.overviewBuckets,
                    showHunkBadges,
                    selectHunks: true,
                  }),
                ),
            );
          }),
      );
  }
}
