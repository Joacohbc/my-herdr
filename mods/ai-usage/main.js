import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, settings, window, shared, layout, checking, run } from "herdr";
import { STACK, BRAND_PX, findNode, snapshotHeights, pushResize } from "./stack-resize.js";
import { loadConfig, resolveNode, runCollector } from "./node.js";

const OWN_ID = "usage";
const COLLAPSED_PX = 64;
const DEFAULT_EXPANDED = 220;
const EXPANDED_KEY = "usage.expandedPx";
const COLLAPSED_KEY = "usage.collapsed";
const RAIL_WIDTH_PX = 140;
const MINI_HEIGHT_PX = 96;
const TICK_MS = 1_000;
const ACTIVE_POLL_MS = 60_000;
const COLLAPSED_POLL_MS = 5 * 60_000;
const IDLE_EVICT_MS = 30_000;
const UI_REFRESH_TICKS = 30;
const TOP_MODELS_SHOWN = 4;
const USAGE_ICON = "mods/ai-usage/icons/usage.svg";

function isSidebarVisible() {
  if (window()?.visible === false) return false;
  return !findNode(layout(), "sidebar")?.hidden;
}

function formatCount(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatDuration(ms) {
  if (ms <= 0) return "now";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function quotaColor(pct, t) {
  if (pct >= 90) return t.ansi1;
  if (pct >= 70) return t.blocked;
  return t.accent;
}

function hasQuota(quota) {
  return Boolean(quota && !quota.error && !quota.disabled && (quota.fiveHour || quota.sevenDay));
}

export default class AiUsage extends View {
  init(_props, cx) {
    this.data = null;
    this.error = null;
    this.loading = false;
    this.nodePath = null;
    this.lastPollAt = 0;
    this.hiddenSince = 0;
    this.ticks = 0;
    this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
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
    this.data = null;
  }

  tick(cx) {
    const gcSeq = shared("herdr.gc")?.seq ?? 0;
    const forceGc = gcSeq !== this.lastGcSeq;
    this.lastGcSeq = gcSeq;

    const now = Date.now();
    if (!isSidebarVisible()) {
      if (!this.hiddenSince) this.hiddenSince = now;
      if (this.data && (forceGc || now - this.hiddenSince >= IDLE_EVICT_MS)) {
        this.data = null;
        this.lastPollAt = 0;
      }
      return;
    }
    this.hiddenSince = 0;
    const interval = this.collapsed ? COLLAPSED_POLL_MS : ACTIVE_POLL_MS;
    if (!this.lastPollAt || now - this.lastPollAt >= interval) {
      this.refresh(cx);
      return;
    }
    this.ticks = (this.ticks + 1) % UI_REFRESH_TICKS;
    if (this.ticks === 0) cx.notify();
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.lastPollAt = Date.now();
    cx.notify();
    cx.spawn(async cx => {
      try {
        await this.collect();
      } catch (err) {
        this.error = String(err?.message ?? err);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async collect() {
    const config = await loadConfig();
    if (config.error) {
      this.error = config.error;
      return;
    }
    if (!this.nodePath || this.nodeConfig !== config.node) {
      const resolved = await resolveNode(config.node);
      this.nodeConfig = config.node;
      this.nodePath = resolved.path ?? null;
      if (!this.nodePath) {
        this.error = resolved.error;
        return;
      }
    }
    const result = await runCollector(this.nodePath, config);
    if (result.failedToStart) this.nodePath = null;
    this.error = result.error;
    if (result.data) this.data = result.data;
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
      run("layout.resize", { id: OWN_ID, px: Number(localStorage.getItem(EXPANDED_KEY)) || DEFAULT_EXPANDED });
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

  renderMeter(pct, color, t) {
    const clamped = Math.max(0, Math.min(100, pct));
    return div()
      .h(4)
      .w_full()
      .rounded(999)
      .overflow_hidden()
      .bg(t.surface)
      .when(clamped > 0, el => el.child(div().h_full().w(`${Math.max(2, Math.round(clamped))}%`).rounded(999).bg(color)));
  }

  renderQuotaRow(label, quota, t) {
    const color = quotaColor(quota.pct, t);
    const reset = quota.resetsAt ? formatDuration(quota.resetsAt - Date.now()) : "";
    return v_flex()
      .gap(2)
      .child(
        h_flex()
          .items_center()
          .gap(5)
          .text_size(10.5)
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(label))
          .when(Boolean(reset), el => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(`↻ ${reset}`)))
          .child(div().w(34).flex_none().text_right().font_semibold().text_color(color).child(`${Math.round(quota.pct)}%`)),
      )
      .child(this.renderMeter(quota.pct, color, t));
  }

  renderModelRanking(rows, total, countOf, detailOf, t) {
    if (rows.length === 0) return div().text_size(10).text_color(t.dim).child("No usage in 7 days.");
    return v_flex().gap(3).children(rows.slice(0, TOP_MODELS_SHOWN).map((row, index) => {
      const share = total > 0 ? (countOf(row) / total) * 100 : 0;
      const color = index === 0 ? t.accent : t.dim;
      return v_flex()
        .gap(2)
        .child(
          h_flex()
            .items_center()
            .gap(5)
            .text_size(10.5)
            .child(div().flex_1().min_w(0).truncate().text_color(index === 0 ? t.foreground : t.muted).child(row.model))
            .child(div().flex_none().text_size(9.5).text_color(t.dim).child(detailOf(row)))
            .child(div().w(32).flex_none().text_right().text_color(color).child(`${Math.round(share)}%`)),
        )
        .child(this.renderMeter(share, color, t));
    }));
  }

  renderSection(title, subtitle, children, t) {
    return v_flex()
      .flex_none()
      .px(10)
      .py(6)
      .gap(6)
      .child(
        h_flex()
          .items_center()
          .gap(5)
          .child(div().flex_1().text_size(11).font_semibold().text_color(t.foreground).child(title))
          .when(Boolean(subtitle), el => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(subtitle))),
      )
      .children(children.filter(Boolean));
  }

  renderNote(text, color, t) {
    return div().text_size(10).text_color(color ?? t.dim).child(text);
  }

  renderClaude(claude, t) {
    const quota = claude.quota;
    const window5h = claude.window;
    const blockReset = window5h.resetsAt && !hasQuota(quota) ? ` · ↻ ${formatDuration(window5h.resetsAt - Date.now())}` : "";
    const quotaRows = hasQuota(quota)
      ? [
          quota.fiveHour && this.renderQuotaRow("5h session", quota.fiveHour, t),
          quota.sevenDay && this.renderQuotaRow("Weekly", quota.sevenDay, t),
          quota.sevenDayOpus && this.renderQuotaRow("Weekly Opus", quota.sevenDayOpus, t),
          quota.sevenDaySonnet && this.renderQuotaRow("Weekly Sonnet", quota.sevenDaySonnet, t),
        ]
      : [quota?.disabled ? null : this.renderNote(`Quota unavailable: ${quota?.error ?? "not loaded"}`, t.blocked, t)];
    return this.renderSection("Claude Code", quota?.plan ?? "", [
      ...quotaRows,
      this.renderNote(`5h block: ${formatCount(window5h.messages)} msgs · ${formatCount(window5h.tokens)} tok${blockReset}`, null, t),
      this.renderNote(`7 days: ${formatCount(claude.week.messages)} msgs · ${formatCount(claude.week.tokens)} tok`, null, t),
      this.renderModelRanking(claude.models, claude.week.messages, row => row.messages, row => `${formatCount(row.messages)} msgs`, t),
    ], t);
  }

  renderAntigravityQuota(quota, t) {
    if (!quota || quota.disabled) return [];
    if (quota.error) return [this.renderNote(`Quota unavailable: ${quota.error}`, t.blocked, t)];
    return quota.groups.flatMap(group => {
      const groupLabel = group.name.replace(/\s*models?$/i, "").replace(/\s+and\s+/i, "/");
      return group.windows.map(entry => this.renderQuotaRow(`${groupLabel} ${entry.window === "5h" ? "5h" : "weekly"}`, entry, t));
    });
  }

  renderAntigravity(antigravity, t) {
    return this.renderSection("Antigravity", `${antigravity.conversations ?? 0} convs`, [
      ...this.renderAntigravityQuota(antigravity.quota, t),
      this.renderNote(`5h: ${formatCount(antigravity.window.generations)} gens · ${formatCount(antigravity.window.tokens ?? 0)} tok`, null, t),
      this.renderNote(`7 days: ${formatCount(antigravity.week.generations)} gens · ${formatCount(antigravity.week.tokens ?? 0)} tok`, null, t),
      this.renderModelRanking(antigravity.models, antigravity.week.generations, row => row.generations, row => `${formatCount((row.input ?? 0) + (row.output ?? 0))} tok`, t),
    ], t);
  }

  miniSummaryText() {
    const quota = this.data?.claude?.quota;
    const parts = [];
    if (hasQuota(quota)) {
      if (quota.fiveHour) parts.push(`5h ${Math.round(quota.fiveHour.pct)}%`);
      if (quota.sevenDay) parts.push(`wk ${Math.round(quota.sevenDay.pct)}%`);
    } else if (this.data?.claude) {
      parts.push(`5h ${formatCount(this.data.claude.window.messages)} msgs`);
    }
    const gemini5h = this.data?.antigravity?.quota?.groups?.find(group => /gemini/i.test(group.name))?.windows.find(entry => entry.window === "5h");
    if (gemini5h) parts.push(`Gemini 5h ${Math.round(gemini5h.pct)}%`);
    return parts.join(" · ");
  }

  renderHeader(t, isMini) {
    return h_flex()
      .id("usage-header")
      .h(isMini ? 26 : 30)
      .flex_none()
      .px(10)
      .gap(5)
      .items_center()
      .child(
        div()
          .id("usage-toggle")
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .font_medium()
          .text_color(t.muted)
          .cursor_pointer()
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.toggleCollapsed(cx))
          .child(`AI Usage ${isMini ? "▸" : "▾"}`),
      )
      .when(!isMini, el =>
        el.child(
          div()
            .id("usage-refresh")
            .px(5)
            .h(19)
            .flex()
            .items_center()
            .rounded(4)
            .text_size(10)
            .font_semibold()
            .text_color(t.muted)
            .cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.nodePath = null; this.refresh(cx); })
            .child(this.loading ? "…" : "↻"),
        ),
      );
  }

  renderMiniSummary(t) {
    const text = this.data ? this.miniSummaryText() : this.error ?? "Collecting usage…";
    return h_flex()
      .h(30)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .child(svg(USAGE_ICON).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(this.data ? t.foreground : this.error ? t.blocked : t.dim).child(text));
  }

  renderRail(t) {
    const fiveHour = this.data?.claude?.quota?.fiveHour;
    return v_flex()
      .id("usage-rail")
      .size_full()
      .items_center()
      .py(6)
      .gap(3)
      .cursor_pointer()
      .tooltip(this.data ? this.miniSummaryText() : "AI Usage")
      .on_click((_e, cx) => this.toggleCollapsed(cx))
      .child(svg(USAGE_ICON).size(15).text_color(t.muted))
      .when(Boolean(fiveHour), el => el.child(div().text_size(9.5).text_color(quotaColor(fiveHour.pct, t)).child(`${Math.round(fiveHour.pct)}%`)));
  }

  renderBody(t) {
    if (!this.data) {
      const text = this.error ? `Usage unavailable: ${this.error}` : "Collecting usage…";
      return div().px(10).py(6).text_size(10.5).text_color(this.error ? t.blocked : t.dim).child(text);
    }
    return v_flex()
      .when(Boolean(this.error), el => el.child(div().px(10).py(2).text_size(10).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.data.claude), el => el.child(this.renderClaude(this.data.claude, t)))
      .when(Boolean(this.data.antigravity), el => el.child(this.renderAntigravity(this.data.antigravity, t)));
  }

  render() {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;
    const isRail = this.width < RAIL_WIDTH_PX;
    const isMini = !isRail && (this.collapsed || this.blockHeight < MINI_HEIGHT_PX);
    return v_flex()
      .id("ai-usage-root")
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
      .when(!isRail && !isMini, el => el.child(v_flex().id("usage-scroll").flex_1().min_h(0).overflow_y_scrollbar().pb(6).child(this.renderBody(t))))
      .child(
        div()
          .id("usage-resize-handle")
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
