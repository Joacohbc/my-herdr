import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, layout, checking, run, shared, setShared, props } from "herdr";
import { fileIcon, releaseIconCache } from "./material-icons.js";
import { listPullRequests, loadPullRequestDetail, checkoutPullRequest, buildRemoteBranchUrl } from "./github.js";

const scans = globalThis[Symbol.for("herdr.changesStatus.v3")] ??= new Map();
const MAX_SCANS = 4;
const MAX_DIFF_LINES = 1000;
const MAX_DIFF_LINE_CHARS = 2000;
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

function parsePorcelain(stdout) {
  const entries = (stdout || "").split("\0").filter(Boolean);
  const shown = entries.slice(0, 1000);
  const staged = [];
  const unstaged = [];
  const uniquePaths = new Set();

  for (const entry of shown) {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (!path) continue;
    uniquePaths.add(path);
    if (x === "?" && y === "?") {
      unstaged.push({ path, status: "U", untracked: true, staged: false });
      continue;
    }
    if (x !== " " && x !== "?") {
      staged.push({ path, status: x, untracked: false, staged: true });
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ path, status: y, untracked: false, staged: false });
    }
  }
  return { staged, unstaged, limited: entries.length > 1000, count: uniquePaths.size };
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
          const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
          next.ok = r.code === 0;
          if (next.ok) next.parsed = parsePorcelain(r.stdout);
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
  const fallbackTermPane = pane && !pane.cwd && f?.tab
    ? allPanes.find(p => p.tab === f.tab && p.cwd)
    : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || fallbackTermPane?.cwd || f?.cwd || space?.folder, on, space: space?.id ?? null };
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

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

function statusColor(status, t) {
  if (status === "A" || status === "U") return t.ansi2;
  if (status === "D") return t.ansi1;
  if (status === "R") return t.ansi4;
  return t.blocked;
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
    this.stashes = [];
    this.open = null;
    this.rows = [];
    this.longest = 0;
    this.gutterChars = 4;
    this.message = "";
    this.handle = cx.focus_handle();

    this.secStaged = true;
    this.secChanges = true;
    this.secStashes = false;
    this.secGraph = false;
    this.secPrs = false;
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
    this.prLongest = 0;
    this.prGutterChars = 4;
    this.prDetailLoading = false;
    this.prCheckingOut = false;

    this.hiddenSince = 0;
    this.evicted = false;
    this.hibernated = false;
    this.lastGcSeq = shared("herdr.gc")?.seq ?? 0;
    this.lastBadgeAt = 0;
    this.lastBadgeLoc = "";
    this.badgeChecking = false;
    this.standalonePaneId = null;

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
          [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
          { cwd: loc.cwd, on: loc.on, timeout: 5000 },
        );
        if (r.code !== 0) {
          this.publishBadgeCount(0, loc.space);
          return;
        }
        const unique = new Set();
        for (const entry of (r.stdout || "").split("\0")) {
          if (entry.length > 3) unique.add(entry.slice(3));
          if (unique.size >= 999) break;
        }
        this.publishBadgeCount(unique.size, loc.space);
      } catch {
        // Ignore transient errors while hidden
      } finally {
        this.badgeChecking = false;
      }
    });
  }

  evictCaches() {
    this.context?.watch?.pending?.cancel();
    if (this.context) this.context.watch = null;
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
      const match = allPanes.find(p => p.focused) ?? allPanes.find(p => p.tab === activeTabId);
      if (match) this.standalonePaneId = match.pane;
    }
    if (!this.standalonePaneId) return true;
    const me = allPanes.find(p => p.pane === this.standalonePaneId);
    return Boolean(me && me.tab === activeTabId);
  }

  checkStandaloneHibernation(cx) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    const forceGc = gcSeq !== this.lastGcSeq;
    this.lastGcSeq = gcSeq;

    if (this.isStandaloneVisible()) {
      this.hiddenSince = 0;
      if (this.hibernated) {
        this.hibernated = false;
        if (this.standaloneCommit && this.selectedCommit) this.openCommit(this.selectedCommit, cx);
        else if (this.standaloneFileDiff && this.standaloneFile) this.loadStandaloneFileDiff(cx);
        else if (this.standalonePr && this.selectedPr) this.openPullRequest(this.selectedPr, cx);
      }
      return;
    }

    const now = Date.now();
    if (!this.hiddenSince) this.hiddenSince = now;
    if (forceGc || now - this.hiddenSince >= HIBERNATE_IDLE_MS) {
      if (!this.hibernated) {
        this.hibernated = true;
        this.commitFiles = [];
        this.setCommitLines([]);
        this.prFiles = [];
        this.prDiffByFile.clear();
        this.setPrLines([]);
        this.setLines([]);
        releaseIconCache();
        cx.notify();
      }
    }
  }

  refreshIfDue(cx) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    const forceGc = gcSeq !== this.lastGcSeq;
    this.lastGcSeq = gcSeq;

    const visible = isChangesPanelVisible();
    if (!visible) {
      this.context?.watch?.pending?.cancel();
      if (this.context) this.context.watch = null;
      const now = Date.now();
      if (!this.hiddenSince) this.hiddenSince = now;
      if (forceGc || (!this.evicted && now - this.hiddenSince >= IDLE_CLEAN_MS)) {
        this.evictCaches();
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
    if (!context || wasEvicted) {
      this.refresh(cx, true);
      return;
    }
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading || this.busy) return;
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
      this.stashes = [];
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
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
    if (this.loading || this.busy) return;
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

        const { staged, unstaged, limited, count } = scan.parsed;

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
        this.stashes = stashes;
        this.limited = limited;
        this.error = null;
        this.publishBadgeCount(count, location().space);

        if (this.open) {
          const list = this.open.staged ? staged : unstaged;
          if (!list.some(f => f.path === this.open.path)) {
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
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true;
    this.note = null;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", args, { cwd: root, on, timeout: 15000 });
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
        if (this.current(context)) {
          this.busy = false;
          this.refresh(cx, true);
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  stageFile(path, cx) { this.runGitAction(["add", "--", path], cx); }
  unstageFile(path, cx) { this.runGitAction(["reset", "HEAD", "--", path], cx); }
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

  confirmPendingAction(cx) {
    const req = this.pendingConfirm;
    if (!req) return;
    this.pendingConfirm = null;
    if (req.kind === "discard") {
      this.discardFile(req.file, cx);
    } else if (req.kind === "drop-stash") {
      this.stashDrop(req.stash.ref, cx);
    }
  }

  discardFile(file, cx) {
    if (file.untracked) {
      this.runGitAction(["clean", "-fd", "--", file.path], cx);
    } else {
      this.runGitAction(["checkout", "--", file.path], cx);
    }
  }

  stashPush(cx) {
    const msg = this.message.trim();
    const args = msg ? ["stash", "push", "-u", "-m", msg] : ["stash", "push", "-u"];
    if (msg) {
      this.message = "";
      this.input.set_value("");
    }
    this.secStashes = true;
    this.runGitAction(args, cx);
  }

  stashApply(ref, cx) { this.runGitAction(["stash", "apply", ref], cx); }
  stashPop(ref, cx) { this.runGitAction(["stash", "pop", ref], cx); }
  stashDrop(ref, cx) { this.runGitAction(["stash", "drop", ref], cx); }

  openInViewer(path, event) {
    if (!path || !this.root) return;
    const f = focused();
    const tabId = f?.tab ?? null;
    const openInNewTab = Boolean(event?.modifiers?.control || event?.modifiers?.platform);
    const fileName = path.split(/[\\/]/).pop() || path;
    const payload = { file: path, root: this.root, on: this.on ?? null, tab: tabId, line: null, col: null, matchLen: null };

    if (openInNewTab) {
      const res = run("tab.new", { name: fileName, mod: "file-viewer", props: { ...payload, tab: null, solo: true } });
      if (res?.pane) run("pane.rename", { pane: res.pane, name: fileName });
      return;
    }

    const existing = tabId ? panes().find(p => p.tab === tabId && p.mod === "file-viewer") : null;
    if (existing) {
      const prevSeq = shared("file-viewer.open")?.seq ?? 0;
      setShared("file-viewer.open", { ...payload, pane: existing.pane, seq: prevSeq + 1 });
      run("pane.focus", { pane: existing.pane });
      run("pane.rename", { pane: existing.pane, name: fileName });
      return;
    }
    const res = run("pane.split", { direction: "right", mod: "file-viewer", props: payload });
    if (res?.pane) run("pane.rename", { pane: res.pane, name: fileName });
  }

  async loadDiff(target, context) {
    const root = this.root, on = this.on;
    const list = target.staged ? this.staged : this.unstaged;
    const file = list.find(f => f.path === target.path);
    if (!file) return;

    let lines;
    if (file.untracked) {
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        const count = countLines(text);
        lines = [`@@ -0,0 +1,${count} @@`, ...text.slice(0, 250000).replace(/\n$/, "").split("\n").slice(0, MAX_DIFF_LINES).map(l => `+${l}`)];
      }
    } else {
      const args = target.staged
        ? [...READ, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path]
        : [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path];
      const r = await exec("git", args, { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = (r.stdout || "").replace(/\n$/, "").split("\n");
      const first = all.findIndex(l => l.startsWith("@@"));
      lines = first < 0 ? ["Binary file or empty diff"] : all.slice(first);
    }

    if (this.current(context) && this.open?.path === target.path && this.open?.staged === target.staged) {
      this.setLines(lines.slice(0, MAX_DIFF_LINES).map(l => l.length > MAX_DIFF_LINE_CHARS ? l.slice(0, MAX_DIFF_LINE_CHARS) + "…" : l));
    }
  }

  openFileDiffInNewTab(file) {
    if (!file || !this.root) return;
    const plainFile = {
      path: file.path,
      staged: Boolean(file.staged),
      untracked: Boolean(file.untracked),
      status: file.status || "M",
    };
    const fileName = file.path.split("/").pop() || file.path;
    const tabTitle = `${plainFile.staged ? "Staged: " : ""}${fileName}`.slice(0, 32);
    const res = run("tab.new", {
      name: tabTitle,
      mod: "changes-history",
      props: { fileDiff: plainFile, root: this.root, on: this.on ?? null },
    });
    if (res?.pane) {
      run("pane.rename", { pane: res.pane, name: `${plainFile.staged ? "Staged · " : "Diff · "}${file.path}` });
    }
  }

  loadStandaloneFileDiff(cx) {
    const file = this.standaloneFile;
    if (!file || !this.root) return;
    const context = this.context, root = this.root, on = this.on;
    this.loading = true;
    this.setLines([]);
    cx.spawn(async cx => {
      try {
        let lines;
        if (file.untracked) {
          const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
          if (text === null) lines = ["Cannot preview this file"];
          else if (text.includes("\0")) lines = ["Binary file · no text diff"];
          else {
            const count = countLines(text);
            lines = [`@@ -0,0 +1,${count} @@`, ...text.slice(0, 250000).replace(/\n$/, "").split("\n").slice(0, MAX_DIFF_LINES).map(l => `+${l}`)];
          }
        } else {
          const args = file.staged
            ? [...READ, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path]
            : [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path];
          const r = await exec("git", args, { cwd: root, on, timeout: 8000 });
          if (r.code !== 0) throw new Error(r.stderr || "Cannot load diff");
          const all = (r.stdout || "").replace(/\n$/, "").split("\n");
          const first = all.findIndex(l => l.startsWith("@@"));
          lines = first < 0 ? ["Binary file or empty diff"] : all.slice(first);
        }
        if (this.current(context)) {
          this.setLines(lines.slice(0, MAX_DIFF_LINES).map(l => l.length > MAX_DIFF_LINE_CHARS ? l.slice(0, MAX_DIFF_LINE_CHARS) + "…" : l));
        }
      } catch (e) {
        if (this.current(context)) this.setLines([`Diff error: ${e}`]);
      } finally {
        if (this.current(context)) {
          this.loading = false;
          cx.notify();
        }
      }
    });
    cx.notify();
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

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context?.key !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    const hasStaged = this.staged.length > 0;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const cmds = hasStaged ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
        for (const args of cmds) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.current(context)) {
          this.message = "";
          this.input.set_value("");
          this.historyLoadedFor = null;
        }
      } catch (e) { if (this.current(context)) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx, true); cx.notify(); }
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

  openCommit(commit, cx) {
    this.selectedCommit = commit;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.setCommitLines([]);
    this.commitDetailLoading = true;

    const context = this.context, root = this.root, on = this.on, hash = commit.hash;
    cx.spawn(async cx => {
      try {
        const [nsRes, numRes] = await Promise.all([
          exec("git", [...READ, "diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "-z", hash], { cwd: root, on, timeout: 8000 }),
          exec("git", [...READ, "diff-tree", "--no-commit-id", "--numstat", "-r", "--root", "-z", hash], { cwd: root, on, timeout: 8000 }),
        ]);
        if (!this.current(context) || this.selectedCommit?.hash !== hash) return;

        const stats = {};
        if (numRes.code === 0) {
          for (const entry of (numRes.stdout || "").split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0 };
          }
        }

        const files = [];
        if (nsRes.code === 0) {
          const tokens = (nsRes.stdout || "").split("\0");
          for (let i = 0; i + 1 < tokens.length; i += 2) {
            const rawStatus = tokens[i];
            if (!rawStatus) continue;
            const status = rawStatus[0];
            let path = tokens[i + 1];
            if ((status === "R" || status === "C") && i + 2 < tokens.length) { path = tokens[i + 2]; i += 1; }
            if (!path) continue;
            files.push({ path, status, ...(stats[path] ?? { add: 0, del: 0 }) });
            if (files.length >= 400) break;
          }
        }

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
    cx.notify();
  }

  async loadCommitFileDiff(hash, path, context) {
    const root = this.root, on = this.on;
    const r = await exec("git", [...READ, "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", hash, "--", path], { cwd: root, on, timeout: 8000 });
    if (!this.current(context) || this.selectedCommit?.hash !== hash || this.commitOpenFile !== path) return;
    if (r.code !== 0) { this.setCommitLines([r.stderr || "Cannot load diff"]); return; }
    const all = (r.stdout || "").replace(/\n$/, "").split("\n");
    const first = all.findIndex(l => l.startsWith("@@"));
    const lines = first < 0 ? ["Binary file or empty diff"] : all.slice(first);
    this.setCommitLines(lines.slice(0, MAX_DIFF_LINES).map(l => l.length > MAX_DIFF_LINE_CHARS ? l.slice(0, MAX_DIFF_LINE_CHARS) + "…" : l));
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

  setLines(lines) {
    this.rows = diffRows(lines);
    this.longest = Math.max(0, ...this.rows.map(r => displayColumns(r.text)));
    this.gutterChars = Math.max(4, String(Math.max(0, ...this.rows.map(r => r.number ?? 0))).length);
  }

  setCommitLines(lines) {
    this.commitRows = diffRows(lines);
    this.commitLongest = Math.max(0, ...this.commitRows.map(r => displayColumns(r.text)));
    this.commitGutterChars = Math.max(4, String(Math.max(0, ...this.commitRows.map(r => r.number ?? 0))).length);
  }

  setPrLines(lines) {
    this.prRows = diffRows(lines);
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

  openPullRequest(pr, cx) {
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
    cx.notify();
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

  diffRow({ kind, number, text }, t, size, gutterChars) {
    const height = rowHeight(size);
    if (kind === "@") return div().w_full().px(10).h(height).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(height).flex_none().gap(8).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(this.gutter(gutterChars, size)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  actionBtn(t, id, label, tip, onClick) {
    return div()
      .id(id)
      .px(5)
      .py(2)
      .rounded(5)
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
    const rowId = `sc-${file.staged ? "s" : "u"}-${file.path}`;
    const isSelected = this.open?.path === file.path && this.open?.staged === file.staged;
    const isHovered = this.hoveredRow === rowId;

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
      .tooltip(`${file.path}\nClick: inline diff · Ctrl+Click: open diff in new tab`)
      .on_click((e, cx) => {
        if (e?.modifiers?.control || e?.modifiers?.platform) {
          this.openFileDiffInNewTab(file);
        } else {
          this.pickDiff(file, cx);
        }
      })
      .child(image(fileIcon(name)).w(16).h(16).flex_none())
      .child(div().flex_none().max_w(165).truncate().text_size(12).text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .when(isHovered, el =>
        el
          .child(this.actionBtn(t, `${rowId}-open`, "↗", "Open file (Ctrl+Click: new tab)", (e) => this.openInViewer(file.path, e)))
          .when(!file.staged, r => r
            .child(this.actionBtn(t, `${rowId}-disc`, "↺", file.untracked ? "Delete untracked file" : "Discard changes", (_e, cx) => this.requestDiscardFile(file, cx)))
            .child(this.actionBtn(t, `${rowId}-add`, "+", "Stage changes", (_e, cx) => this.stageFile(file.path, cx))))
          .when(file.staged, r => r
            .child(this.actionBtn(t, `${rowId}-un`, "−", "Unstage changes", (_e, cx) => this.unstageFile(file.path, cx)))),
      )
      .child(div().w(14).text_right().text_size(11).font_semibold().text_color(statusColor(file.status, t)).child(file.status));
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
                    .child(div().flex_none().max_w(160).truncate().text_size(12).text_color(t.foreground).child(name))
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
                    .when(f.add > 0, e => e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
                    .when(f.del > 0, e => e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
                    .child(div().w(14).text_right().text_size(11).font_semibold().text_color(statusColor(f.status, t)).child(f.status));
                }),
              )
              .when(!this.commitFiles.length, e =>
                e.child(div().p(8).text_size(12).text_color(t.dim).child(this.commitDetailLoading ? "Loading commit…" : "No files changed")),
              ),
          )
          .child(Scrollbar.vertical("hist-files-list").absolute().inset_0()),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .font_family(settings().font_family ?? "JetBrains Mono")
          .text_size(size)
          .child(
            div()
              .id("hist-diff-x")
              .size_full()
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(Math.max(300, this.commitLongest * charWidth(size) + this.gutter(this.commitGutterChars, size) + 20))
                  .h_full()
                  .child(
                    v_virtual_list(
                      "hist-diff",
                      this.commitRows.length,
                      rowHeight(size),
                      (i) => String(i),
                      (range) => this.commitRows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size, this.commitGutterChars)),
                    ).size_full(),
                  ),
              ),
          )
          .child(Scrollbar.vertical("hist-diff").viewport_from_layout().absolute().inset_0()),
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
                    .child(div().flex_none().max_w(160).truncate().text_size(12).text_color(t.foreground).child(name))
                    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
                    .when(f.add > 0, e => e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
                    .when(f.del > 0, e => e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
                    .child(div().w(14).text_right().text_size(11).font_semibold().text_color(statusColor(f.status, t)).child(f.status));
                }),
              )
              .when(!this.prFiles.length, e =>
                e.child(div().p(8).text_size(12).text_color(t.dim).child(this.prDetailLoading ? "Loading pull request…" : "No files changed")),
              ),
          )
          .child(Scrollbar.vertical("pr-files-list").absolute().inset_0()),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .font_family(settings().font_family ?? "JetBrains Mono")
          .text_size(size)
          .child(
            div()
              .id("pr-diff-x")
              .size_full()
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(Math.max(300, this.prLongest * charWidth(size) + this.gutter(this.prGutterChars, size) + 20))
                  .h_full()
                  .child(
                    v_virtual_list(
                      "pr-diff",
                      this.prRows.length,
                      rowHeight(size),
                      (i) => String(i),
                      (range) => this.prRows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size, this.prGutterChars)),
                    ).size_full(),
                  ),
              ),
          )
          .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0()),
      );
  }

  renderStandaloneFileDiff(t, size) {
    const file = this.standaloneFile;
    const name = file.path.split("/").pop() || file.path;
    return v_flex()
      .id("changes-filediff-tab")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
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
          .child(div().px(5).py(1).rounded(4).bg(t.surface).text_size(10.5).font_semibold().text_color(statusColor(file.status, t)).child(file.staged ? `Staged · ${file.status}` : file.status))
          .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12).text_color(t.foreground).child(file.path))
          .child(this.actionBtn(t, "sfd-refresh", "↻", "Refresh diff", (_e, cx) => this.loadStandaloneFileDiff(cx)))
          .child(this.actionBtn(t, "sfd-open", "↗", "Open full file", (e) => this.openInViewer(file.path, e))),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .font_family(settings().font_family ?? "JetBrains Mono")
          .text_size(size)
          .child(
            div()
              .id("sfd-diff-x")
              .size_full()
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(Math.max(300, this.longest * charWidth(size) + this.gutter(this.gutterChars, size) + 20))
                  .h_full()
                  .child(
                    v_virtual_list(
                      "sfd-diff",
                      this.rows.length,
                      rowHeight(size),
                      (i) => String(i),
                      (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size, this.gutterChars)),
                    ).size_full(),
                  ),
              ),
          )
          .child(Scrollbar.vertical("sfd-diff").viewport_from_layout().absolute().inset_0()),
      );
  }

  render(cx) {
    const t = theme(), s = settings(), size = s.font_size, fontFamily = s.font_family ?? s.font;
    if (this.standaloneCommit && this.selectedCommit) {
      if (!checking()) this.checkStandaloneHibernation(cx);
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
      if (!checking()) this.checkStandaloneHibernation(cx);
      return this.renderStandaloneFileDiff(t, size).when(Boolean(fontFamily), el => el.font_family(fontFamily));
    }
    if (this.standalonePr && this.selectedPr) {
      if (!checking()) this.checkStandaloneHibernation(cx);
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
    const canCommit = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && totalChanges > 0);

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
              .child(this.actionBtn(t, "sc-stash", "S+", "Stash changes (uses message if set)", (_e, cx) => this.stashPush(cx)))
              .child(this.actionBtn(t, "sc-pull", "↓", "Git pull", (_e, cx) => this.runGitAction(["pull"], cx)))
              .child(this.actionBtn(t, "sc-push", "↑", "Git push", (_e, cx) => this.runGitAction(["push"], cx)))
              .child(this.actionBtn(t, "sc-refresh", "↻", "Refresh", (_e, cx) => this.refresh(cx, true))),
          ),
      )
      .when(Boolean(this.selectedCommit), el => el.child(this.renderCommitDetail(t, size)))
      .when(!this.selectedCommit && Boolean(this.selectedPr), el => el.child(this.renderPrDetail(t, size)))
      .when(!this.selectedCommit && !this.selectedPr, el =>
        el
          // VS Code-style top Commit Box
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
                    .gap(6)
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
                        .on_click((_e, cx) => this.commit(cx))
                        .child(this.busy ? "Working…" : this.staged.length > 0 ? `✓ Commit (${this.staged.length} staged)` : "✓ Commit"),
                    ),
                ),
            ),
          )
          .when(Boolean(this.pendingConfirm), el => {
            const req = this.pendingConfirm;
            const isDelete = req.kind === "discard" && req.file?.untracked;
            const label = req.kind === "discard"
              ? (isDelete ? `Delete "${req.file.path}"?` : `Discard changes in "${req.file.path}"?`)
              : `Drop stash "${req.stash.ref}"?`;
            const confirmText = isDelete ? "Delete" : req.kind === "discard" ? "Discard" : "Drop";
            return el.child(
              v_flex()
                .flex_none()
                .px(10)
                .py(7)
                .gap(6)
                .bg(t.ansi1 + "1a")
                .border_b(1)
                .border_color(t.ansi1)
                .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(label))
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
                        .text_color("#ffffff")
                        .cursor_pointer()
                        .on_click((_e, cx) => this.confirmPendingAction(cx))
                        .child(confirmText),
                    ),
                ),
            );
          })
          .when(Boolean(this.note), el =>
            el.child(
              h_flex()
                .px(10)
                .py(5)
                .gap(6)
                .items_center()
                .border_b(1)
                .border_color(t.border)
                .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi1).child(this.note))
                .child(this.actionBtn(t, "sc-note-x", "×", "Dismiss", (_e, cx) => { this.note = null; cx.notify(); })),
            ),
          )
          // Top scrollable section (Staged + Changes) + resizable bottom section (Stashes + Graph)
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
                    this.actionBtn(t, "sc-stash-sec", "S+", "Stash all changes", (_e, cx) => this.stashPush(cx)),
                    this.actionBtn(t, "sc-stage-all", "+", "Stage all changes", (_e, cx) => this.stageAll(cx)),
                  ] : []))
                  .when(this.secChanges, list =>
                    list.child(
                      v_flex()
                        .px(4)
                        .pb(4)
                        .children(this.unstaged.map(f => this.fileRow(f, t)))
                        .when(!this.unstaged.length && !this.staged.length, empty =>
                          empty.child(div().px(14).py(6).text_size(11.5).text_color(t.dim).child("No uncommitted changes")),
                        ),
                    ),
                  ),
              )
              // Draggable horizontal resize divider between Changes and Stashes/Graph
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
              // Bottom resizable pane (Stashes + Graph)
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
                    }, [this.actionBtn(t, "sc-stash-add", "+", "Create stash", (_e, cx) => this.stashPush(cx))]),
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
                              .hover(s => s.bg(t.hover))
                              .tooltip(`${st.ref}\n${st.message}\n${st.relDate}`)
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
          // Inline Diff preview when a file is clicked
          .when(Boolean(this.open), diffArea =>
            diffArea.child(
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
                .child(
                  div()
                    .flex_1()
                    .min_h(0)
                    .relative()
                    .font_family(settings().font_family ?? "JetBrains Mono")
                    .text_size(size)
                    .child(
                      div()
                        .id("changes-diff-x")
                        .size_full()
                        .overflow_x_scrollbar()
                        .child(
                          div()
                            .w_full()
                            .min_w(Math.max(300, this.longest * charWidth(size) + this.gutter(this.gutterChars, size) + 20))
                            .h_full()
                            .child(
                              v_virtual_list(
                                "changes-diff",
                                this.rows.length,
                                rowHeight(size),
                                (i) => String(i),
                                (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, size, this.gutterChars)),
                              ).size_full(),
                            ),
                        ),
                    )
                    .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0()),
                ),
            ),
          ),
      );
  }
}
