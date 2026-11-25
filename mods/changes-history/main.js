// VS Code-style Source Control panel: Commit, Staged/Unstaged Changes, Stashes, and Graph/History.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, checking, run, shared, setShared } from "herdr";
import { fileIcon } from "./material-icons.js";

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
  const space = spaces().find((s) => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const fallbackTermPane = pane && !pane.cwd && f?.tab
    ? allPanes.find(p => p.tab === f.tab && p.cwd)
    : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || fallbackTermPane?.cwd || f?.cwd || space?.folder, on };
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

export default class ChangesHistory extends View {
  init(initialProps, cx) {
    this.standaloneCommit = Boolean(initialProps?.commit && initialProps?.root);
    this.branch = "";
    this.staged = [];
    this.unstaged = [];
    this.stashes = [];
    this.open = null; // { path, staged }
    this.rows = [];
    this.longest = 0;
    this.gutterChars = 4;
    this.message = "";
    this.handle = cx.focus_handle();

    // Collapsible VS Code sections
    this.secStaged = true;
    this.secChanges = true;
    this.secStashes = false;
    this.secGraph = false;
    this.hoveredRow = null;

    // Commit history state
    this.commits = [];
    this.historyLimit = 50;
    this.historyLoading = false;
    this.historyError = null;
    this.historyLoadedFor = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.commitRows = [];
    this.commitLongest = 0;
    this.commitGutterChars = 4;
    this.commitDetailLoading = false;

    if (!this.standaloneCommit) {
      this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
      this.input.on("change", (_e, cx) => {
        const hadMessage = Boolean(this.message.trim());
        this.message = this.input.value();
        if (hadMessage !== Boolean(this.message.trim())) cx.notify();
      });
      this.input.on("submit", (_e, cx) => this.commit(cx));
      this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    }

    if (checking()) return;
    if (this.standaloneCommit) {
      this.root = initialProps.root;
      this.on = initialProps.on ?? null;
      this.context = { key: `commit:${initialProps.commit.hash}`, on: this.on, dirtyAt: 0 };
      this.openCommit(initialProps.commit, cx);
      return;
    }
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
  }

  close() {
    this.context?.watch?.pending?.cancel();
    this.input?.release();
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
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
    if (this.standaloneCommit) return this.context === context;
    return this.context === context && key() === context.key;
  }

  resetHistory() {
    this.commits = [];
    this.historyLimit = 50;
    this.historyLoading = false;
    this.historyError = null;
    this.historyLoadedFor = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitOpenFile = null;
    this.setCommitLines([]);
  }

  refresh(cx, force = false) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      this.context?.watch?.pending?.cancel();
      this.context = { key: next, on, dirtyAt: 0 };
      this.root = null;
      this.branch = "";
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

        const [scan, brRes, stashRes] = await Promise.all([
          repoStatus(root, on, request, cx, () => this.context === context),
          git(["branch", "--show-current"]),
          git(["stash", "list", "--pretty=format:%gd%x1f%gs%x1f%cr"]),
        ]);
        if (!scan || !this.current(context)) return;

        const { status, started, pollAt, watchAt } = scan;
        context.lastStatus = started;
        context.pollAt = pollAt;
        context.watchAt = watchAt;
        if (context.dirtyAt <= started) context.dirtyAt = 0;
        if (scan.error) throw scan.error;
        if (status.code !== 0) throw new Error(status.stderr);
        if (request.urgent && request.after > started) context.catchUp = true;

        const entries = status.stdout.split("\0").filter(Boolean);
        const shown = entries.slice(0, 1000);
        const staged = [];
        const unstaged = [];

        for (const entry of shown) {
          const x = entry[0], y = entry[1], path = entry.slice(3);
          if (!path) continue;
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
        this.branch = (brRes.stdout || "").trim() || "HEAD";
        this.staged = staged;
        this.unstaged = unstaged;
        this.stashes = stashes;
        this.limited = entries.length > 1000;
        this.error = null;

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
          this.loadHistory(cx, true);
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
        lines = [`@@ -0,0 +1,${count} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
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
      this.setLines(lines.slice(0, 1500).map(l => l.length > 4000 ? l.slice(0, 4000) + "…" : l));
    }
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

  loadHistory(cx, reset = false) {
    const context = this.context, root = this.root, on = this.on;
    if (!root) return;
    if (reset) this.historyLimit = 50;
    const limit = this.historyLimit;
    this.historyLoading = true;
    this.historyError = null;

    cx.spawn(async cx => {
      try {
        const r = await exec(
          "git",
          [...READ, "log", "-n", String(limit), "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s"],
          { cwd: root, on, timeout: 8000 },
        );
        if (!this.current(context)) return;
        if (r.code !== 0) {
          const err = (r.stderr || "").trim();
          if (err.includes("does not have any commits")) { this.commits = []; this.historyError = null; }
          else this.historyError = err || "Cannot read git log";
          return;
        }
        const parsed = [];
        for (const line of (r.stdout || "").split("\n")) {
          if (!line) continue;
          const [hash, shortHash, author, relDate, refs, ...subjectParts] = line.split("\x1f");
          if (!hash) continue;
          parsed.push({
            hash,
            shortHash: shortHash || hash.slice(0, 7),
            author: author || "",
            relDate: relDate || "",
            refs: (refs || "").split(",").map(s => s.trim()).filter(Boolean),
            subject: subjectParts.join("\x1f") || "(no message)",
          });
        }
        this.commits = parsed;
        this.historyLoadedFor = root;
        this.historyError = null;
      } catch (e) {
        if (this.current(context)) this.historyError = String(e.message || e);
      } finally {
        if (this.current(context)) { this.historyLoading = false; cx.notify(); }
      }
    });
    cx.notify();
  }

  openCommitInNewTab(commit) {
    if (!commit || !this.root) return;
    const tabTitle = `${commit.shortHash} ${commit.subject}`.slice(0, 32);
    const res = run("tab.new", {
      name: tabTitle,
      mod: "changes-history",
      props: { commit, root: this.root, on: this.on ?? null },
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
    this.setCommitLines(lines.slice(0, 1500).map(l => l.length > 4000 ? l.slice(0, 4000) + "…" : l));
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
      .on_click((_e, cx) => this.pickDiff(file, cx))
      .child(image(fileIcon(name)).w(16).h(16).flex_none())
      .child(div().flex_none().max_w(165).truncate().text_size(12).text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .when(isHovered, el =>
        el
          .child(this.actionBtn(t, `${rowId}-open`, "↗", "Open file (Ctrl+Click: new tab)", (e) => this.openInViewer(file.path, e)))
          .when(!file.staged, r => r
            .child(this.actionBtn(t, `${rowId}-disc`, "↺", file.untracked ? "Delete untracked file" : "Discard changes", (_e, cx) => this.discardFile(file, cx)))
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
          .child(div().pl(this.standaloneCommit ? 4 : 24).text_size(11).text_color(t.dim).child(`${c.author} · ${c.relDate} · ${this.commitFiles.length} file${this.commitFiles.length === 1 ? "" : "s"}`)),
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

  render(cx) {
    const t = theme(), size = settings().font_size;
    if (this.standaloneCommit && this.selectedCommit) {
      return v_flex()
        .id("changes-commit-tab")
        .size_full()
        .min_h(0)
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(13)
        .child(this.renderCommitDetail(t, size));
    }
    if (!checking()) {
      if (key() !== this.context?.key) this.refresh(cx);
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
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
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
            el.child(div().px(5).py(1).rounded(4).bg(t.surface).text_size(10.5).text_color(t.dim).truncate().max_w(110).child(this.branch)),
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
      .when(!this.selectedCommit, el =>
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
          // Main scrollable VS Code sections (Staged, Changes, Stashes, Graph)
          .child(
            v_flex()
              .id("sc-sections")
              .flex_1()
              .min_h(0)
              .overflow_y_scrollbar()
              .py(4)
              .when(!this.root, e =>
                e.child(div().p(12).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : "Not a git repository"))),
              )
              .when(Boolean(this.root), body =>
                body
                  // Staged Changes
                  .when(this.staged.length > 0, s =>
                    s
                      .child(this.sectionHeader(t, "sec-staged", "Staged Changes", this.secStaged, this.staged.length, (_e, cx) => {
                        this.secStaged = !this.secStaged;
                        cx.notify();
                      }, [this.actionBtn(t, "sc-unstage-all", "−", "Unstage all", (_e, cx) => this.unstageAll(cx))]))
                      .when(this.secStaged, list => list.child(v_flex().px(4).pb(4).children(this.staged.map(f => this.fileRow(f, t))))),
                  )
                  // Changes (Unstaged)
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
                  )
                  // Stashes
                  .child(
                    div()
                      .mt(2)
                      .border_t(1)
                      .border_color(t.border)
                      .child(this.sectionHeader(t, "sec-stashes", "Stashes", this.secStashes, this.stashes.length, (_e, cx) => {
                        this.secStashes = !this.secStashes;
                        cx.notify();
                      }, [this.actionBtn(t, "sc-stash-add", "+", "Create stash", (_e, cx) => this.stashPush(cx))])),
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
                              .child(this.actionBtn(t, `st-drop-${st.ref}`, "×", "Drop stash", (_e, cx) => this.stashDrop(st.ref, cx))),
                          ),
                        ),
                    ),
                  )
                  // Graph / Commit History
                  .child(
                    div()
                      .mt(2)
                      .border_t(1)
                      .border_color(t.border)
                      .child(this.sectionHeader(t, "sec-graph", "Graph", this.secGraph, this.commits.length || null, (_e, cx) => {
                        this.secGraph = !this.secGraph;
                        if (this.secGraph && this.historyLoadedFor !== this.root && !this.historyLoading) {
                          this.loadHistory(cx, true);
                        } else {
                          cx.notify();
                        }
                      }, this.secGraph ? [this.actionBtn(t, "sc-hist-ref", "↻", "Refresh history", (_e, cx) => this.loadHistory(cx, true))] : [])),
                  )
                  .when(this.secGraph, list =>
                    list.child(
                      v_flex()
                        .px(4)
                        .pb(6)
                        .gap(1)
                        .when(Boolean(this.historyError), e => e.child(div().px(10).py(6).text_size(11.5).text_color(t.ansi1).child(this.historyError)))
                        .when(!this.commits.length && !this.historyError, e =>
                          e.child(div().px(10).py(6).text_size(11.5).text_color(t.dim).child(this.historyLoading ? "Loading commits…" : "No commits yet")),
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
                              .tooltip(`${c.shortHash} · ${c.subject}\n${c.author} · ${c.relDate}\nCtrl+Click: open in new tab`)
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
                                el.child(div().px(4).py(0.5).rounded(4).bg(t.ansi2 + "22").text_size(9.5).font_semibold().text_color(t.ansi2).truncate().max_w(75).child(c.refs[0].replace(/^HEAD -> /, ""))),
                              )
                              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.shortHash)),
                          ),
                        )
                        .when(this.commits.length >= this.historyLimit && !this.historyLoading, el =>
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
                                this.historyLimit += 50;
                                this.loadHistory(cx, false);
                              })
                              .child("Load 50 more commits"),
                          ),
                        ),
                    ),
                  ),
              ),
          )
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
