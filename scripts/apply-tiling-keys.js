#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const herdrHome = process.env.HERDR_APP_HOME || join(process.env.HOME, ".config", "herdr-app");
const cfgPath = join(repoDir, "tiling-config.json");
const keysPath = join(herdrHome, "keys.json");

const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const base = (cfg.base_modifier || "ctrl-alt").trim();
const leader = (cfg.leader_key || "ctrl-space").trim();
const layoutName = (cfg.layout || "my-herdr").trim();
const sectionKey = `layout:${layoutName}`;

const keys = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : { global: {}, terminal: {} };

const tilingBindings = {
  [leader]: "mod.open:tiling-mode",

  // Navigate panes (arrows + hjkl)
  [`${base}-left`]: "pane.go:left",
  [`${base}-right`]: "pane.go:right",
  [`${base}-up`]: "pane.go:up",
  [`${base}-down`]: "pane.go:down",
  [`${base}-h`]: "pane.go:left",
  [`${base}-l`]: "pane.go:right",
  [`${base}-k`]: "pane.go:up",
  [`${base}-j`]: "pane.go:down",

  // Move / Swap panes (base + shift + arrows/hjkl)
  [`${base}-shift-left`]: "pane.swap:left",
  [`${base}-shift-right`]: "pane.swap:right",
  [`${base}-shift-up`]: "pane.swap:up",
  [`${base}-shift-down`]: "pane.swap:down",
  [`${base}-shift-h`]: "pane.swap:left",
  [`${base}-shift-l`]: "pane.swap:right",
  [`${base}-shift-k`]: "pane.swap:up",
  [`${base}-shift-j`]: "pane.swap:down",

  // Tiling actions
  [`${base}-v`]: "pane.split:right",
  [`${base}-s`]: "pane.split:down",
  [`${base}-z`]: "pane.zoom",
  [`${base}-q`]: "pane-custom.close_pane",
  [`${base}-shift-q`]: "pane-custom.reopen_pane",
  [`${base}-w`]: "pane-custom.close_tab",
  [`${base}-shift-w`]: "pane-custom.reopen_tab",
  [`${base}-x`]: "pane-custom.close_pane",
  [`${base}-r`]: "mod.open:tiling-mode",

  // Move tabs
  [`${base}-[`]: { command: "tab.move", args: { by: -1 } },
  [`${base}-]`]: { command: "tab.move", args: { by: 1 } },
};

keys.global = {
  ...(keys.global || {}),
  [leader]: "mod.open:tiling-mode",
};

keys.terminal = {
  ...(keys.terminal || {}),
  [leader]: "mod.open:tiling-mode",
};

keys[sectionKey] = {
  ...(keys[sectionKey] || {}),
  ...tilingBindings,
};

writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n", "utf8");
console.log(`Applied ${Object.keys(tilingBindings).length} tiling shortcuts under "${sectionKey}" + global/terminal leader "${leader}" (base: ${base})`);
