// Unified pane header: zoom controls, file-viewer toggles (Preview/Raw, Wrap), pane zoom, split, and close.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, settings, shared, setShared, spaces, focused, nextCommand, checking } from "herdr";

function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function sendViewerCmd(pane, action) {
  const prev = shared("file-viewer.cmd")?.seq ?? 0;
  setShared("file-viewer.cmd", { pane, action, seq: prev + 1 });
}

function snapshotPane(p) {
  if (p.mod === "file-viewer") {
    const meta = shared("file-viewer.meta")?.[p.pane];
    if (meta?.file && meta?.root) {
      return { kind: "file-viewer", file: meta.file, root: meta.root, on: meta.on ?? null, line: meta.line ?? null, name: p.name };
    }
  }
  return { kind: "terminal", cwd: p.cwd || null, name: p.name || null };
}

const MAX_CLOSED_HISTORY = 8;

function pushBoundedHistory(key, entry) {
  const prev = shared(key) ?? [];
  const last = prev[prev.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(entry)) return;
  setShared(key, [...prev, entry].slice(-MAX_CLOSED_HISTORY));
}

function pruneOrphanViewerMeta() {
  const meta = shared("file-viewer.meta");
  if (!meta || typeof meta !== "object") return;
  const activeIds = new Set(panes().filter(p => p.mod === "file-viewer").map(p => p.pane));
  let changed = false;
  const next = {};
  for (const [id, val] of Object.entries(meta)) {
    if (activeIds.has(id)) next[id] = val;
    else changed = true;
  }
  if (changed) setShared("file-viewer.meta", next);
}

function closeFocusedPane() {
  const f = focused();
  const p = f?.pane ? panes().find(x => x.pane === f.pane) : null;
  if (!p) return;
  pushBoundedHistory("tiling.closedPanes", snapshotPane(p));
  run("pane.close", { pane: p.pane });
  pruneOrphanViewerMeta();
}

function reopenClosedPane() {
  const stack = [...(shared("tiling.closedPanes") ?? [])];
  const entry = stack.pop();
  if (!entry) return;
  setShared("tiling.closedPanes", stack);
  if (entry.kind === "file-viewer") {
    const res = run("pane.split", {
      direction: "right",
      mod: "file-viewer",
      props: { file: entry.file, root: entry.root, on: entry.on, tab: focused()?.tab ?? null, line: entry.line },
    });
    if (res?.pane && entry.name) run("pane.rename", { pane: res.pane, name: entry.name });
    return;
  }
  run("terminal.open", {
    place: "right",
    ...(entry.cwd ? { folder: entry.cwd } : {}),
    ...(entry.name ? { name: entry.name } : {}),
  });
}

function closeFocusedTab() {
  const space = spaces().find(s => s.active);
  const tab = space?.tabs?.find(t => t.active);
  if (!tab) return;
  const tabPanes = panes().filter(p => p.tab === tab.id).slice(0, 4).map(snapshotPane);
  pushBoundedHistory("tiling.closedTabs", { name: tab.name, panes: tabPanes });
  run("tab.close", { id: tab.id });
  pruneOrphanViewerMeta();
}

function reopenClosedTab() {
  const stack = [...(shared("tiling.closedTabs") ?? [])];
  const entry = stack.pop();
  if (!entry) return;
  setShared("tiling.closedTabs", stack);
  const first = entry.panes?.[0];
  if (first?.kind === "file-viewer") {
    run("tab.new", {
      name: entry.name || first.name || first.file,
      mod: "file-viewer",
      props: { file: first.file, root: first.root, on: first.on, tab: null, line: first.line, solo: true },
    });
    return;
  }
  run("tab.new", {
    ...(entry.name ? { name: entry.name } : {}),
    ...(first?.cwd ? { folder: first.cwd } : {}),
  });
}

export default class PaneCustom extends View {
  init(_props, cx) {
    this.hovered = false;
    if (checking()) return;
    cx.spawn(async () => {
      for (;;) {
        const cmd = await nextCommand();
        if (!this.me()?.focused) continue;
        if (cmd === "close_pane") closeFocusedPane();
        else if (cmd === "reopen_pane") reopenClosedPane();
        else if (cmd === "close_tab") closeFocusedTab();
        else if (cmd === "reopen_tab") reopenClosedTab();
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, iconName, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-custom/${iconName}.svg`).size(14));
  }

  pill(t, id, label, active, onClick) {
    return div()
      .id(id)
      .px(5)
      .py(1)
      .rounded(4)
      .text_size(11)
      .cursor_pointer()
      .when(active, el => el.bg(t.selected))
      .text_color(active ? t.accent : t.dim)
      .hover((s) => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(e, cx);
      })
      .child(label);
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const pane = p.pane;
    const isViewer = p.mod === "file-viewer";
    const meta = isViewer ? (shared("file-viewer.meta")?.[pane] ?? null) : null;
    const baseName = p.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const name = isViewer && meta?.dirty ? `* ${baseName}` : baseName;
    const subtitle = isViewer
      ? (meta?.file ? (meta.line ? `${meta.file}:${meta.line}` : meta.file) : "")
      : folder(p.cwd);
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const bottom = paneFrame(layout())?.header?.position === "bottom";

    const zoomPct = isViewer
      ? (meta?.zoomPct ?? 100)
      : Math.round((settings().zoom ?? 1) * 100);

    const onZoomOut = () => isViewer ? sendViewerCmd(pane, "zoom_out") : run("app.zoom_out");
    const onZoomReset = () => isViewer ? sendViewerCmd(pane, "zoom_reset") : run("app.zoom_reset");
    const onZoomIn = () => isViewer ? sendViewerCmd(pane, "zoom_in") : run("app.zoom_in");

    const fontFamily = settings().font_family ?? settings().font;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(5)
      .items_center()
      .bg(t.background)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        if (!e.modifiers?.control && !e.modifiers?.platform) return;
        const dy = e.delta?.y ?? 0;
        if (dy === 0) return;
        cx.stop_propagation();
        if (dy > 0) onZoomIn();
        else onZoomOut();
      })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(220).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(subtitle))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(isViewer && Boolean(meta?.hasPreview ?? meta?.md), el => el
        .child(this.pill(t, `ph-md-${pane}`, meta.preview ? "Preview" : "Raw", Boolean(meta.preview), () => sendViewerCmd(pane, "toggle_preview"))))
      .when(isViewer && !meta?.preview, el => el
        .child(this.pill(t, `ph-wrap-${pane}`, "Wrap", Boolean(meta?.wrap), () => sendViewerCmd(pane, "toggle_wrap"))))
      .when(this.hovered || p.focused || isViewer, el => el
        .child(this.pill(t, `ph-zo-${pane}`, "−", false, onZoomOut))
        .child(this.pill(t, `ph-zr-${pane}`, `${zoomPct}%`, zoomPct !== 100, onZoomReset))
        .child(this.pill(t, `ph-zi-${pane}`, "+", false, onZoomIn)))
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .opacity(this.hovered || p.zoomed ? 1 : 0.4)
          .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
          .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
          .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
          .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })),
      );
  }
}
