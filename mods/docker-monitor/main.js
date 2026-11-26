import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, settings, window, shared, layout, checking, run } from "herdr";
import { STACK, BRAND_PX, findNode, snapshotHeights, pushResize, fitStackToViewport } from "./stack-resize.js";
import { MAX_CPU_HISTORY, formatBytes, runContainerAction, sampleContainers } from "./docker.js";

const OWN_ID = "docker";
const COLLAPSED_PX = 64;
const DEFAULT_EXPANDED = 180;
const EXPANDED_KEY = "docker.expandedPx";
const COLLAPSED_KEY = "docker.collapsed";
const RAIL_WIDTH_PX = 140;
const MINI_HEIGHT_PX = 96;
const TICK_MS = 1_000;
const ACTIVE_POLL_MS = 5_000;
const UNFOCUSED_POLL_MS = 15_000;
const ERROR_BACKOFF_MS = 60_000;
const IDLE_EVICT_MS = 30_000;
const DESTRUCTIVE_ACTIONS = new Set(["stop", "rm"]);
const ACTION_LABELS = { start: "Start", stop: "Stop", restart: "Restart", rm: "Remove" };
const ACTION_PROGRESS = { start: "Starting…", stop: "Stopping…", restart: "Restarting…", rm: "Removing…" };
const DOCKER_ICON = "mods/docker-monitor/icons/docker.svg";

function isSidebarVisible() {
  if (window()?.visible === false) return false;
  return !findNode(layout(), "sidebar")?.hidden;
}

function loadColor(pct, t) {
  if (pct >= 85) return t.ansi1;
  if (pct >= 50) return t.blocked;
  return t.accent;
}

function stateColor(container, t) {
  if (container.running) return t.ansi2;
  if (container.state === "paused" || container.state === "restarting") return t.blocked;
  return t.dim;
}

function formatPct(pct) {
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

function groupByProject(containers) {
  const groups = new Map();
  for (const container of containers) {
    const key = container.project || "standalone";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(container);
  }
  return [...groups.entries()];
}

function totalsOf(containers) {
  const running = containers.filter(c => c.running);
  return {
    running: running.length,
    cpu: running.reduce((sum, c) => sum + c.cpuPct, 0),
    mem: running.reduce((sum, c) => sum + c.memBytes, 0),
  };
}

export default class DockerMonitor extends View {
  init(_props, cx) {
    this.containers = [];
    this.error = null;
    this.actionError = null;
    this.loaded = false;
    this.sampling = false;
    this.lastPollAt = 0;
    this.retryAt = 0;
    this.hiddenSince = 0;
    this.cpuHistory = new Map();
    this.busy = new Map();
    this.hoveredId = null;
    this.pendingConfirm = null;
    this.showStopped = localStorage.getItem("docker.showStopped") === "1";
    this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
    this.collapsedGroups = new Set();
    this.width = 268;
    this.blockHeight = DEFAULT_EXPANDED;
    this.drag = null;
    this.handleHover = false;
    this.initAt = Date.now();
    this.lastGcSeq = shared("herdr.gc")?.seq ?? 0;

    if (checking()) return;
    if (this.collapsed) run("layout.resize", { id: OWN_ID, px: COLLAPSED_PX });
    cx.timer.every(TICK_MS, cx => this.tick(cx));
  }

  close() {
    this.evict();
  }

  evict() {
    this.containers = [];
    this.cpuHistory.clear();
    this.collapsedGroups.clear();
    this.pendingConfirm = null;
    this.loaded = false;
  }

  tick(cx) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    if (gcSeq !== this.lastGcSeq) {
      this.lastGcSeq = gcSeq;
      this.cpuHistory.clear();
    }

    const now = Date.now();
    if (!isSidebarVisible()) {
      if (!this.hiddenSince) this.hiddenSince = now;
      if (this.loaded && now - this.hiddenSince >= IDLE_EVICT_MS) this.evict();
      return;
    }
    this.hiddenSince = 0;
    if (now < this.retryAt) return;
    const interval = this.collapsed || window()?.active === false ? UNFOCUSED_POLL_MS : ACTIVE_POLL_MS;
    if (!this.loaded || now - this.lastPollAt >= interval - 100) this.refresh(cx);
  }

  refresh(cx) {
    if (this.sampling) return;
    this.sampling = true;
    this.lastPollAt = Date.now();
    cx.spawn(async cx => {
      try {
        this.applySample(await sampleContainers());
      } catch (err) {
        this.applySample({ ok: false, error: String(err?.message ?? err), containers: [] });
      } finally {
        this.sampling = false;
        cx.notify();
      }
    });
  }

  applySample(sample) {
    this.loaded = true;
    this.error = sample.ok ? null : sample.error;
    this.retryAt = sample.ok ? 0 : Date.now() + ERROR_BACKOFF_MS;
    this.containers = sample.containers;
    this.recordCpuHistory(sample.containers);
  }

  recordCpuHistory(containers) {
    const alive = new Set();
    for (const container of containers) {
      if (!container.running) continue;
      alive.add(container.name);
      const history = this.cpuHistory.get(container.name) ?? [];
      history.push(container.cpuPct);
      if (history.length > MAX_CPU_HISTORY) history.shift();
      this.cpuHistory.set(container.name, history);
    }
    for (const name of this.cpuHistory.keys()) if (!alive.has(name)) this.cpuHistory.delete(name);
  }

  requestAction(action, container, cx) {
    if (this.busy.has(container.id)) return;
    if (DESTRUCTIVE_ACTIONS.has(action)) {
      this.pendingConfirm = { action, container };
      cx.notify();
      return;
    }
    this.performAction(action, container, cx);
  }

  performAction(action, container, cx) {
    this.pendingConfirm = null;
    if (this.busy.has(container.id)) return;
    this.actionError = null;
    this.busy.set(container.id, action);
    cx.notify();
    cx.spawn(async cx => {
      const result = await runContainerAction(action, container.id);
      this.busy.delete(container.id);
      if (!result.ok) this.actionError = `${ACTION_LABELS[action]} ${container.name}: ${result.error}`;
      this.refresh(cx);
      cx.notify();
    });
  }

  openTerminal(argv) {
    run("terminal.open", { argv, place: "tab" });
  }

  toggleCollapsed(cx) {
    this.collapsed = !this.collapsed;
    try { localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0"); } catch {}
    if (this.collapsed) {
      if (this.blockHeight > COLLAPSED_PX + 24) {
        try { localStorage.setItem(EXPANDED_KEY, String(Math.round(this.blockHeight))); } catch {}
      }
      run("layout.resize", { id: OWN_ID, px: COLLAPSED_PX });
    } else {
      fitStackToViewport(OWN_ID, Number(localStorage.getItem(EXPANDED_KEY)) || DEFAULT_EXPANDED);
      this.refresh(cx);
    }
    cx.notify();
  }

  startDrag(e) {
    const z = settings().zoom || 1;
    const heights = snapshotHeights(layout(), OWN_ID, this.blockHeight);
    const ownTop = (e.bounds?.y ?? e.position.y) / z;
    const above = STACK.slice(0, STACK.indexOf(OWN_ID)).reduce((s, id) => s + heights[id], 0);
    const spacesH = Math.max(90, ownTop - BRAND_PX - above);
    this.drag = { startY: e.position.y, heights, spacesH, last: { ...heights } };
  }

  endDrag() {
    const h = this.drag?.last?.[OWN_ID];
    this.drag = null;
    if (h && h > COLLAPSED_PX + 24) {
      try { localStorage.setItem(EXPANDED_KEY, String(h)); } catch {}
    }
  }

  onSizeChange(size, cx) {
    let changed = false;
    if (Math.abs(size.width - this.width) >= 10 || Math.abs(size.height - this.blockHeight) >= 6) {
      this.width = size.width;
      this.blockHeight = size.height;
      changed = true;
    }
    if (this.collapsed && Date.now() - this.initAt > 1500 && size.height >= COLLAPSED_PX + 30) {
      this.collapsed = false;
      try { localStorage.setItem(COLLAPSED_KEY, "0"); } catch {}
      changed = true;
    }
    if (changed) cx.notify();
  }

  onDragMove(e, cx) {
    if (!this.drag) return;
    if (e.pressed_button !== "left") { this.endDrag(); cx.notify(); return; }
    const z = settings().zoom || 1;
    const dy = ((e.position?.y ?? 0) - this.drag.startY) / z;
    const next = pushResize({ heights: this.drag.heights, spacesH: this.drag.spacesH, targetId: OWN_ID, dy });
    for (const id of STACK) if (next[id] !== this.drag.last[id]) run("layout.resize", { id, px: next[id] });
    this.drag.last = next;
  }

  renderButton(id, label, t, onClick, { tone, disabled } = {}) {
    return div()
      .id(id)
      .px(5)
      .h(19)
      .flex_none()
      .flex()
      .items_center()
      .rounded(4)
      .text_size(10)
      .font_semibold()
      .text_color(tone ?? t.muted)
      .when(Boolean(disabled), el => el.opacity(0.35))
      .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(tone ?? t.foreground)).on_click(onClick))
      .child(label);
  }

  renderSparkline(name, t) {
    const history = this.cpuHistory.get(name) ?? [];
    const peak = Math.max(10, ...history);
    return h_flex()
      .h(14)
      .flex_none()
      .items_end()
      .gap(1)
      .children(history.map(value => div().w(2).h(Math.max(1, Math.round((value / peak) * 14))).bg(loadColor(value, t))));
  }

  renderMeter(pct, t) {
    const clamped = Math.max(0, Math.min(100, pct));
    return div()
      .h(4)
      .flex_1()
      .min_w(30)
      .rounded(999)
      .overflow_hidden()
      .bg(t.surface)
      .when(clamped > 0, el => el.child(div().h_full().w(`${Math.max(2, Math.round(clamped))}%`).rounded(999).bg(loadColor(clamped, t))));
  }

  renderSummaryLine(container, label, t) {
    const pendingAction = this.busy.get(container.id);
    const showStats = container.running && !pendingAction;
    return h_flex()
      .w_full()
      .gap(6)
      .items_center()
      .child(div().size(6).flex_none().rounded(999).bg(pendingAction ? t.working : stateColor(container, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(container.running ? t.foreground : t.muted).child(label))
      .when(Boolean(pendingAction), el =>
        el
          .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
          .child(div().flex_none().text_size(10).font_semibold().text_color(t.working).child(ACTION_PROGRESS[pendingAction])),
      )
      .when(showStats, el =>
        el
          .child(div().w(40).flex_none().text_size(10.5).text_color(loadColor(container.cpuPct, t)).text_right().child(container.hasStats ? formatPct(container.cpuPct) : "—"))
          .child(div().w(42).flex_none().text_size(10.5).text_color(t.foreground).text_right().child(container.hasStats ? formatBytes(container.memBytes) : "—")),
      )
      .when(!container.running && !pendingAction, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(container.state)));
  }

  renderActions(container, busy, t) {
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex()
      .flex_wrap()
      .gap(1)
      .items_center()
      .when(busy, el => el.opacity(0.4))
      .on_mouse_down("left", stop)
      .child(this.renderButton(`dk-logs-${container.id}`, "Logs", t, () => this.openTerminal(["docker", "logs", "-f", "--tail", "200", "--", container.id])))
      .child(this.renderButton(`dk-shell-${container.id}`, "Shell", t, () => this.openTerminal(["docker", "exec", "-it", "--", container.id, "sh"]), { disabled: busy || !container.running }))
      .child(this.renderButton(`dk-restart-${container.id}`, "Restart", t, (_e, cx) => this.requestAction("restart", container, cx), { disabled: busy }))
      .child(
        container.running
          ? this.renderButton(`dk-stop-${container.id}`, "Stop", t, (_e, cx) => this.requestAction("stop", container, cx), { disabled: busy, tone: t.blocked })
          : this.renderButton(`dk-start-${container.id}`, "Start", t, (_e, cx) => this.requestAction("start", container, cx), { disabled: busy, tone: t.ansi2 }),
      )
      .child(this.renderButton(`dk-rm-${container.id}`, "Remove", t, (_e, cx) => this.requestAction("rm", container, cx), { disabled: busy || container.running, tone: t.ansi1 }));
  }

  renderDetails(container, busy, t) {
    const ports = container.ports.length ? container.ports.join("  ") : "no published ports";
    return v_flex()
      .w_full()
      .pl(12)
      .gap(3)
      .child(div().truncate().text_size(10).text_color(t.muted).child(container.image))
      .child(div().truncate().text_size(10).text_color(t.dim).child(`${ports} · ${container.status}`))
      .when(container.hasStats, el =>
        el
          .child(
            h_flex()
              .w_full()
              .gap(5)
              .items_center()
              .child(div().w(26).flex_none().text_size(9.5).text_color(t.dim).child("RAM"))
              .child(this.renderMeter(container.memPct, t))
              .child(div().flex_none().text_size(9.5).text_color(t.dim).child(`${formatPct(container.memPct)} of ${formatBytes(container.memLimitBytes)}`)),
          )
          .child(
            h_flex()
              .w_full()
              .gap(5)
              .items_center()
              .child(div().w(26).flex_none().text_size(9.5).text_color(t.dim).child("CPU"))
              .child(this.renderSparkline(container.name, t))
              .child(div().flex_1())
              .child(div().flex_none().text_size(9.5).text_color(t.dim).child(`${container.pids} pids`)),
          ),
      )
      .child(this.pendingConfirm?.container.id === container.id ? this.renderConfirm(t) : this.renderActions(container, busy, t));
  }

  // Rows stay one line (name, CPU, RAM); hovering one reveals image, ports, meters and actions.
  renderContainer(container, t) {
    const busy = this.busy.has(container.id);
    const expanded = this.hoveredId === container.id || this.pendingConfirm?.container.id === container.id;
    return v_flex()
      .id(`dk-row-${container.id}`)
      .w_full()
      .px(6)
      .py(4)
      .gap(4)
      .rounded(5)
      .when(expanded, el => el.bg(t.hover))
      .on_hover((hovered, cx) => {
        if (hovered) this.hoveredId = container.id;
        else if (this.hoveredId === container.id) this.hoveredId = null;
        cx.notify();
      })
      .child(this.renderSummaryLine(container, container.service || container.name, t))
      .when(expanded, el => el.child(this.renderDetails(container, busy, t)));
  }

  renderGroup([project, containers], t) {
    const collapsed = this.collapsedGroups.has(project);
    const totals = totalsOf(containers);
    return v_flex()
      .gap(1)
      .child(
        h_flex()
          .id(`dk-group-${project}`)
          .h(22)
          .px(6)
          .gap(5)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (collapsed) this.collapsedGroups.delete(project);
            else this.collapsedGroups.add(project);
            cx.notify();
          })
          .child(div().w(9).text_size(9.5).text_color(t.dim).child(collapsed ? "▸" : "▾"))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_semibold().text_color(t.muted).child(`${project} (${totals.running}/${containers.length})`))
          .child(div().flex_none().text_size(10).text_color(t.dim).child(`${formatPct(totals.cpu)} · ${formatBytes(totals.mem)}`)),
      )
      .when(!collapsed, el => el.children(containers.map(c => this.renderContainer(c, t))));
  }

  renderConfirm(t) {
    const { action, container } = this.pendingConfirm;
    const verb = action === "rm" ? "Remove" : "Stop";
    return h_flex()
      .id("dk-confirm")
      .w_full()
      .px(6)
      .py(3)
      .gap(4)
      .items_center()
      .rounded(5)
      .border_1()
      .border_color(t.blocked)
      .bg(t.blocked + "22")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(`${verb} ${container.name}?`))
      .child(this.renderButton("dk-confirm-cancel", "Cancel", t, (_e, cx) => { this.pendingConfirm = null; cx.notify(); }))
      .child(this.renderButton("dk-confirm-ok", verb, t, (_e, cx) => this.performAction(action, container, cx), { tone: t.ansi1 }));
  }

  renderHeader(t, isMini) {
    const totals = totalsOf(this.containers);
    const title = this.loaded ? `Docker (${totals.running}/${this.containers.length})` : "Docker";
    return h_flex()
      .id("dk-header")
      .h(isMini ? 26 : 30)
      .flex_none()
      .px(10)
      .gap(5)
      .items_center()
      .child(
        div()
          .id("dk-toggle")
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .font_medium()
          .text_color(t.muted)
          .cursor_pointer()
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.toggleCollapsed(cx))
          .child(`${title} ${isMini ? "▸" : "▾"}`),
      )
      .when(!isMini, el =>
        el
          .child(this.renderButton("dk-toggle-stopped", this.showStopped ? "All" : "Running", t, (_e, cx) => {
            this.showStopped = !this.showStopped;
            try { localStorage.setItem("docker.showStopped", this.showStopped ? "1" : "0"); } catch {}
            cx.notify();
          }))
          .child(this.renderButton("dk-refresh", this.sampling ? "…" : "↻", t, (_e, cx) => { this.retryAt = 0; this.refresh(cx); })),
      );
  }

  renderMiniSummary(t) {
    const totals = totalsOf(this.containers);
    const text = this.error ? "Docker unavailable" : `CPU ${formatPct(totals.cpu)} · RAM ${formatBytes(totals.mem)}`;
    return h_flex()
      .h(30)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .child(image(DOCKER_ICON).w(16).h(16).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(this.error ? t.blocked : t.foreground).child(text));
  }

  renderRail(t) {
    const totals = totalsOf(this.containers);
    return v_flex()
      .id("dk-rail")
      .size_full()
      .items_center()
      .py(6)
      .gap(3)
      .cursor_pointer()
      .tooltip(`Docker: ${totals.running} running · CPU ${formatPct(totals.cpu)} · RAM ${formatBytes(totals.mem)}`)
      .on_click((_e, cx) => this.toggleCollapsed(cx))
      .child(image(DOCKER_ICON).w(16).h(16).flex_none())
      .child(
        v_flex()
          .w(34)
          .py(3)
          .rounded(6)
          .items_center()
          .gap(2)
          .overflow_hidden()
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .child(div().text_size(8.5).font_semibold().text_color(this.error ? t.blocked : t.foreground).child(this.error ? "C —" : `C ${Math.round(totals.cpu)}%`))
          .child(div().text_size(8.5).font_semibold().text_color(this.error ? t.blocked : t.foreground).child(this.error ? "R —" : `R ${formatBytes(totals.mem)}`)),
      );
  }

  renderListBody(t, visible) {
    if (this.error) return div().px(6).py(6).text_size(10.5).text_color(t.blocked).child(`Docker unavailable: ${this.error}`);
    if (!this.loaded) return div().px(6).py(6).text_size(10.5).text_color(t.dim).child("Loading containers…");
    if (visible.length === 0) return div().px(6).py(6).text_size(10.5).text_color(t.dim).child(this.showStopped ? "No containers." : "No running containers.");
    return v_flex().gap(2).children(groupByProject(visible).map(group => this.renderGroup(group, t)));
  }

  renderList(t) {
    const visible = this.showStopped ? this.containers : this.containers.filter(c => c.running);
    return v_flex()
      .flex_1()
      .min_h(0)
      .when(Boolean(this.actionError), el =>
        el.child(div().id("dk-action-error").flex_none().px(10).py(2).text_size(10).text_color(t.ansi1).cursor_pointer()
          .on_click((_e, cx) => { this.actionError = null; cx.notify(); }).child(this.actionError)),
      )
      .child(v_flex().id("dk-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(4).child(this.renderListBody(t, visible)));
  }

  render() {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;
    const isRail = this.width < RAIL_WIDTH_PX;
    const isMini = !isRail && (this.collapsed || this.blockHeight < MINI_HEIGHT_PX);
    return v_flex()
      .id("docker-monitor-root")
      .relative()
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_size_change((size, cx) => this.onSizeChange(size, cx))
      .on_window_mouse_move((e, cx) => this.onDragMove(e, cx))
      .on_window_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        this.endDrag();
        cx.notify();
      })
      .when(isRail, el => el.child(this.renderRail(t)))
      .when(!isRail, el => el.child(this.renderHeader(t, isMini)))
      .when(isMini, el => el.child(this.renderMiniSummary(t)))
      .when(!isRail && !isMini, el => el.child(this.renderList(t)))
      .child(
        div()
          .id("dk-resize-handle")
          .absolute()
          .top(0)
          .left(0)
          .right(0)
          .h(6)
          .cursor_ns_resize()
          .on_hover((on, cx) => { this.handleHover = on; cx.notify(); })
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.startDrag(e); cx.notify(); })
          .child(div().h(this.drag || this.handleHover ? 2 : 1).w_full().when(Boolean(this.drag || this.handleHover), el => el.bg(t.accent))),
      );
  }
}
