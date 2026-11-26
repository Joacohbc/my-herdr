#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const herdrHome = process.env.HERDR_APP_HOME || join(process.env.HOME, ".config", "herdr-app");
const keysPath = join(herdrHome, "keys.json");

const keys = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : { global: {}, terminal: {} };

keys.global = keys.global || {};
keys.terminal = keys.terminal || {};

delete keys.global["ctrl-space"];
delete keys.terminal["ctrl-space"];
delete keys.global["ctrl-shift-t"];
delete keys.global["ctrl-shift-w"];

for (const vimKey of ["h", "j", "k", "l"]) {
  delete keys.global[`alt-${vimKey}`];
  delete keys.global[`alt-shift-${vimKey}`];
  delete keys.terminal[`alt-${vimKey}`];
  delete keys.terminal[`alt-shift-${vimKey}`];
}

const tabBindings = {
  "ctrl-t": "tab.new",
  "ctrl-w": "pane-custom.close_tab",
  "ctrl-shift-t": "pane-custom.reopen_tab",
  "ctrl-shift-p": "mod.open:command-palette",
  "ctrl-shift-e": "tabs-custom.toggle_editor_mode",
};

Object.assign(keys.global, {
  "alt-left": "pane.go:left",
  "alt-down": "pane.go:down",
  "alt-up": "pane.go:up",
  "alt-right": "pane.go:right",
  "alt-shift-left": "pane.swap:left",
  "alt-shift-down": "pane.swap:down",
  "alt-shift-up": "pane.swap:up",
  "alt-shift-right": "pane.swap:right",
  ...tabBindings,
});

keys["layout:my-herdr"] = { ...tabBindings };
Object.assign(keys.terminal, tabBindings);

writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n", "utf8");
console.log("Applied arrow pane navigation/swap and synced global/palette tab shortcuts");
