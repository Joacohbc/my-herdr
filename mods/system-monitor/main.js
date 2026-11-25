import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, theme, settings, window, panes, shared, setShared, checking } from "herdr";

const ACTIVE_POLL_MS = 3000;
const UNFOCUSED_POLL_MS = 8000;
const AUTO_CLEAN_MS = 60_000;
const HIGH_RAM_GC_PCT = 75;
const MAX_APPS = 16;

const APP_RULES = [
  { name: "Antigravity", icon: "icons/antigravity.svg", root: true, test: (c, a) => /antigravity|\bagy\b/.test(c) || /antigravity|\/agy(\s|$)/.test(a) },
  { name: "Claude Code", icon: "icons/claude.svg", root: true, test: (c, a) => /^claude$/i.test(c) || /claude-code|\/claude(\s|$)/.test(a) },
  { name: "Codex", icon: "icons/codex.svg", root: true, test: (c, a) => /^codex$/i.test(c) || /\/codex(\s|$)/.test(a) },
  { name: "Gemini", icon: "icons/gemini.svg", root: true, test: (c, a) => /^gemini$/i.test(c) || /\/gemini-cli\//.test(a) },
  { name: "Ollama", icon: "icons/ollama.svg", root: true, test: (c, a) => /^ollama/.test(c) || /ollama/.test(a) },
  { name: "Herdr", icon: "mods/system-monitor/icons/herdr.svg", root: true, test: (c, a) => /^herdr(-app|-core)?$/.test(c) || /\/herdr(-app|-core)?(\s|$)/.test(a) },

  { name: "VS Code", icon: "mods/system-monitor/icons/vscode.svg", root: true, test: (c, a) => /^(code|code-insiders|codium)$/.test(c) || /\/(code|vscode|vscodium|code-insiders)\//i.test(a) },
  { name: "Cursor", icon: "icons/cursor.svg", root: true, test: (c, a) => /^cursor$/i.test(c) || /\/cursor\//i.test(a) },
  { name: "Neovim", icon: "mods/files-search/micons/vim.svg", test: (c) => /^nvim$/.test(c) },
  { name: "Vim", icon: "mods/files-search/micons/vim.svg", test: (c) => /^vim$/.test(c) },

  { name: "Vivaldi", icon: "mods/system-monitor/icons/vivaldi.svg", root: true, test: (c, a) => /vivaldi/i.test(c) || /vivaldi/i.test(a) },
  { name: "Brave", icon: "mods/system-monitor/icons/brave-browser.svg", root: true, test: (c, a) => /brave/i.test(c) || /brave-browser/i.test(a) },
  { name: "Chrome", icon: "mods/system-monitor/icons/google-chrome.svg", root: true, test: (c, a) => /chrom(e|ium)/i.test(c) || /google-chrome|\/chromium|chrome-devtools/i.test(a) },
  { name: "Firefox", icon: "mods/system-monitor/icons/firefox.svg", root: true, test: (c, a) => /firefox|isolated web co|web content|webextensions/i.test(c) || /firefox/i.test(a) },

  { name: "Slack", icon: "mods/system-monitor/icons/slack.svg", root: true, test: (c, a) => /slack/i.test(c) || /\/slack\//i.test(a) },
  { name: "Discord", icon: "mods/system-monitor/icons/discord.svg", root: true, test: (c, a) => /discord/i.test(c) || /discord/i.test(a) },
  { name: "Spotify", icon: "mods/system-monitor/icons/spotify.svg", root: true, test: (c, a) => /spotify/i.test(c) || /spotify/i.test(a) },
  { name: "Telegram", icon: "mods/system-monitor/icons/telegram.svg", root: true, test: (c, a) => /telegram/i.test(c) || /telegram/i.test(a) },
  { name: "WhatsApp", icon: "mods/system-monitor/icons/whatsapp.svg", root: true, test: (c, a) => /whatsapp/i.test(c) || /whatsapp/i.test(a) },
  { name: "Teams", icon: "mods/system-monitor/icons/teams.svg", root: true, test: (c, a) => /teams/i.test(c) || /teams-for-linux|ms-teams/i.test(a) },
  { name: "Obsidian", icon: "mods/system-monitor/icons/obsidian.svg", root: true, test: (c, a) => /obsidian/i.test(c) || /obsidian/i.test(a) },
  { name: "Postman", icon: "mods/system-monitor/icons/postman.svg", root: true, test: (c, a) => /postman/i.test(c) || /postman/i.test(a) },
  { name: "DBeaver", icon: "mods/system-monitor/icons/dbeaver.svg", root: true, test: (c, a) => /dbeaver/i.test(c) || /dbeaver/i.test(a) },
  { name: "CopyQ", icon: "mods/system-monitor/icons/copyq.svg", test: (c) => /^copyq$/i.test(c) },
  { name: "Ulauncher", icon: "mods/system-monitor/icons/ulauncher.svg", test: (c, a) => /ulauncher/i.test(c) || /ulauncher/i.test(a) },
  { name: "OBS", icon: "mods/system-monitor/icons/obs.svg", test: (c) => /^obs$/i.test(c) },
  { name: "VLC", icon: "mods/system-monitor/icons/vlc.svg", test: (c) => /^vlc$/i.test(c) },
  { name: "Steam", icon: "mods/system-monitor/icons/steam.svg", root: true, test: (c, a) => /^steam/i.test(c) || /\/steam\//i.test(a) },
  { name: "Blender", icon: "mods/system-monitor/icons/blender.svg", test: (c) => /^blender$/i.test(c) },
  { name: "GIMP", icon: "mods/system-monitor/icons/gimp.svg", test: (c) => /^gimp/i.test(c) },
  { name: "Thunderbird", icon: "mods/system-monitor/icons/thunderbird.svg", test: (c) => /thunderbird/i.test(c) },
  { name: "Bitwarden", icon: "mods/system-monitor/icons/bitwarden.svg", test: (c, a) => /bitwarden/i.test(c) || /bitwarden/i.test(a) },
  { name: "1Password", icon: "mods/system-monitor/icons/1password.svg", test: (c, a) => /1password/i.test(c) || /1password/i.test(a) },
  { name: "Alacritty", icon: "mods/system-monitor/icons/Alacritty.svg", test: (c) => /^alacritty$/i.test(c) },
  { name: "Kitty", icon: "mods/system-monitor/icons/kitty.svg", test: (c) => /^kitty$/i.test(c) },

  { name: "Docker", icon: "mods/files-search/micons/docker.svg", root: true, test: (c, a) => /^(dockerd|docker|containerd|buildkitd|docker-proxy|containerd-shim)/.test(c) || /containerd|dockerd/.test(a) },
  { name: "Podman", icon: "mods/system-monitor/icons/podman.svg", root: true, test: (c) => /^podman/.test(c) },

  { name: "Postgres", icon: "mods/system-monitor/icons/postgres.svg", test: (c) => /^(postgres|psql)$/.test(c) },
  { name: "MySQL", icon: "mods/system-monitor/icons/mysql.svg", test: (c) => /^(mysqld|mariadbd|mysql)$/.test(c) },
  { name: "MongoDB", icon: "mods/system-monitor/icons/mongodb.svg", test: (c) => /^(mongod|mongosh)$/.test(c) },
  { name: "Redis", icon: "mods/system-monitor/icons/redis.svg", test: (c) => /^redis/.test(c) },

  { name: "Java", icon: "mods/system-monitor/icons/java.svg", test: (c) => /^(java|javac|gradle|mvn)$/.test(c) },
  { name: "Bun", icon: "mods/files-search/micons/bun.svg", test: (c) => /^bun$/.test(c) },
  { name: "Deno", icon: "mods/files-search/micons/deno.svg", test: (c) => /^deno$/.test(c) },
  { name: "Node.js", icon: "mods/files-search/micons/nodejs.svg", test: (c) => /^(node|node-mainthread|npm|pnpm|yarn|esbuild|vite|tsx|tsserver)$/.test(c) },
  { name: "Python", icon: "mods/files-search/micons/python.svg", test: (c) => /^python(\d+(\.\d+)?)?$|^uv$|^uvicorn$|^gunicorn$|^pytest$/.test(c) },
  { name: "Rust", icon: "mods/files-search/micons/rust.svg", test: (c) => /^(rustc|cargo|rust-analyzer)$/.test(c) },
  { name: "Go", icon: "mods/files-search/micons/go.svg", test: (c) => /^(go|gopls)$/.test(c) },
  { name: "PHP", icon: "mods/files-search/micons/php.svg", test: (c) => /^php(\d+(\.\d+)?)?$|^php-fpm/.test(c) },
  { name: "Ruby", icon: "mods/files-search/micons/ruby.svg", test: (c) => /^(ruby|bundle|rails|puma)$/.test(c) },
  { name: ".NET", icon: "mods/system-monitor/icons/dotnet.svg", test: (c) => /^dotnet$/.test(c) },
  { name: "Erlang", icon: "mods/files-search/micons/erlang.svg", test: (c) => /^(beam\.smp|erl|epmd)$/.test(c) },
  { name: "Kotlin", icon: "mods/files-search/micons/kotlin.svg", test: (c) => /^kotlin/.test(c) },
  { name: "Scala", icon: "mods/files-search/micons/scala.svg", test: (c) => /^scala/.test(c) },
  { name: "Swift", icon: "mods/files-search/micons/swift.svg", test: (c) => /^swift/.test(c) },
  { name: "Dart", icon: "mods/files-search/micons/dart.svg", test: (c) => /^(dart|flutter)$/.test(c) },
  { name: "Lua", icon: "mods/files-search/micons/lua.svg", test: (c) => /^lua/.test(c) },
  { name: "Zig", icon: "mods/files-search/micons/zig.svg", test: (c) => /^zig$/.test(c) },
  { name: "Shell", icon: "icons/shell.svg", tint: true, test: (c) => /^(zsh|bash|fish|sh|dash)$/.test(c) },
  { name: "tmux", icon: "icons/tmux.svg", tint: true, test: (c) => /^tmux/.test(c) },
];

const GENERIC_HELPER = /^(mainthread|sh|bash|zsh|dash|node|npm|npx|python\d*|conmon|cat|tee|sleep|mcp-remote|chrome-devtools|utility)$/i;

function classifyApp(comm, args) {
  const c = comm.toLowerCase();
  const a = args.toLowerCase();
  for (const rule of APP_RULES) {
    if (rule.test(c, a)) return { name: rule.name, icon: rule.icon, tint: Boolean(rule.tint), root: Boolean(rule.root), matched: true };
  }
  const clean = comm.replace(/^\/.*\//, "").slice(0, 22);
  return { name: clean || "other", icon: "icons/program.svg", tint: true, root: false, matched: false };
}

function renderAppIcon(app, t) {
  if (app.tint) return svg(app.icon).size(16).flex_none().text_color(t.dim);
  return image(app.icon).w(16).h(16).flex_none();
}

function formatMem(kb) {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)}G`;
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`;
  return `${kb}K`;
}

function formatPct(pct) {
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return "0%";
}

function barColor(pct, t) {
  if (pct >= 85) return t.ansi1;
  if (pct >= 65) return t.blocked;
  return t.accent;
}

function appAlertStyle(pct, t) {
  if (pct >= 20) return { bg: t.ansi1 + "42", border: t.ansi1, text: t.ansi1 };
  if (pct >= 10) return { bg: t.blocked + "38", border: t.blocked, text: t.blocked };
  if (pct >= 4) return { bg: t.accent + "26", border: t.accent + "70", text: t.accent };
  return { bg: t.surface, border: t.border, text: t.dim };
}

const SAMPLE_SCRIPT = `
head -n 1 /proc/stat
printf '===MEM===\\n'
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
printf '===CORES===\\n'
nproc 2>/dev/null || echo 1
printf '===PS===\\n'
ps -eo pid=,ppid=,pcpu=,rss=,comm=,args= --no-headers | awk '$4 > 0 || $3+0 > 0 { cmd=substr($0, index($0,$6), 110); gsub(/\\t/, " ", cmd); printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", $1, $2, $3, $4, $5, cmd }'
`;

export default class SystemMonitor extends View {
  init(_props, cx) {
    this.sortBy = "ram";
    this.collapsed = false;
    this.expandedApp = null;
    this.width = 268;
    this.prevCpu = null;
    this.cpuPct = 0;
    this.memUsedKb = 0;
    this.memTotalKb = 0;
    this.memPct = 0;
    this.swapUsedKb = 0;
    this.swapTotalKb = 0;
    this.cores = 1;
    this.apps = [];
    this.sampling = false;
    this.cleaning = false;
    this.lastPollAt = 0;
    this.lastCleanAt = 0;
    this.lastCleanSummary = "";
    this.error = null;

    if (checking()) return;
    this.sample(cx);
    cx.spawn(async cx => {
      await cx.sleep(5000);
      this.runAutoCleanup(cx, "startup");
    });
    cx.timer.every(ACTIVE_POLL_MS, cx => {
      const w = window();
      if (w?.visible === false) return;
      const now = Date.now();
      const interval = w?.active === false ? UNFOCUSED_POLL_MS : ACTIVE_POLL_MS;
      if (now - this.lastPollAt >= interval - 100) {
        this.sample(cx);
      }
      if (now - this.lastCleanAt >= AUTO_CLEAN_MS) {
        this.runAutoCleanup(cx, this.memPct >= HIGH_RAM_GC_PCT ? "high-ram" : "auto");
      }
    });
  }

  sample(cx) {
    if (this.sampling) return;
    this.sampling = true;
    this.lastPollAt = Date.now();
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", SAMPLE_SCRIPT], { timeout: 4000 });
        if (r.code !== 0) throw new Error(r.stderr || "Cannot read system stats");
        this.parseSample(r.stdout || "");
        this.error = null;
      } catch (e) {
        this.error = String(e.message || e);
      } finally {
        this.sampling = false;
        cx.notify();
      }
    });
  }

  runAutoCleanup(cx, reason = "manual") {
    if (this.cleaning) return;
    this.cleaning = true;
    this.lastCleanAt = Date.now();
    cx.spawn(async cx => {
      let removedTerminals = 0;
      try {
        const lsRes = await hc(["ls", "--all", "--json"]).catch(() => null);
        if (lsRes?.code === 0 && lsRes.stdout) {
          const parsed = JSON.parse(lsRes.stdout);
          const finished = (parsed.terminals ?? []).filter(t => t.state === "finished" && t.address);
          for (const term of finished.slice(0, 40)) {
            const rm = await hc(["rm", term.address]).catch(() => null);
            if (rm?.code === 0) removedTerminals++;
          }
        }

        const meta = shared("file-viewer.meta");
        if (meta && typeof meta === "object") {
          const liveIds = new Set(panes().filter(p => p.mod === "file-viewer").map(p => p.pane));
          const pruned = {};
          let changed = false;
          for (const [k, v] of Object.entries(meta)) {
            if (liveIds.has(k)) pruned[k] = v;
            else changed = true;
          }
          if (changed) setShared("file-viewer.meta", pruned);
        }

        if (reason === "manual" || reason === "high-ram" || removedTerminals > 0) {
          const prevSeq = shared("herdr.gc")?.seq ?? 0;
          setShared("herdr.gc", { seq: prevSeq + 1, at: Date.now(), reason });
        }

        if (removedTerminals > 0 || reason === "manual") {
          this.lastCleanSummary = removedTerminals > 0
            ? `Freed ${removedTerminals} finished term${removedTerminals === 1 ? "" : "s"} + caches`
            : "Caches & inactive tabs trimmed";
        }
      } catch {
        // Ignore cleanup errors
      } finally {
        this.cleaning = false;
        cx.notify();
      }
    });
  }

  parseSample(stdout) {
    const [statSec = "", rest1 = ""] = stdout.split("===MEM===\n");
    const [memSec = "", rest2 = ""] = rest1.split("===CORES===\n");
    const [coresSec = "1", psSec = ""] = rest2.split("===PS===\n");

    const cpuParts = statSec.trim().split(/\s+/).slice(1).map(Number);
    if (cpuParts.length >= 4) {
      const idle = (cpuParts[3] || 0) + (cpuParts[4] || 0);
      const total = cpuParts.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
      if (this.prevCpu) {
        const dTotal = total - this.prevCpu.total;
        const dIdle = idle - this.prevCpu.idle;
        if (dTotal > 0) {
          this.cpuPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
        }
      }
      this.prevCpu = { idle, total };
    }

    let memTotal = 0, memAvail = 0, swapTotal = 0, swapFree = 0;
    for (const line of memSec.split("\n")) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (!m) continue;
      if (m[1] === "MemTotal") memTotal = Number(m[2]);
      else if (m[1] === "MemAvailable") memAvail = Number(m[2]);
      else if (m[1] === "SwapTotal") swapTotal = Number(m[2]);
      else if (m[1] === "SwapFree") swapFree = Number(m[2]);
    }
    if (memTotal > 0) {
      this.memTotalKb = memTotal;
      this.memUsedKb = Math.max(0, memTotal - memAvail);
      this.memPct = Math.max(0, Math.min(100, (this.memUsedKb / memTotal) * 100));
    }
    this.swapTotalKb = swapTotal;
    this.swapUsedKb = Math.max(0, swapTotal - swapFree);
    this.cores = Math.max(1, Number(coresSec.trim()) || 1);

    const procByPid = new Map();
    for (const raw of psSec.split("\n")) {
      if (!raw) continue;
      const parts = raw.split("\t");
      if (parts.length < 5) continue;
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const pcpu = parseFloat(parts[2]) || 0;
      const rss = parseInt(parts[3], 10) || 0;
      const comm = parts[4];
      const args = parts[5] || comm;
      if (!pid || (rss === 0 && pcpu === 0)) continue;
      procByPid.set(pid, { pid, ppid, pcpu, rss, comm, args, info: classifyApp(comm, args) });
    }

    const grouped = new Map();
    for (const proc of procByPid.values()) {
      let chosen = proc.info;
      let depth = 0;
      if (!chosen.root && (!chosen.matched || GENERIC_HELPER.test(proc.comm))) {
        let cur = procByPid.get(proc.ppid);
        let hops = 1;
        while (cur && hops <= 6) {
          if (cur.info.root) {
            chosen = cur.info;
            depth = hops;
            break;
          }
          cur = procByPid.get(cur.ppid);
          hops++;
        }
      }

      let entry = grouped.get(chosen.name);
      if (!entry) {
        entry = {
          name: chosen.name,
          icon: chosen.icon,
          tint: chosen.tint,
          cpu: 0,
          rss: 0,
          count: 0,
          maxDepth: 0,
          deepCount: 0,
          deepRss: 0,
          subProcs: [],
        };
        grouped.set(chosen.name, entry);
      }
      entry.cpu += proc.pcpu;
      entry.rss += proc.rss;
      entry.count += 1;
      if (depth > 0) {
        entry.deepCount += 1;
        entry.deepRss += proc.rss;
        if (depth > entry.maxDepth) entry.maxDepth = depth;
      }
      if (this.expandedApp === chosen.name) {
        entry.subProcs.push({ pid: proc.pid, comm: proc.comm, rss: proc.rss, depth });
      }
    }

    this.apps = [...grouped.values()].map(a => {
      if (a.subProcs.length > 1) {
        a.subProcs.sort((x, y) => y.rss - x.rss);
        a.subProcs = a.subProcs.slice(0, 6);
      }
      return {
        ...a,
        cpuNorm: Math.min(100, a.cpu / this.cores),
        ramPct: this.memTotalKb > 0 ? Math.min(100, (a.rss / this.memTotalKb) * 100) : 0,
      };
    });
  }

  sortedApps() {
    const list = [...this.apps];
    if (this.sortBy === "cpu") {
      list.sort((a, b) => b.cpuNorm - a.cpuNorm || b.rss - a.rss);
    } else {
      list.sort((a, b) => b.rss - a.rss || b.cpuNorm - a.cpuNorm);
    }
    return list.slice(0, MAX_APPS);
  }

  meterRow(label, valueText, pct, t) {
    const clamped = Math.max(0, Math.min(100, pct));
    const trackW = Math.max(40, this.width - 24);
    const fillPx = clamped > 0 ? Math.max(3, Math.round((trackW * clamped) / 100)) : 0;
    const color = barColor(clamped, t);

    return v_flex()
      .gap(3)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .text_size(11.5)
          .child(div().font_semibold().text_color(t.muted).child(label))
          .child(div().text_color(t.foreground).child(valueText)),
      )
      .child(
        h_flex()
          .h(4)
          .w_full()
          .rounded(999)
          .overflow_hidden()
          .bg(t.surface)
          .when(fillPx > 0, el => el.child(div().h_full().w(fillPx).rounded(999).bg(color))),
      );
  }

  renderCompact(t) {
    const sysCpuColor = barColor(this.cpuPct, t);
    const sysRamColor = barColor(this.memPct, t);
    const topApps = this.sortedApps().slice(0, 8);
    const swapNote = this.swapTotalKb ? ` · Swap ${formatMem(this.swapUsedKb)}/${formatMem(this.swapTotalKb)}` : "";
    const sysTip = `System · CPU ${formatPct(this.cpuPct)} (${this.cores} cores) · RAM ${this.memTotalKb ? `${formatMem(this.memUsedKb)} / ${formatMem(this.memTotalKb)} (${Math.round(this.memPct)}%)` : "…"}${swapNote} · Orden: ${this.sortBy.toUpperCase()} (clic para cambiar)`;

    return v_flex()
      .size_full()
      .min_h(0)
      .items_center()
      .gap(5)
      .py(6)
      .child(
        v_flex()
          .id("sysmon-compact-toggle")
          .w(34)
          .py(3)
          .rounded(6)
          .items_center()
          .gap(2)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover(s => s.bg(t.hover))
          .tooltip(sysTip)
          .on_click((_e, cx) => {
            this.sortBy = this.sortBy === "ram" ? "cpu" : "ram";
            cx.notify();
          })
          .child(div().text_size(8.5).font_semibold().text_color(sysCpuColor).child(`C ${Math.round(this.cpuPct)}%`))
          .child(div().text_size(8.5).font_semibold().text_color(sysRamColor).child(`R ${Math.round(this.memPct)}%`)),
      )
      .child(
        v_flex()
          .id("sysmon-compact-apps")
          .flex_1()
          .min_h(0)
          .w_full()
          .overflow_y_scrollbar()
          .items_center()
          .gap(4)
          .pb(4)
          .children(
            topApps.map(app => {
              const primaryPct = this.sortBy === "cpu" ? app.cpuNorm : app.ramPct;
              const alertPct = Math.max(app.ramPct, app.cpuNorm);
              const style = appAlertStyle(alertPct, t);
              const procLabel = app.count === 1 ? "1 proceso" : `${app.count} procesos`;
              const deepNote = app.deepCount > 0 ? ` · ${app.deepCount} hijos (${formatMem(app.deepRss)}, prof. ${app.maxDepth})` : "";
              const tip = `${app.name} · RAM: ${formatMem(app.rss)} (${formatPct(app.ramPct)}) · CPU: ${formatPct(app.cpuNorm)} · ${procLabel}${deepNote}`;
              return v_flex()
                .id(`sysmon-c-${app.name}`)
                .w(32)
                .py(3)
                .rounded(7)
                .items_center()
                .justify_center()
                .gap(1)
                .bg(style.bg)
                .border_1()
                .border_color(style.border)
                .tooltip(tip)
                .child(renderAppIcon(app, t))
                .child(div().text_size(8.5).font_semibold().text_color(style.text).child(`${Math.round(primaryPct)}%`));
            }),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;
    const compact = this.width < 140;

    return v_flex()
      .id("system-monitor")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_size_change((size, cx) => {
        const w = size.width / settings().zoom;
        if (Math.abs(w - this.width) > 2) {
          this.width = w;
          cx.notify();
        }
      })
      .when(compact, el => el.child(this.renderCompact(t)))
      .when(!compact, el =>
        el
          .child(
            h_flex()
              .h(34)
              .flex_none()
              .px(12)
              .gap(5)
              .items_center()
              .child(
                div()
                  .id("sysmon-collapse")
                  .flex_1()
                  .cursor_pointer()
                  .text_size(12)
                  .font_medium()
                  .text_color(t.muted)
                  .hover(s => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.collapsed = !this.collapsed;
                    cx.notify();
                  })
                  .child(this.collapsed ? "System ▸" : "System"),
              )
              .child(
                div()
                  .id("sysmon-gc")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .text_size(10.5)
                  .font_semibold()
                  .cursor_pointer()
                  .text_color(this.cleaning ? t.accent : t.dim)
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .tooltip(this.lastCleanSummary ? `Clean RAM & finished terminals\n${this.lastCleanSummary}` : "Clean RAM caches & finished terminals (auto every 60s)")
                  .on_click((_e, cx) => this.runAutoCleanup(cx, "manual"))
                  .child(this.cleaning ? "…" : "GC"),
              )
              .child(
                div()
                  .id("sysmon-sort-ram")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .text_size(10.5)
                  .font_semibold()
                  .cursor_pointer()
                  .when(this.sortBy === "ram", c => c.bg(t.selected))
                  .text_color(this.sortBy === "ram" ? t.accent : t.dim)
                  .hover(s => s.bg(this.sortBy === "ram" ? t.selected : t.hover).text_color(this.sortBy === "ram" ? t.accent : t.foreground))
                  .on_click((_e, cx) => {
                    this.sortBy = "ram";
                    cx.notify();
                  })
                  .child("RAM"),
              )
              .child(
                div()
                  .id("sysmon-sort-cpu")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .text_size(10.5)
                  .font_semibold()
                  .cursor_pointer()
                  .when(this.sortBy === "cpu", c => c.bg(t.selected))
                  .text_color(this.sortBy === "cpu" ? t.accent : t.dim)
                  .hover(s => s.bg(this.sortBy === "cpu" ? t.selected : t.hover).text_color(this.sortBy === "cpu" ? t.accent : t.foreground))
                  .on_click((_e, cx) => {
                    this.sortBy = "cpu";
                    cx.notify();
                  })
                  .child("CPU"),
              ),
          )
          .child(
            v_flex()
              .flex_none()
              .px(12)
              .pb(8)
              .gap(7)
              .child(this.meterRow("CPU", `${formatPct(this.cpuPct)}`, this.cpuPct, t))
              .child(
                this.meterRow(
                  "RAM",
                  this.memTotalKb
                    ? `${formatMem(this.memUsedKb)} / ${formatMem(this.memTotalKb)} (${Math.round(this.memPct)}%)`
                    : "…",
                  this.memPct,
                  t,
                ),
              ),
          )
          .when(!this.collapsed, body =>
            body.child(
              v_flex()
                .id("sysmon-apps")
                .flex_1()
                .min_h(0)
                .overflow_y_scrollbar()
                .px(6)
                .pb(6)
                .gap(1)
                .when(Boolean(this.error), err =>
                  err.child(div().px(6).py(4).text_size(11).text_color(t.ansi1).child(this.error)),
                )
                .children(
                  this.sortedApps().flatMap(app => {
                    const isExpanded = this.expandedApp === app.name;
                    const procLabel = app.count === 1 ? "1 proceso" : `${app.count} procesos`;
                    const deepNote = app.deepCount > 0 ? ` · ${app.deepCount} hijos (${formatMem(app.deepRss)}, prof. ${app.maxDepth})` : "";
                    const tip = `${app.name} · RAM: ${formatMem(app.rss)} (${formatPct(app.ramPct)}) · CPU: ${formatPct(app.cpuNorm)} · ${procLabel}${deepNote}\nClic para ver subprocesos`;
                    const rows = [
                      h_flex()
                        .id(`sysmon-app-${app.name}`)
                        .h(25)
                        .flex_none()
                        .px(6)
                        .gap(6)
                        .items_center()
                        .rounded(5)
                        .cursor_pointer()
                        .when(isExpanded, r => r.bg(t.selected))
                        .hover(s => s.bg(isExpanded ? t.selected : t.hover))
                        .tooltip(tip)
                        .on_click((_e, cx) => {
                          this.expandedApp = isExpanded ? null : app.name;
                          if (this.expandedApp) this.sample(cx);
                          cx.notify();
                        })
                        .child(renderAppIcon(app, t))
                        .child(
                          div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .text_size(11.5)
                            .text_color(t.foreground)
                            .child(app.name),
                        )
                        .when(app.deepCount > 0, r =>
                          r.child(div().px(3).rounded(3).bg(t.surface).text_size(9.5).text_color(t.dim).child(`+${app.deepCount}`)),
                        )
                        .child(
                          div()
                            .w(34)
                            .flex_none()
                            .text_right()
                            .text_size(11)
                            .text_color(this.sortBy === "cpu" ? t.foreground : t.dim)
                            .child(formatPct(app.cpuNorm)),
                        )
                        .child(
                          div()
                            .w(42)
                            .flex_none()
                            .text_right()
                            .text_size(11)
                            .font_medium()
                            .text_color(this.sortBy === "ram" ? t.foreground : t.muted)
                            .child(formatMem(app.rss)),
                        ),
                    ];
                    if (isExpanded && app.subProcs.length > 0) {
                      for (const sp of app.subProcs) {
                        rows.push(
                          h_flex()
                            .id(`sysmon-sp-${app.name}-${sp.pid}`)
                            .h(20)
                            .flex_none()
                            .pl(24)
                            .pr(8)
                            .gap(6)
                            .items_center()
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(div().flex_1().min_w(0).truncate().child(`${sp.depth > 0 ? `└d${sp.depth} ` : ""}${sp.comm} (${sp.pid})`))
                            .child(div().flex_none().text_color(t.muted).child(formatMem(sp.rss))),
                        );
                      }
                    }
                    return rows;
                  }),
                ),
            ),
          ),
      );
  }
}
