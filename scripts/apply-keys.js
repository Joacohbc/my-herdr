#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const herdrHome = process.env.HERDR_APP_HOME || join(process.env.HOME, ".config", "herdr-app");
const keysPath = join(herdrHome, "keys.json");

const keys = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : { global: {}, terminal: {} };

// Clean up any legacy tiling-mode bindings
delete keys.global?.["ctrl-space"];
delete keys.terminal?.["ctrl-space"];

const tabBindings = {
  "ctrl-t": "tab.new",
  "ctrl-w": "pane-custom.close_tab",
  "ctrl-shift-t": "pane-custom.reopen_tab",
};

keys["layout:my-herdr"] = { ...tabBindings };
keys.terminal = {
  ...(keys.terminal || {}),
  ...tabBindings,
};

writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n", "utf8");
console.log('Applied tab shortcuts (ctrl-t, ctrl-w, ctrl-shift-t) and removed tiling bindings');
