import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar } from "gpui-base";

function formatRelativeAge(timestampMs) {
  if (!timestampMs) return "";
  const mins = Math.max(0, Math.floor((Date.now() - timestampMs) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderModelSection(view, t) {
  const models = view.config.models || [];
  const hasWebCookies = view.secretStatus.hasWebPsid;
  return v_flex()
    .w_full()
    .min_w(0)
    .gap(5)
    .child(
      h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .child(
          div()
            .text_size(11)
            .font_semibold()
            .text_color(t.muted)
            .child(models.length > 1 ? `Models from gemini.google.com (${models.length})` : "Model (live from web)"),
        )
        .child(
          div()
            .id("gc-sync-models")
            .h(20)
            .px(7)
            .rounded(4)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .text_size(10)
            .text_color(hasWebCookies ? t.accent : t.dim)
            .flex()
            .items_center()
            .when(hasWebCookies && !view.syncingModels, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
            .when(!hasWebCookies || view.syncingModels, el => el.opacity(0.6))
            .on_click((_e, cx) => {
              if (hasWebCookies) view.syncModelsFromWeb(cx);
            })
            .child(view.syncingModels ? "Syncing…" : "↻ Sync"),
        ),
    )
    .child(
      div()
        .relative()
        .w_full()
        .min_w(0)
        .h(36)
        .flex_none()
        .child(
          h_flex()
            .id("gc-model-strip")
            .size_full()
            .pb(8)
            .gap(5)
            .items_center()
            .overflow_x_scroll()
            .children(
              models.map(item => {
                const active = view.model === item.id;
                return div()
                  .id(`gc-model-${item.id}`)
                  .h(24)
                  .flex_none()
                  .px(9)
                  .rounded(5)
                  .border_1()
                  .border_color(active ? t.accent : t.border)
                  .bg(active ? t.selected : t.raised)
                  .text_color(active ? t.accent : t.muted)
                  .flex()
                  .items_center()
                  .text_size(11)
                  .cursor_pointer()
                  .when(Boolean(item.description), el => el.tooltip(item.description))
                  .hover(s => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => view.setModel(item.id, cx))
                  .child(item.label);
              }),
            ),
        )
        .child(Scrollbar.horizontal("gc-model-strip").mode("always").absolute().inset_0()),
    )
    .when(models.length <= 1, el =>
      el.child(
        div()
          .text_size(10)
          .text_color(t.dim)
          .child(
            hasWebCookies
              ? "Press ↻ Sync to fetch the latest models available on your Gemini Web account."
              : "Copy Chrome cookies below to load live models directly from gemini.google.com.",
          ),
      ),
    );
}

function renderWebCookieSettings(view, t) {
  const s = view.secretStatus;
  const age = formatRelativeAge(s.webUpdatedAt);
  const statusText = s.hasWebPsid
    ? `Cookies saved (${s.webProfileId || "manual"})${s.hasWebPsidts ? " · PSID + PSIDTS" : " · PSID only"}${age ? ` · ${age}` : ""}`
    : "No Gemini Web cookies imported yet";

  return v_flex()
    .w_full()
    .min_w(0)
    .gap(8)
    .p(10)
    .rounded(8)
    .bg(t.raised)
    .border_1()
    .border_color(t.border)
    .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Gemini Web — Chrome Profile Cookies"))
    .child(div().text_size(10.5).text_color(s.hasWebPsid ? t.ansi2 : t.dim).child(statusText))
    .child(
      v_flex()
        .w_full()
        .min_w(0)
        .gap(4)
        .child(div().text_size(10.5).text_color(t.muted).child("Select Chrome profile"))
        .when(view.chromeProfiles.length === 0, el =>
          el.child(div().text_size(11).text_color(t.dim).child("No profiles found in ~/.config/google-chrome/Local State")),
        )
        .when(view.chromeProfiles.length > 0, el =>
          el.child(
            v_flex()
              .id("gc-chrome-profiles")
              .w_full()
              .min_w(0)
              .max_h(148)
              .overflow_y_scrollbar()
              .gap(4)
              .children(
                view.chromeProfiles.map(pr => {
                  const selected = pr.id === view.config.chromeProfile;
                  return h_flex()
                    .id(`gc-prof-${pr.id}`)
                    .w_full()
                    .min_w(0)
                    .h(28)
                    .flex_none()
                    .px(8)
                    .gap(7)
                    .items_center()
                    .rounded(5)
                    .border_1()
                    .border_color(selected ? t.accent : t.border)
                    .bg(selected ? t.selected : t.surface)
                    .cursor_pointer()
                    .hover(s => s.bg(selected ? t.selected : t.hover))
                    .on_click((_e, cx) => view.selectChromeProfile(pr.id, cx))
                    .child(div().size(6).flex_none().rounded(3).bg(selected ? t.accent : t.dim))
                    .child(div().flex_none().text_size(11.5).font_medium().text_color(selected ? t.accent : t.foreground).child(pr.name))
                    .when(Boolean(pr.email), row =>
                      row.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(pr.email)),
                    );
                }),
              ),
          ),
        ),
    )
    .child(
      h_flex()
        .w_full()
        .gap(6)
        .child(
          div()
            .id("gc-import-cookies")
            .flex_1()
            .h(28)
            .px(10)
            .rounded(6)
            .bg(t.solid)
            .text_color(t.solid_foreground)
            .flex()
            .items_center()
            .justify_center()
            .text_size(11.5)
            .font_medium()
            .when(!view.importingCookies, el => el.cursor_pointer().hover(s => s.opacity(0.9)))
            .when(view.importingCookies, el => el.opacity(0.6))
            .on_click((_e, cx) => view.importCookiesFromProfile(cx))
            .child(view.importingCookies ? "Copying…" : "Copy cookies from profile"),
        )
        .child(
          div()
            .id("gc-open-chrome-gemini")
            .h(28)
            .px(9)
            .rounded(6)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .text_color(t.foreground)
            .flex()
            .items_center()
            .text_size(11)
            .cursor_pointer()
            .hover(s => s.bg(t.hover))
            .tooltip("Open gemini.google.com in the selected Chrome profile")
            .on_click((_e, cx) => view.openSelectedProfileInChrome(cx))
            .child("Chrome ↗"),
        ),
    )
    .when(Boolean(view.settingsNote), el =>
      el.child(
        div()
          .text_size(10.5)
          .text_color(view.settingsNoteIsError ? t.ansi1 : t.ansi2)
          .child(view.settingsNote),
      ),
    )
    .child(
      v_flex()
        .w_full()
        .min_w(0)
        .mt(2)
        .gap(5)
        .child(div().text_size(10.5).text_color(t.dim).child("Manual fallback (optional — masked)"))
        .when(Boolean(view.psidInput), el =>
          el.child(
            div()
              .h(28)
              .rounded(5)
              .bg(t.input)
              .border_1()
              .border_color(t.border)
              .px(8)
              .flex()
              .items_center()
              .child(Input.new(view.psidInput).w_full().text_size(11.5).text_color(t.foreground)),
          ),
        )
        .when(Boolean(view.psidtsInput), el =>
          el.child(
            div()
              .h(28)
              .rounded(5)
              .bg(t.input)
              .border_1()
              .border_color(t.border)
              .px(8)
              .flex()
              .items_center()
              .child(Input.new(view.psidtsInput).w_full().text_size(11.5).text_color(t.foreground)),
          ),
        )
        .child(
          h_flex()
            .gap(6)
            .child(
              div()
                .id("gc-save-manual-cookies")
                .h(25)
                .px(9)
                .rounded(5)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .text_color(t.foreground)
                .flex()
                .items_center()
                .text_size(11)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => view.saveManualCookies(cx))
                .child("Save manual"),
            )
            .when(s.hasWebPsid, el =>
              el.child(
                div()
                  .id("gc-clear-web-cookies")
                  .h(25)
                  .px(9)
                  .rounded(5)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .text_color(t.ansi1)
                  .flex()
                  .items_center()
                  .text_size(11)
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover))
                  .on_click((_e, cx) => view.clearWebCookies(cx))
                  .child("Clear cookies"),
              ),
            ),
        ),
    );
}

export function renderSettingsPanel(view, t) {
  return v_flex()
    .id("gc-settings-scroll")
    .flex_1()
    .w_full()
    .min_w(0)
    .min_h(0)
    .overflow_y_scrollbar()
    .p(10)
    .gap(12)
    .child(
      h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Gemini Web Settings"))
        .child(
          div()
            .id("gc-settings-back")
            .h(24)
            .px(8)
            .rounded(5)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .text_size(11)
            .text_color(t.foreground)
            .flex()
            .items_center()
            .gap(4)
            .cursor_pointer()
            .hover(s => s.bg(t.hover))
            .on_click((_e, cx) => view.closeSettings(cx))
            .child(svg("mods/pane/close.svg").size(10))
            .child("Done"),
        ),
    )
    .child(renderModelSection(view, t))
    .child(renderWebCookieSettings(view, t))
    .when(Boolean(view.nodeError), el =>
      el.child(
        div()
          .p(8)
          .rounded(6)
          .bg(t.raised)
          .border_1()
          .border_color(t.ansi1)
          .text_size(11)
          .text_color(t.ansi1)
          .child(view.nodeError),
      ),
    );
}
