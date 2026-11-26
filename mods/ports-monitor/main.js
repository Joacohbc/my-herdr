import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme,
  settings,
  window,
  shared,
  setShared,
  openOverlay,
  run,
  layout,
  checking,
} from "herdr";
import { STACK, BRAND_PX, snapshotHeights, pushResize, fitStackToViewport } from "./stack-resize.js";

const OWN_ID = "ports-monitor";
const COLLAPSED_PX = 64;
const DEFAULT_EXPANDED = 160;
const EXPANDED_KEY = "ports.expandedPx";
import {
  buildSharedHttpList,
  MAX_PROBE_CACHE,
  probeHttpProtocol,
  serviceIconSpec,
  sampleListeningPorts,
} from "./detector.js";

const ACTIVE_POLL_MS = 1_500;
const UNFOCUSED_POLL_MS = 5_000;
const RAIL_WIDTH_PX = 140;

const PROTO_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "HTTP", label: "HTTP" },
  { id: "DB", label: "DB" },
  { id: "TCP", label: "TCP" },
  { id: "UDP", label: "UDP" },
];

function protoColor(entry, t) {
  if (entry.system) return t.dim;
  if (entry.proto === "HTTPS") return t.ansi2;
  if (entry.proto === "HTTP") return t.accent;
  if (entry.proto === "DB") return t.ansi4;
  if (entry.proto === "MQ") return t.ansi5;
  if (entry.proto === "UDP" || entry.proto === "DNS") return t.ansi3;
  return t.muted;
}

function exposureColor(scope, t) {
  if (scope === "public") return t.blocked;
  if (scope === "vpn") return t.ansi6;
  return t.dim;
}

function renderPortIcon(entry, size, color) {
  const spec = serviceIconSpec(entry);
  if (spec.tint) return svg(spec.path).size(size).flex_none().text_color(color);
  return image(spec.path).w(size).h(size).flex_none();
}

export default class PortsMonitor extends View {
  init(_props, cx) {
    this.ports = [];
    this.filter = localStorage.getItem("ports.filter") || "HTTP";
    this.showSystem = localStorage.getItem("ports.showSys") === "1";
    this.collapsed = localStorage.getItem("ports.collapsed") === "1";
    this.width = 268;
    this.blockHeight = 200;
    this.sampling = false;
    this.lastPollAt = 0;
    this.lastSignature = "";
    this.lastSharedHttpSig = "";
    this.copiedKey = null;
    this.probeCache = new Map();
    this.probingKeys = new Set();
    this.lastGcSeq = shared("herdr.gc")?.seq ?? 0;
    this.drag = null;
    this.handleHover = false;
    this.initAt = Date.now();

    if (checking()) return;

    if (this.collapsed) {
      run("layout.resize", { id: "ports-monitor", px: 64 });
      this.refresh(cx, true);
    } else {
      this.refresh(cx);
    }

    cx.timer.every(ACTIVE_POLL_MS, cx => {
      const gcSeq = shared("herdr.gc")?.seq ?? 0;
      if (gcSeq !== this.lastGcSeq) {
        this.lastGcSeq = gcSeq;
        this.probeCache.clear();
      }
      if (this.collapsed) return;
      const w = window();
      if (w?.visible === false) return;
      const now = Date.now();
      const interval = w?.active === false ? UNFOCUSED_POLL_MS : ACTIVE_POLL_MS;
      if (now - this.lastPollAt >= interval - 100) {
        this.refresh(cx);
      }
    });
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

  toggleCollapsed(cx) {
    this.collapsed = !this.collapsed;
    try { localStorage.setItem("ports.collapsed", this.collapsed ? "1" : "0"); } catch {}
    if (this.collapsed) {
      if (this.blockHeight > COLLAPSED_PX + 24) {
        try { localStorage.setItem(EXPANDED_KEY, String(Math.round(this.blockHeight))); } catch {}
      }
      this.probeCache.clear();
      run("layout.resize", { id: OWN_ID, px: COLLAPSED_PX });
    } else {
      const px = Number(localStorage.getItem(EXPANDED_KEY)) || DEFAULT_EXPANDED;
      fitStackToViewport(OWN_ID, px);
      this.refresh(cx);
    }
    cx.notify();
  }

  publishHttpPorts(entries) {
    const httpList = buildSharedHttpList(entries);
    const sig = JSON.stringify(httpList);
    if (sig === this.lastSharedHttpSig) return;
    this.lastSharedHttpSig = sig;
    setShared("ports.http", httpList);
  }

  applyCachedProbes(entries) {
    for (const e of entries) {
      const cacheKey = `${e.port}:${e.pid ?? "x"}`;
      const cached = this.probeCache.get(cacheKey);
      if (cached) {
        e.proto = cached;
        e.needsProbe = false;
        e.url = cached === "HTTP" || cached === "HTTPS"
          ? `${cached.toLowerCase()}://${e.exposure.connectHost}:${e.port}`
          : null;
      }
    }
  }

  scheduleProbes(entries, cx) {
    const toProbe = entries.filter(e => e.needsProbe).slice(0, 6);
    for (const entry of toProbe) {
      const cacheKey = `${entry.port}:${entry.pid ?? "x"}`;
      if (this.probeCache.has(cacheKey) || this.probingKeys.has(cacheKey)) continue;
      this.probingKeys.add(cacheKey);
      cx.spawn(async cx => {
        try {
          const detected = await probeHttpProtocol(entry);
          if (this.probeCache.size >= MAX_PROBE_CACHE) {
            const firstKey = this.probeCache.keys().next().value;
            if (firstKey !== undefined) this.probeCache.delete(firstKey);
          }
          this.probeCache.set(cacheKey, detected);
          if (!this.collapsed && detected !== entry.proto) {
            this.applyCachedProbes(this.ports);
            this.publishHttpPorts(this.ports);
            cx.notify();
          }
        } finally {
          this.probingKeys.delete(cacheKey);
        }
      });
    }
  }

  refresh(cx, forceOnce = false) {
    if (this.sampling || (this.collapsed && !forceOnce)) return;
    this.sampling = true;
    this.lastPollAt = Date.now();
    cx.spawn(async cx => {
      try {
        const list = await sampleListeningPorts();
        this.applyCachedProbes(list);
        this.publishHttpPorts(list);

        const sig = list.map(e => `${e.key}|${e.proto}|${e.process}|${e.system}`).join("\n");
        if (sig !== this.lastSignature) {
          this.lastSignature = sig;
          this.ports = list;
          cx.notify();
        }
        this.scheduleProbes(list, cx);
      } catch {
        // Ignore transient ss failures
      } finally {
        this.sampling = false;
      }
    });
  }

  filteredPorts() {
    return this.ports.filter(e => {
      if (e.system && !this.showSystem) return false;
      if (this.filter === "ALL") return true;
      if (this.filter === "HTTP") return e.proto === "HTTP" || e.proto === "HTTPS";
      if (this.filter === "DB") return e.proto === "DB" || e.proto === "MQ";
      if (this.filter === "TCP") return e.transport === "tcp";
      if (this.filter === "UDP") return e.transport === "udp";
      return true;
    });
  }

  handleRowClick(entry, cx) {
    if (entry.url) {
      openOverlay({
        mod: "web-launcher",
        kind: "dialog",
        width: 420,
        height: 410,
        props: { url: entry.url },
      });
      return;
    }
    cx.write_to_clipboard(`${entry.exposure.connectHost}:${entry.port}`);
    this.copiedKey = entry.key;
    cx.notify();
    cx.spawn(async cx => {
      await cx.sleep(1100);
      if (this.copiedKey === entry.key) {
        this.copiedKey = null;
        cx.notify();
      }
    });
  }

  renderRail(t, visible) {
    const topPorts = visible.slice(0, 12);
    return v_flex()
      .id("pm-rail")
      .size_full()
      .items_center()
      .py(6)
      .gap(4)
      .overflow_y_scrollbar()
      .child(
        div()
          .id("pm-rail-head")
          .px(4)
          .py(2)
          .rounded(4)
          .text_size(9.5)
          .font_semibold()
          .text_color(t.muted)
          .cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.toggleCollapsed(cx))
          .child("N/A"),
      )
      .when(!this.collapsed, el =>
        el.children(
          topPorts.map(entry =>
            v_flex()
              .id(`pm-rail-${entry.key}`)
              .w(34)
              .py(3)
              .gap(1)
              .items_center()
              .rounded(5)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).border_color(t.accent))
              .tooltip(`${entry.proto} :${entry.port} (${entry.exposure.label}) — ${entry.service}`)
              .on_click((_e, cx) => this.handleRowClick(entry, cx))
              .child(renderPortIcon(entry, 15, protoColor(entry, t)))
              .child(div().text_size(8.5).text_color(t.foreground).child(String(entry.port))),
          ),
        ),
      );
  }

  render(cx) {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;
    const visible = this.filteredPorts();
    const sysCount = this.ports.filter(p => p.system).length;
    const appCount = this.ports.length - sysCount;
    const isRail = this.width < RAIL_WIDTH_PX;
    const isMini = !isRail && (this.collapsed || this.blockHeight < 96);
    const activeFilterLabel = PROTO_FILTERS.find(f => f.id === this.filter)?.label ?? "All";

    return v_flex()
      .id("ports-monitor-root")
      .relative()
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_size_change((size, cx) => {
        let changed = false;
        if (Math.abs(size.width - this.width) >= 10 || Math.abs(size.height - this.blockHeight) >= 6) {
          this.width = size.width;
          this.blockHeight = size.height;
          changed = true;
        }
        if (this.collapsed && Date.now() - this.initAt > 1500 && size.height >= COLLAPSED_PX + 30) {
          this.collapsed = false;
          try { localStorage.setItem("ports.collapsed", "0"); } catch {}
          this.refresh(cx);
          changed = true;
        }
        if (changed) cx.notify();
      })
      .on_window_mouse_move((e, cx) => {
        if (!this.drag) return;
        if (e.pressed_button !== "left") { this.endDrag(); cx.notify(); return; }
        const z = settings().zoom || 1;
        const dy = ((e.position?.y ?? 0) - this.drag.startY) / z;
        const next = pushResize({ heights: this.drag.heights, spacesH: this.drag.spacesH, targetId: OWN_ID, dy });
        for (const id of STACK) if (next[id] !== this.drag.last[id]) run("layout.resize", { id, px: next[id] });
        this.drag.last = next;
      })
      .on_window_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        this.endDrag();
        cx.notify();
      })
      .when(isRail, el => el.child(this.renderRail(t, visible)))
      .when(!isRail, el =>
        el
          .child(
            h_flex()
              .id("pm-header")
              .h(isMini ? 26 : 30)
              .flex_none()
              .px(10)
              .gap(5)
              .items_center()
              .child(
                div()
                  .id("pm-toggle")
                  .flex_1()
                  .min_w(0)
                  .text_size(11.5)
                  .font_medium()
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover(s => s.text_color(t.foreground))
                  .on_click((_e, cx) => this.toggleCollapsed(cx))
                  .child(isMini ? `Ports ${activeFilterLabel} (${visible.length}) ▸` : `Ports (${appCount}) ▾`),
              )
              .when(!isMini, h =>
                h.child(
                  div()
                    .id("pm-sys-toggle")
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .text_size(10)
                    .font_semibold()
                    .cursor_pointer()
                    .when(this.showSystem, s => s.bg(t.selected))
                    .text_color(this.showSystem ? t.accent : t.dim)
                    .hover(s => s.bg(this.showSystem ? t.selected : t.hover).text_color(this.showSystem ? t.accent : t.foreground))
                    .on_click((_e, cx) => {
                      this.showSystem = !this.showSystem;
                      try { localStorage.setItem("ports.showSys", this.showSystem ? "1" : "0"); } catch {}
                      cx.notify();
                    })
                    .child(`Sys ${sysCount}`),
                ),
              ),
          )
          .when(isMini, mini =>
            mini.child(
              h_flex()
                .id("pm-mini-ports")
                .h(32)
                .flex_none()
                .px(8)
                .gap(5)
                .items_center()
                .overflow_x_scrollbar()
                .when(visible.length === 0, empty =>
                  empty.child(div().text_size(10.5).text_color(t.dim).child(`No ${activeFilterLabel} ports`)),
                )
                .children(
                  visible.map(entry => {
                    const pColor = protoColor(entry, t);
                    return h_flex()
                      .id(`pm-mini-${entry.key}`)
                      .h(24)
                      .flex_none()
                      .px(6)
                      .gap(4)
                      .items_center()
                      .rounded(5)
                      .bg(t.surface)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover(s => s.bg(t.hover).border_color(t.accent))
                      .tooltip(
                        entry.url
                          ? `${entry.url} (${entry.exposure.label}) · ${entry.service}`
                          : `${entry.proto} ${entry.addr}:${entry.port} · ${entry.service}`,
                      )
                      .on_click((_e, cx) => this.handleRowClick(entry, cx))
                      .child(renderPortIcon(entry, 14, pColor))
                      .child(div().text_size(11).font_semibold().text_color(t.foreground).child(`:${entry.port}`));
                  }),
                ),
            ),
          )
          .when(!isMini, body =>
            body
              .child(
                h_flex()
                  .id("pm-filters")
                  .h(24)
                  .flex_none()
                  .px(8)
                  .gap(3)
                  .items_center()
                  .overflow_x_scrollbar()
                  .children(
                    PROTO_FILTERS.map(f => {
                      const active = this.filter === f.id;
                      return div()
                        .id(`pm-flt-${f.id}`)
                        .px(6)
                        .h(19)
                        .flex_none()
                        .flex()
                        .items_center()
                        .rounded(4)
                        .text_size(10)
                        .font_semibold()
                        .cursor_pointer()
                        .when(active, s => s.bg(t.selected))
                        .text_color(active ? t.accent : t.dim)
                        .hover(s => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
                        .on_click((_e, cx) => {
                          this.filter = f.id;
                          try { localStorage.setItem("ports.filter", f.id); } catch {}
                          cx.notify();
                        })
                        .child(f.label);
                    }),
                  ),
              )
              .child(
                v_flex()
                  .id("pm-list")
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .px(6)
                  .py(4)
                  .gap(2)
                  .when(visible.length === 0, empty =>
                    empty.child(
                      div()
                        .px(6)
                        .py(8)
                        .text_size(11)
                        .text_color(t.dim)
                        .child("No listening ports for this filter."),
                    ),
                  )
                  .children(
                    visible.map(entry => {
                      const isHttp = Boolean(entry.url);
                      const pColor = protoColor(entry, t);
                      const expColor = exposureColor(entry.exposure.scope, t);
                      const copied = this.copiedKey === entry.key;
                      return h_flex()
                        .id(`pm-row-${entry.key}`)
                        .h(26)
                        .flex_none()
                        .px(6)
                        .gap(6)
                        .items_center()
                        .rounded(5)
                        .cursor_pointer()
                        .when(entry.system, r => r.opacity(0.65))
                        .hover(s => s.bg(t.hover))
                        .tooltip(
                          isHttp
                            ? `${entry.url} (${entry.exposure.label})\n${entry.service}${entry.process ? ` · ${entry.process}` : ""}\nClick to open in Web Launcher`
                            : `${entry.proto} ${entry.addr}:${entry.port}\n${entry.service}${entry.process ? ` · ${entry.process}` : ""}\nClick to copy host:port`,
                        )
                        .on_click((_e, cx) => this.handleRowClick(entry, cx))
                        .child(renderPortIcon(entry, 15, pColor))
                        .child(
                          div()
                            .flex_none()
                            .text_size(11.5)
                            .font_semibold()
                            .text_color(isHttp ? t.foreground : t.muted)
                            .child(`:${entry.port}`),
                        )
                        .child(
                          div()
                            .flex_1()
                            .min_w(0)
                            .truncate()
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(copied ? "Copied" : (entry.service || entry.process)),
                        )
                        .child(
                          div()
                            .flex_none()
                            .px(4)
                            .py(1)
                            .rounded(4)
                            .bg(pColor + "20")
                            .text_size(9)
                            .font_semibold()
                            .text_color(pColor)
                            .child(entry.proto),
                        )
                        .child(
                          div()
                            .flex_none()
                            .px(4)
                            .py(1)
                            .rounded(4)
                            .bg(entry.exposure.scope === "public" ? t.blocked + "24" : t.surface)
                            .text_size(9.5)
                            .text_color(expColor)
                            .child(entry.exposure.label),
                        );
                    }),
                  ),
              ),
          ),
      )
      .child(
        div()
          .id("pm-resize-handle")
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
