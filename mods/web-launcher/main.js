import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import {
  props,
  theme,
  settings,
  shared,
  setShared,
  closeOverlay,
  exec,
  home,
  readTextFile,
  checking,
} from "herdr";

const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;
const HOST_PORT_RE = /^[a-z0-9.-]+:\d+(\/|$)/i;
const CLIPBOARD_URL_RE = /^(https?:\/\/[^\s]+|(?:localhost|127\.\d+\.\d+\.\d+)(?::\d+)?(?:\/[^\s]*)?)$/i;

function normalizeUrl(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    const scheme = LOCAL_HOST_RE.test(candidate) || HOST_PORT_RE.test(candidate)
      ? "http://"
      : "https://";
    candidate = scheme + candidate;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function listChromeProfiles() {
  const base = [{ id: "clean", name: "Clean", email: "Sesión temporal sin cookies" }];
  try {
    const raw = await readTextFile(`${home()}/.config/google-chrome/Local State`);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    const cache = parsed?.profile?.info_cache;
    if (!cache || typeof cache !== "object") return base;

    const entries = Object.entries(cache)
      .map(([id, meta]) => ({
        id,
        name: String(meta?.name || id),
        email: String(meta?.user_name || meta?.gaia_name || ""),
      }))
      .sort((a, b) => (a.id === "Default" ? -1 : b.id === "Default" ? 1 : a.name.localeCompare(b.name)));

    return [...base, ...entries];
  } catch {
    return base;
  }
}

async function launchChrome(url, profileId, asApp) {
  if (profileId === "clean") {
    const cleanDir = `/tmp/herdr-web-clean-${Date.now().toString(36)}`;
    if (asApp && url) {
      await exec(
        "sh",
        ["-c", 'mkdir -p "$1" && nohup google-chrome --user-data-dir="$1" --no-first-run --no-default-browser-check --app="$2" </dev/null >/dev/null 2>&1 &', "_", cleanDir, url],
        { timeout: 3000 },
      );
      return;
    }
    const args = url
      ? ["-c", 'mkdir -p "$1" && nohup google-chrome --user-data-dir="$1" --no-first-run --no-default-browser-check "$2" </dev/null >/dev/null 2>&1 &', "_", cleanDir, url]
      : ["-c", 'mkdir -p "$1" && nohup google-chrome --user-data-dir="$1" --no-first-run --no-default-browser-check </dev/null >/dev/null 2>&1 &', "_", cleanDir];
    await exec("sh", args, { timeout: 3000 });
    return;
  }

  if (asApp && url) {
    await exec(
      "sh",
      ["-c", 'nohup google-chrome --profile-directory="$1" --app="$2" </dev/null >/dev/null 2>&1 &', "_", profileId, url],
      { timeout: 3000 },
    );
    return;
  }

  const args = url
    ? ["-c", 'nohup google-chrome --profile-directory="$1" "$2" </dev/null >/dev/null 2>&1 &', "_", profileId, url]
    : ["-c", 'nohup google-chrome --profile-directory="$1" </dev/null >/dev/null 2>&1 &', "_", profileId];
  await exec("sh", args, { timeout: 3000 });
}

export default class WebLauncher extends View {
  init(initialProps, cx) {
    const p = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();
    this.overlayId = p?.overlay ?? null;
    this.handle = cx.focus_handle();
    this.profiles = [{ id: "clean", name: "Clean", email: "Sesión temporal sin cookies" }];
    this.profileId = typeof shared("web-launcher.profile") === "string"
      ? shared("web-launcher.profile")
      : "Default";
    this.detectedFromClipboard = false;
    this.error = null;

    let initialUrl = "";
    if (p?.url) {
      initialUrl = normalizeUrl(p.url) || "";
    } else if (!checking()) {
      const clip = (cx.read_from_clipboard() ?? "").trim();
      if (clip && clip.length <= 2048 && CLIPBOARD_URL_RE.test(clip)) {
        const normalized = normalizeUrl(clip);
        if (normalized) {
          initialUrl = normalized;
          this.detectedFromClipboard = true;
        }
      }
    }

    this.urlInput = InputState.new({
      placeholder: "Pega un link o déjalo vacío para abrir el navegador…",
      value: initialUrl,
    });
    this.urlInput.on("submit", (_e, cx) => this.open(false, cx));

    if (checking()) return;

    cx.spawn(async cx => {
      this.profiles = await listChromeProfiles();
      if (!this.profiles.some(pr => pr.id === this.profileId)) {
        this.profileId = this.profiles[1]?.id ?? "clean";
      }
      this.urlInput.focus();
      cx.notify();
    });
  }

  selectProfile(id, cx) {
    this.profileId = id;
    setShared("web-launcher.profile", id);
    cx.notify();
  }

  open(asApp, cx) {
    const raw = (this.urlInput?.value() ?? "").trim();
    const url = raw ? normalizeUrl(raw) : null;

    if (raw && !url) {
      this.error = "URL inválida. Usa http:// o https://";
      cx.notify();
      return;
    }
    if (asApp && !url) {
      this.error = "Ingresa un link para abrir como ventana App.";
      cx.notify();
      return;
    }

    const profileId = this.profileId;
    const overlayId = this.overlayId;
    cx.spawn(async () => {
      await launchChrome(url, profileId, asApp).catch(() => null);
    });
    if (overlayId) closeOverlay(overlayId);
  }

  close() {
    if (this.urlInput) {
      try { this.urlInput.release(); } catch {}
      this.urlInput = null;
    }
  }

  render() {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;
    const currentUrl = (this.urlInput?.value() ?? "").trim();
    const hasUrl = Boolean(currentUrl);
    const httpPorts = Array.isArray(shared("ports.http")) ? shared("ports.http") : [];

    return v_flex()
      .id("wl-root")
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            h_flex()
              .items_center()
              .gap(7)
              .child(svg("mods/tabs-custom/web.svg").size(15).text_color(t.accent))
              .child(div().text_size(13.5).font_semibold().child("Abrir en navegador")),
          )
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .when(this.detectedFromClipboard, el =>
                el.child(
                  div()
                    .px(6)
                    .py(2)
                    .rounded(4)
                    .bg(t.selected)
                    .text_size(10)
                    .text_color(t.accent)
                    .child("Link del portapapeles"),
                ),
              )
              .child(
                div()
                  .id("wl-close")
                  .size(22)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => { if (this.overlayId) closeOverlay(this.overlayId); })
                  .child(svg("mods/pane/close.svg").size(12)),
              ),
          ),
      )
      .child(
        div()
          .h(34)
          .flex_none()
          .rounded(6)
          .bg(t.input)
          .border_1()
          .border_color(this.error ? t.ansi1 : t.border)
          .px(9)
          .flex()
          .items_center()
          .child(Input.new(this.urlInput).w_full().text_size(12.5).text_color(t.foreground)),
      )
      .when(Boolean(this.error), el =>
        el.child(div().text_size(11).text_color(t.ansi1).child(this.error)),
      )
      .when(httpPorts.length > 0, el =>
        el.child(
          v_flex()
            .flex_none()
            .gap(4)
            .child(div().text_size(11).text_color(t.dim).child("Puertos HTTP/S activos"))
            .child(
              h_flex()
                .id("wl-http-ports")
                .h(28)
                .flex_none()
                .gap(5)
                .items_center()
                .overflow_x_scrollbar()
                .children(
                  httpPorts.map(hp => {
                    const selected = currentUrl === hp.url || currentUrl === `${hp.url}/`;
                    return h_flex()
                      .id(`wl-port-${hp.port}-${hp.exposure}`)
                      .h(24)
                      .flex_none()
                      .px(7)
                      .gap(5)
                      .items_center()
                      .rounded(5)
                      .border_1()
                      .border_color(selected ? t.accent : t.border)
                      .bg(selected ? t.selected : t.surface)
                      .cursor_pointer()
                      .hover(s => s.bg(selected ? t.selected : t.hover))
                      .tooltip(`${hp.url} (${hp.exposure}) · ${hp.service}`)
                      .on_click((_e, cx) => {
                        this.error = null;
                        this.detectedFromClipboard = false;
                        this.urlInput.set_value(hp.url);
                        cx.notify();
                      })
                      .child(
                        svg(hp.proto === "HTTPS" ? "mods/ports-monitor/icons/https.svg" : "mods/ports-monitor/icons/http.svg")
                          .size(12)
                          .text_color(hp.proto === "HTTPS" ? t.ansi2 : t.accent),
                      )
                      .child(
                        div()
                          .text_size(11)
                          .font_semibold()
                          .text_color(selected ? t.accent : t.foreground)
                          .child(`:${hp.port}`),
                      )
                      .child(
                        div()
                          .text_size(10)
                          .text_color(t.dim)
                          .child(hp.service),
                      );
                  }),
                ),
            ),
        ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(160)
          .gap(6)
          .child(div().text_size(11).text_color(t.dim).child("Perfil de Chrome"))
          .child(
            v_flex()
              .id("wl-profiles")
              .flex_1()
              .min_h(140)
              .overflow_y_scrollbar()
              .gap(4)
              .children(
                this.profiles.map(pr => {
                  const active = pr.id === this.profileId;
                  return h_flex()
                    .id(`wl-prof-${pr.id}`)
                    .h(30)
                    .flex_none()
                    .px(9)
                    .gap(8)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(active ? t.accent : t.border)
                    .bg(active ? t.selected : t.surface)
                    .cursor_pointer()
                    .hover(s => s.bg(active ? t.selected : t.hover))
                    .on_click((_e, cx) => this.selectProfile(pr.id, cx))
                    .child(
                      div()
                        .size(7)
                        .flex_none()
                        .rounded(4)
                        .bg(active ? t.accent : t.dim),
                    )
                    .child(
                      div()
                        .flex_none()
                        .text_size(12)
                        .font_medium()
                        .text_color(active ? t.accent : t.foreground)
                        .child(pr.name),
                    )
                    .when(Boolean(pr.email), el =>
                      el.child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(11)
                          .text_color(t.dim)
                          .child(pr.email),
                      ),
                    );
                }),
              ),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(8)
          .child(
            div()
              .id("wl-open-browser")
              .flex_1()
              .h(32)
              .rounded(6)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .flex()
              .items_center()
              .justify_center()
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover(s => s.opacity(0.9))
              .on_click((_e, cx) => this.open(false, cx))
              .child(hasUrl ? "Abrir link ↗" : "Abrir navegador ↗"),
          )
          .child(
            div()
              .id("wl-open-app")
              .px(12)
              .h(32)
              .flex_none()
              .rounded(6)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_color(hasUrl ? t.foreground : t.dim)
              .flex()
              .items_center()
              .justify_center()
              .text_size(12)
              .when(hasUrl, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
              .when(!hasUrl, el => el.opacity(0.5))
              .on_click((_e, cx) => this.open(true, cx))
              .child("App ❐"),
          ),
      );
  }
}
