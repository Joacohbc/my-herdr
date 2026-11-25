// Git Changes + Commit History panel (cloned & extended from Herdr's native changes mod).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, checking } from "herdr";

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
  if (status === "A") return t.ansi2;
  if (status === "D" || status === "U") return t.ansi1;
  if (status === "R") return t.ansi4;
  return t.blocked;
}

export default class ChangesHistory extends View {
  init(_props, cx) {
    this.tab = "changes";
    this.files = [];
    this.rows = [];
    this.longest = 0;
    this.gutterChars = 4;
    this.message = "";
    this.handle = cx.focus_handle();

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

    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    if (checking()) return;
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
      this.files = [];
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.closed = false;
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
          this.files = [];
          this.setLines([]);
          this.open = null;
          this.error = "Not a git repository";
          return;
        }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        this.watch(root, context, cx);
        const scan = await repoStatus(root, on, request, cx, () => this.context === context);
        if (!scan || !this.current(context)) return;
        const { status, started, pollAt, watchAt } = scan;
        context.lastStatus = started;
        context.pollAt = pollAt;
        context.watchAt = watchAt;
        if (context.dirtyAt <= started) context.dirtyAt = 0;
        if (scan.error) throw scan.error;
        if (status.code !== 0) throw new Error(status.stderr);
        if (request.urgent && request.after > started) context.catchUp = true;
        const entries = status.stdout.split("\0").filter(Boolean), shown = entries.slice(0, 1000);
        const tracked = shown.some(entry => !entry.startsWith("??"));
        const hasHead = tracked && (await git(["rev-parse", "--verify", "HEAD"])).code === 0;
        const stats = {};
        const results = !tracked ? [] : hasHead
          ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
          : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        for (const entry of shown) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (!this.current(context)) return;
        this.root = root;
        this.on = on;
        this.hasHead = hasHead;
        this.files = files;
        this.limited = entries.length > 1000;
        this.error = null;
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.current(context)) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
        if (this.tab === "history" && (force || this.historyLoadedFor !== root)) {
          this.loadHistory(cx, true);
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
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
          [...READ, "log", `-n`, String(limit), "--pretty=format:%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s"],
          { cwd: root, on, timeout: 8000 },
        );
        if (!this.current(context)) return;
        if (r.code !== 0) {
          const err = (r.stderr || "").trim();
          if (err.includes("does not have any commits")) {
            this.commits = [];
            this.historyError = null;
          } else {
            this.historyError = err || "Cannot read git log";
          }
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
        if (this.current(context)) {
          this.historyLoading = false;
          cx.notify();
        }
      }
    });
    cx.notify();
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
            const path = parts.join("\t");
            stats[path] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
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
            if ((status === "R" || status === "C") && i + 2 < tokens.length) {
              path = tokens[i + 2];
              i += 1;
            }
            if (!path) continue;
            const st = stats[path] ?? { add: 0, del: 0, binary: false };
            files.push({ path, status, ...st });
            if (files.length >= 400) break;
          }
        }

        this.commitFiles = files;
        if (files.length) {
          this.commitOpenFile = files[0].path;
          await this.loadCommitFileDiff(hash, files[0].path, context);
        }
      } catch (e) {
        if (this.current(context) && this.selectedCommit?.hash === hash) {
          this.setCommitLines([`Cannot load commit details: ${e}`]);
        }
      } finally {
        if (this.current(context) && this.selectedCommit?.hash === hash) {
          this.commitDetailLoading = false;
          cx.notify();
        }
      }
    });
    cx.notify();
  }

  async loadCommitFileDiff(hash, path, context) {
    const root = this.root, on = this.on;
    const r = await exec(
      "git",
      [...READ, "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", hash, "--", path],
      { cwd: root, on, timeout: 8000 },
    );
    if (!this.current(context) || this.selectedCommit?.hash !== hash || this.commitOpenFile !== path) return;
    if (r.code !== 0) {
      this.setCommitLines([r.stderr || "Cannot load diff"]);
      return;
    }
    const all = (r.stdout || "").replace(/\n$/, "").split("\n");
    const first = all.findIndex(l => l.startsWith("@@"));
    const lines = first < 0 ? ["Binary file or empty diff"] : all.slice(first);
    this.setCommitLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  pickCommitFile(path, cx) {
    if (!this.selectedCommit) return;
    this.commitOpenFile = path;
    this.setCommitLines([]);
    const context = this.context, hash = this.selectedCommit.hash;
    cx.spawn(async cx => {
      try { await this.loadCommitFileDiff(hash, path, context); }
      catch (e) { if (this.current(context)) this.setCommitLines([`Cannot load diff: ${e}`]); }
      cx.notify();
    });
    cx.notify();
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.current(context) && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.longest = Math.max(0, ...this.rows.map(row => displayColumns(row.text)));
    this.gutterChars = Math.max(4, String(Math.max(0, ...this.rows.map(row => row.number ?? 0))).length);
  }

  setCommitLines(lines) {
    this.commitRows = diffRows(lines);
    this.commitLongest = Math.max(0, ...this.commitRows.map(row => displayColumns(row.text)));
    this.commitGutterChars = Math.max(4, String(Math.max(0, ...this.commitRows.map(row => row.number ?? 0))).length);
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.current(context) && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context?.key !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
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

  gutter(chars, size) { return Math.ceil(chars * charWidth(size)) + 2; }

  diffRow({ kind, number, text }, t, size, gutterChars) {
    const height = rowHeight(size);
    if (kind === "@") return div().w_full().px(12).h(height).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(height).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(this.gutter(gutterChars, size)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderHistory(t, size) {
    if (!this.root) {
      return div().p(12).text_size(12).text_color(t.dim).child(this.error || "Not a git repository");
    }

    if (this.selectedCommit) {
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
                .child(
                  div()
                    .id("hist-back")
                    .px(6)
                    .py(2)
                    .rounded(5)
                    .text_size(12)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.selectedCommit = null;
                      this.commitFiles = [];
                      this.commitOpenFile = null;
                      this.setCommitLines([]);
                      cx.notify();
                    })
                    .child("←"),
                )
                .child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.selected)
                    .text_size(11)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(c.shortHash),
                )
                .child(div().flex_1().min_w(0).truncate().font_medium().text_size(12).text_color(t.foreground).child(c.subject)),
            )
            .child(
              div()
                .pl(28)
                .text_size(11)
                .text_color(t.dim)
                .child(`${c.author} · ${c.relDate} · ${this.commitFiles.length} file${this.commitFiles.length === 1 ? "" : "s"}`),
            ),
        )
        .child(
          div()
            .flex_1()
            .min_h(44)
            .max_h(Math.min(220, this.commitFiles.length * 26 + 12))
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
                      .gap(8)
                      .items_center()
                      .rounded(6)
                      .cursor_pointer()
                      .when(this.commitOpenFile === f.path, e => e.bg(t.selected))
                      .hover(s => s.bg(t.hover))
                      .on_click((_e, cx) => this.pickCommitFile(f.path, cx))
                      .child(div().w(14).text_size(11).text_color(statusColor(f.status, t)).child(f.status))
                      .child(
                        h_flex()
                          .flex_1()
                          .min_w(0)
                          .child(div().text_size(11.5).text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
                          .child(div().text_size(12).max_w(240).min_w(0).truncate().child(name)),
                      )
                      .when(f.add > 0, e => e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
                      .when(f.del > 0, e => e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)));
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

    return v_flex()
      .id("hist-commits-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(6)
      .gap(2)
      .when(Boolean(this.historyError), el =>
        el.child(div().p(8).text_size(12).text_color(t.ansi1).child(this.historyError)),
      )
      .when(!this.commits.length && !this.historyError, el =>
        el.child(div().p(8).text_size(12).text_color(t.dim).child(this.historyLoading ? "Loading commits…" : "No commits yet")),
      )
      .children(
        this.commits.map(c =>
          v_flex()
            .id(`commit-${c.hash}`)
            .flex_none()
            .px(8)
            .py(6)
            .gap(3)
            .rounded(7)
            .cursor_pointer()
            .hover(s => s.bg(t.hover))
            .tooltip(`${c.hash}\n${c.subject}\n${c.author} · ${c.relDate}`)
            .on_click((_e, cx) => this.openCommit(c, cx))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.surface)
                    .text_size(10.5)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(c.shortHash),
                )
                .when(c.refs.length > 0, el =>
                  el.child(
                    div()
                      .px(5)
                      .py(1)
                      .rounded(4)
                      .bg(t.ansi2 + "22")
                      .text_size(10)
                      .font_semibold()
                      .text_color(t.ansi2)
                      .truncate()
                      .max_w(130)
                      .child(c.refs[0]),
                  ),
                )
                .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(c.subject)),
            )
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.author))
                .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.relDate)),
            ),
        ),
      )
      .when(this.commits.length >= this.historyLimit && !this.historyLoading, el =>
        el.child(
          div()
            .id("hist-load-more")
            .mt(4)
            .py(6)
            .rounded(6)
            .bg(t.surface)
            .text_center()
            .text_size(11.5)
            .text_color(t.muted)
            .cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              this.historyLimit += 50;
              this.loadHistory(cx, false);
            })
            .child("Load 50 more commits"),
        ),
      );
  }

  render(cx) {
    if (!checking()) {
      if (key() !== this.context?.key) this.refresh(cx);
      else this.refreshIfDue(cx);
    }
    const t = theme(), size = settings().font_size;
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const isHistory = this.tab === "history";

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
          .h(42)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .id("tab-changes")
              .px(8)
              .py(4)
              .gap(5)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .when(!isHistory, el => el.bg(t.selected))
              .hover(s => s.bg(!isHistory ? t.selected : t.hover))
              .on_click((_e, cx) => {
                this.tab = "changes";
                cx.notify();
              })
              .child(div().font_semibold().text_size(12.5).text_color(!isHistory ? t.foreground : t.muted).child("Changes"))
              .child(div().px(4).py(0.5).rounded(4).bg(t.surface).text_size(10).text_color(t.muted).child(String(this.files.length))),
          )
          .child(
            h_flex()
              .id("tab-history")
              .px(8)
              .py(4)
              .gap(5)
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .when(isHistory, el => el.bg(t.selected))
              .hover(s => s.bg(isHistory ? t.selected : t.hover))
              .on_click((_e, cx) => {
                this.tab = "history";
                if (this.root && this.historyLoadedFor !== this.root && !this.historyLoading) {
                  this.loadHistory(cx, true);
                } else {
                  cx.notify();
                }
              })
              .child(div().font_semibold().text_size(12.5).text_color(isHistory ? t.foreground : t.muted).child("History"))
              .when(this.commits.length > 0, el =>
                el.child(div().px(4).py(0.5).rounded(4).bg(t.surface).text_size(10).text_color(t.muted).child(String(this.commits.length))),
              ),
          )
          .child(div().flex_1())
          .when(!isHistory, el =>
            el
              .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
              .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
          )
          .when(isHistory, el =>
            el.child(
              div()
                .id("hist-refresh")
                .px(6)
                .py(2)
                .rounded(5)
                .text_size(12)
                .text_color(t.dim)
                .cursor_pointer()
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .tooltip("Refresh commit history")
                .on_click((_e, cx) => this.loadHistory(cx, true))
                .child("↻"),
            ),
          ),
      )
      .when(isHistory, el => el.child(this.renderHistory(t, size)))
      .when(!isHistory, el =>
        el
          .child(
            div()
              .flex_1()
              .min_h(44)
              .max_h(this.files.length * 28 + 12)
              .relative()
              .border_b(1)
              .border_color(t.border)
              .child(
                v_flex()
                  .id("changes-list")
                  .absolute()
                  .inset_0()
                  .overflow_y_scroll()
                  .p(6)
                  .children(
                    this.files.map((f) => {
                      const parts = f.path.split("/"), name = parts.pop();
                      return h_flex()
                        .id(`change-${f.path}`)
                        .h(28)
                        .flex_none()
                        .px(8)
                        .gap(8)
                        .items_center()
                        .rounded(7)
                        .cursor_pointer()
                        .when(this.open === f.path, (e) => e.bg(t.selected))
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => this.pick(f.path, cx))
                        .child(div().w(14).text_size(11).text_color(statusColor(f.status, t)).child(f.status))
                        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
                        .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
                        .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
                    }),
                  )
                  .when(!this.files.length, (e) =>
                    e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))),
                  ),
              )
              .child(Scrollbar.vertical("changes-list").absolute().inset_0()),
          )
          .when(this.limited, lim => lim.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
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
              .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
              .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_size(11).text_color(t.dim).child("Select a file to view its changes"))),
          )
          .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
          .child(
            h_flex()
              .flex_none()
              .p(10)
              .gap(8)
              .border_t(1)
              .border_color(t.border)
              .child(
                div()
                  .id("commit-message")
                  .flex_1()
                  .min_w(0)
                  .h(32)
                  .px(10)
                  .flex()
                  .items_center()
                  .rounded(8)
                  .border_1()
                  .border_color(this.typing ? t.accent : t.border)
                  .cursor_text()
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
              )
              .child(
                div()
                  .id("commit")
                  .h(32)
                  .px(14)
                  .flex()
                  .items_center()
                  .rounded(8)
                  .bg(enabled ? t.solid : t.raised)
                  .text_color(enabled ? t.solid_foreground : t.dim)
                  .text_size(12)
                  .when(enabled, (e) => e.cursor_pointer())
                  .on_click((_e, cx) => this.commit(cx))
                  .child(this.busy ? "Committing…" : "Commit"),
              ),
          ),
      );
  }
}
