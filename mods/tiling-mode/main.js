// Tiling Manager & Resize Mode HUD overlay (opened via leader key, e.g. Ctrl+Space).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme, props, closeOverlay, checking } from "herdr";

const STEP_NORMAL = 40;
const STEP_FINE = 16;
const STEP_LARGE = 90;

const DIR_KEYS = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  h: "left",
  l: "right",
  k: "up",
  j: "down",
};

const DIR_ARROWS = { left: "←", right: "→", up: "↑", down: "↓" };

export default class TilingMode extends View {
  init(_props, cx) {
    this.mode = "tiling";
    this.lastAction = "Ready";
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  act(label, command, args, cx, closeAfter = false) {
    run(command, args);
    this.lastAction = label;
    if (closeAfter) {
      this.dismiss();
      return;
    }
    cx.notify();
  }

  handleKey(e, cx) {
    const rawKey = e.key ?? "";
    const k = rawKey.toLowerCase();
    const ctrl = Boolean(e.modifiers?.control);
    const shift = Boolean(e.modifiers?.shift);

    if (k === "escape" || k === "enter" || (k === "space" && ctrl)) {
      cx.stop_propagation();
      this.dismiss();
      return;
    }

    if (k === "r" && !ctrl) {
      cx.stop_propagation();
      this.mode = this.mode === "resize" ? "tiling" : "resize";
      this.lastAction = this.mode === "resize" ? "Resize mode" : "Tiling mode";
      cx.notify();
      return;
    }

    const dir = DIR_KEYS[k];
    if (dir) {
      cx.stop_propagation();
      const arrow = DIR_ARROWS[dir];

      if (this.mode === "resize") {
        const px = ctrl ? STEP_LARGE : shift ? STEP_FINE : STEP_NORMAL;
        this.act(`Resize ${arrow} ${px}px`, "pane.resize", { direction: dir, px }, cx);
        return;
      }

      if (ctrl) {
        const px = shift ? STEP_FINE : STEP_NORMAL;
        this.act(`Resize ${arrow} ${px}px`, "pane.resize", { direction: dir, px }, cx);
        return;
      }

      if (shift) {
        this.act(`Swap ${arrow}`, "pane.swap", { direction: dir }, cx);
        return;
      }

      this.act(`Focus ${arrow}`, "pane.go", { direction: dir }, cx);
      return;
    }

    if (k === "v" || rawKey === "|") {
      cx.stop_propagation();
      this.act("Split right", "pane.split", { direction: "right" }, cx, true);
      return;
    }

    if (k === "s" || rawKey === "-") {
      cx.stop_propagation();
      this.act("Split down", "pane.split", { direction: "down" }, cx, true);
      return;
    }

    if (k === "z" || k === "f") {
      cx.stop_propagation();
      this.act("Toggle zoom", "pane.zoom", {}, cx, true);
      return;
    }

    if (k === "q" || k === "x") {
      cx.stop_propagation();
      if (shift) this.act("Reopen pane", "pane-custom.reopen_pane", {}, cx, true);
      else this.act("Close pane", "pane-custom.close_pane", {}, cx, true);
      return;
    }

    if (k === "w") {
      cx.stop_propagation();
      if (shift) this.act("Reopen tab", "pane-custom.reopen_tab", {}, cx, true);
      else this.act("Close tab", "pane-custom.close_tab", {}, cx, true);
      return;
    }

    if (k === "n") {
      cx.stop_propagation();
      this.act("New tab", "tab.new", {}, cx, true);
      return;
    }

    if (rawKey === "[" && !shift) {
      cx.stop_propagation();
      this.act("Prev tab", "tab.prev", {}, cx);
      return;
    }

    if (rawKey === "]" && !shift) {
      cx.stop_propagation();
      this.act("Next tab", "tab.next", {}, cx);
      return;
    }

    if (rawKey === "{" || (rawKey === "[" && shift)) {
      cx.stop_propagation();
      this.act("Move tab ←", "tab.move", { by: -1 }, cx);
      return;
    }

    if (rawKey === "}" || (rawKey === "]" && shift)) {
      cx.stop_propagation();
      this.act("Move tab →", "tab.move", { by: 1 }, cx);
      return;
    }
  }

  hint(t, keys, label, onClick, id) {
    return h_flex()
      .id(id)
      .px(7)
      .py(4)
      .gap(6)
      .items_center()
      .rounded(6)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .cursor_pointer()
      .hover(s => s.bg(t.hover).border_color(t.accent))
      .on_click(onClick)
      .child(
        div()
          .px(5)
          .py(1)
          .rounded(4)
          .bg(t.background)
          .text_size(11)
          .font_semibold()
          .text_color(t.accent)
          .child(keys),
      )
      .child(div().text_size(11.5).text_color(t.foreground).child(label));
  }

  render(cx) {
    const t = theme();
    const isResize = this.mode === "resize";
    const badgeColor = isResize ? t.blocked : t.accent;

    return v_flex()
      .id("tiling-mode")
      .track_focus(this.handle)
      .w(520)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => this.handleKey(e, cx))
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(
            div()
              .px(7)
              .py(2)
              .rounded(5)
              .bg(badgeColor + "26")
              .border_1()
              .border_color(badgeColor)
              .text_size(11)
              .font_bold()
              .text_color(badgeColor)
              .child(isResize ? "RESIZE MODE" : "TILING MODE"),
          )
          .child(div().flex_1().text_size(12).text_color(t.muted).child(this.lastAction))
          .child(
            div()
              .id("tm-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.dismiss())
              .child("Esc"),
          ),
      )
      .when(!isResize, el =>
        el
          .child(
            h_flex()
              .gap(6)
              .child(this.hint(t, "← ↑ ↓ →", "Focus", (_e, cx) => this.act("Focus →", "pane.go", { direction: "right" }, cx), "tm-go"))
              .child(this.hint(t, "Shift+Arrows", "Swap pane", (_e, cx) => this.act("Swap →", "pane.swap", { direction: "right" }, cx), "tm-swap"))
              .child(this.hint(t, "Ctrl+Arrows", "Resize", (_e, cx) => this.act("Resize →", "pane.resize", { direction: "right", px: STEP_NORMAL }, cx), "tm-res")),
          )
          .child(
            h_flex()
              .gap(6)
              .child(this.hint(t, "r", "Resize mode", (_e, cx) => { this.mode = "resize"; this.lastAction = "Resize mode"; cx.notify(); }, "tm-rmode"))
              .child(this.hint(t, "v / s", "Split R/D", (_e, cx) => this.act("Split right", "pane.split", { direction: "right" }, cx, true), "tm-split"))
              .child(this.hint(t, "z", "Zoom", (_e, cx) => this.act("Toggle zoom", "pane.zoom", {}, cx, true), "tm-zoom"))
              .child(this.hint(t, "q / Q", "Close / Reopen pane", (_e, cx) => this.act("Close pane", "pane-custom.close_pane", {}, cx, true), "tm-close")),
          )
          .child(
            h_flex()
              .gap(6)
              .child(this.hint(t, "w / W", "Close / Reopen tab", (_e, cx) => this.act("Close tab", "pane-custom.close_tab", {}, cx, true), "tm-wtab"))
              .child(this.hint(t, "[ / ]", "Prev / Next tab", (_e, cx) => this.act("Next tab", "tab.next", {}, cx), "tm-tab"))
              .child(this.hint(t, "{ / }", "Move tab", (_e, cx) => this.act("Move tab →", "tab.move", { by: 1 }, cx), "tm-mtab"))
              .child(this.hint(t, "n", "New tab", (_e, cx) => this.act("New tab", "tab.new", {}, cx, true), "tm-ntab")),
          ),
      )
      .when(isResize, el =>
        el
          .child(
            h_flex()
              .gap(6)
              .child(this.hint(t, "← ↑ ↓ →", `Resize ±${STEP_NORMAL}px`, (_e, cx) => this.act(`Resize → ${STEP_NORMAL}px`, "pane.resize", { direction: "right", px: STEP_NORMAL }, cx), "tm-r-norm"))
              .child(this.hint(t, "Shift+Arrows", `Fine ±${STEP_FINE}px`, (_e, cx) => this.act(`Resize → ${STEP_FINE}px`, "pane.resize", { direction: "right", px: STEP_FINE }, cx), "tm-r-fine"))
              .child(this.hint(t, "Ctrl+Arrows", `Large ±${STEP_LARGE}px`, (_e, cx) => this.act(`Resize → ${STEP_LARGE}px`, "pane.resize", { direction: "right", px: STEP_LARGE }, cx), "tm-r-big")),
          )
          .child(
            h_flex()
              .gap(6)
              .child(this.hint(t, "r", "Back to Tiling", (_e, cx) => { this.mode = "tiling"; this.lastAction = "Tiling mode"; cx.notify(); }, "tm-back"))
              .child(this.hint(t, "Esc", "Done", () => this.dismiss(), "tm-done")),
          ),
      );
  }
}
