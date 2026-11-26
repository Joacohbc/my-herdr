import {
  spaces,
  panes,
  focused,
  commands,
  keys,
  exec,
  run,
  appHome,
  readTextFile,
  writeTextFile,
  shared,
  setShared,
  notify,
} from "herdr";

export const MAX_ALIASES = 100;
export const MAX_RECENT = 10;

export function aliasesFilePath() {
  return `${appHome()}/command-aliases.json`;
}

export function getActiveLocation() {
  const space = spaces().find(s => s.active);
  const f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const fallbackTermPane = pane && !pane.cwd && f?.tab
    ? allPanes.find(p => p.tab === f.tab && p.cwd)
    : null;
  const on = f?.pane === null
    ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null)
    : space?.machine ?? null;
  const cwd = pane?.cwd || fallbackTermPane?.cwd || f?.cwd || space?.folder || "";
  return { cwd, on, space: space?.id ?? null };
}

export function normalizeAlias(item) {
  if (!item || typeof item !== "object") return null;
  const name = String(item.name ?? "").trim();
  const command = String(item.command ?? "").trim();
  if (!name || !command) return null;
  const place = item.place === "right" || item.place === "down" ? item.place : "tab";
  return {
    name,
    command,
    description: String(item.description ?? "").trim(),
    place,
    keepOpen: item.keepOpen !== false,
  };
}

export async function loadAliases() {
  const path = aliasesFilePath();
  const raw = await readTextFile(path).catch(() => null);
  if (!raw) return { aliases: [], raw: null, error: null };
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.aliases)
        ? parsed.aliases
        : [];
    const aliases = list.map(normalizeAlias).filter(Boolean).slice(0, MAX_ALIASES);
    return { aliases, raw, error: null };
  } catch (e) {
    return { aliases: [], raw, error: `Invalid JSON in command-aliases.json: ${e.message || e}` };
  }
}

export async function saveAliases(aliases, expectedRaw) {
  const bounded = aliases.map(normalizeAlias).filter(Boolean).slice(0, MAX_ALIASES);
  const text = JSON.stringify({ aliases: bounded }, null, 2) + "\n";
  await writeTextFile(aliasesFilePath(), text, expectedRaw);
  return { aliases: bounded, raw: text };
}

export function pushRecentCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return;
  const prev = Array.isArray(shared("command-palette.recent")) ? shared("command-palette.recent") : [];
  const next = [trimmed, ...prev.filter(c => c !== trimmed)].slice(0, MAX_RECENT);
  setShared("command-palette.recent", next);
}

export function validateRelativePath(raw) {
  const cleaned = String(raw ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) return { ok: false, error: "Name cannot be empty." };
  if (/[\0\r\n]/.test(cleaned)) return { ok: false, error: "Invalid control characters in path." };
  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) return { ok: false, error: "Name cannot be empty." };
  if (parts.some(p => p === "." || p === "..")) {
    return { ok: false, error: "Path cannot contain '.' or '..' segments." };
  }
  return { ok: true, relPath: parts.join("/"), parts };
}

export async function createFsEntry({ root, on, baseDir, rawPath, isDir, allowExisting = false }) {
  if (!root) return { ok: false, error: "No active folder in current space." };
  const validated = validateRelativePath(rawPath);
  if (!validated.ok) return validated;

  const prefix = String(baseDir ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const relPath = prefix ? `${prefix}/${validated.relPath}` : validated.relPath;
  const absPath = `${root.replace(/\/+$/, "")}/${relPath}`;
  const parentRel = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";

  const script = isDir
    ? 'if [ -e "$1" ]; then echo "Path already exists" >&2; exit 2; fi; mkdir -p -- "$1"'
    : allowExisting
      ? 'if [ -d "$1" ]; then echo "Path is a directory" >&2; exit 3; fi; mkdir -p -- "$(dirname "$1")"; [ -e "$1" ] || : > "$1"'
      : 'if [ -e "$1" ]; then echo "File already exists" >&2; exit 2; fi; mkdir -p -- "$(dirname "$1")"; : > "$1"';

  const res = await exec("sh", ["-c", script, "_", absPath], { cwd: root, on: on ?? null, timeout: 8000 });
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "Could not create entry").trim() };
  }

  const prev = shared("files-search.refresh")?.seq ?? 0;
  setShared("files-search.refresh", { seq: prev + 1, expand: parentRel, root, on: on ?? null });

  return {
    ok: true,
    relPath,
    absPath,
    parentRel,
    name: relPath.split("/").pop() || relPath,
  };
}

export async function detectTerminalEditor(on) {
  try {
    const res = await exec(
      "sh",
      ["-c", 'for ed in micro nano vi; do if command -v "$ed" >/dev/null 2>&1; then printf "%s" "$ed"; exit 0; fi; done; exit 1'],
      { on: on ?? null, timeout: 4000 },
    );
    const detected = (res.stdout || "").trim();
    if (res.code === 0 && detected) return detected;
  } catch {}
  return "nano";
}

export async function openInTerminalEditor({ absPath, folder, on, place = "tab", name }) {
  const editor = await detectTerminalEditor(on);
  const label = name ? `${editor}: ${name}` : editor;
  run("terminal.open", {
    argv: [editor, absPath],
    ...(folder ? { folder } : {}),
    place,
    name: label,
  });
  return editor;
}

export function openInFileViewer({ relPath, root, on, name }) {
  const f = focused();
  const tabId = f?.tab ?? null;
  const payload = { file: relPath, root, on: on ?? null, tab: tabId, line: null, col: null, matchLen: null };
  const existing = tabId ? panes().find(p => p.tab === tabId && p.mod === "file-viewer") : null;

  if (existing) {
    const prevSeq = shared("file-viewer.open")?.seq ?? 0;
    setShared("file-viewer.open", { ...payload, pane: existing.pane, seq: prevSeq + 1 });
    run("pane.focus", { pane: existing.pane });
    run("pane.rename", { pane: existing.pane, name });
    return;
  }

  const res = run("pane.split", { direction: "right", mod: "file-viewer", props: payload });
  if (res?.pane) run("pane.rename", { pane: res.pane, name });
}

export function runCommandInTerminal({ command, folder, place = "tab", name, keepOpen = true }) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return;
  pushRecentCommand(trimmed);
  const argv = keepOpen
    ? ["sh", "-c", 'sh -lc "$1"; printf "\\n"; exec "${SHELL:-sh}" -i', "_", trimmed]
    : ["sh", "-lc", trimmed];
  run("terminal.open", {
    argv,
    ...(folder ? { folder } : {}),
    place,
    name: name || trimmed.slice(0, 28),
  });
}

export function openAliasesInViewer() {
  const root = appHome();
  const name = "command-aliases.json";
  const res = run("tab.new", {
    name,
    mod: "file-viewer",
    props: { file: name, root, on: null, tab: null, solo: true },
  });
  if (res?.pane) run("pane.rename", { pane: res.pane, name });
  else notify({ title: "Aliases file", body: aliasesFilePath(), timeout: 2500 });
}

function buildKeyMap() {
  const map = new Map();
  for (const b of keys() ?? []) {
    if (!b?.action || !b?.keys) continue;
    if (b.section === "global" || !map.has(b.action)) {
      map.set(b.action, b.keys);
    }
  }
  return map;
}

const CLEAN_TITLE = /^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u;
const PATH_LIKE = /^[~/]|^[A-Za-z]:\\/;

function cleanTitle(value) {
  return (value ?? "").replace(CLEAN_TITLE, "").replace(/^\[ [!.] \] /, "").trim();
}

function resolveTabLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : (prog ?? `Tab ${tab.index}`);
  if (!lead?.program?.agent) return base;
  const live = cleanTitle(lead.title);
  const rawWithoutGlyph = (lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "");
  const isPath = PATH_LIKE.test(rawWithoutGlyph);
  const isTelling = live && live !== lead.terminal && live !== prog && !isPath && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && isTelling ? live : base;
}

function folderTail(path) {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed;
}

export function buildSwitchItems() {
  const allSpaces = spaces() ?? [];
  const allPanes = panes() ?? [];
  const mru = Array.isArray(shared("switcher.mru")) ? shared("switcher.mru") : [];

  const tabRank = new Map();
  const spaceRank = new Map();
  mru.forEach((entry, idx) => {
    if (!entry?.space || !entry?.tab) return;
    const key = `${entry.space}::${entry.tab}`;
    if (!tabRank.has(key)) tabRank.set(key, idx);
    if (!spaceRank.has(entry.space)) spaceRank.set(entry.space, idx);
  });

  const panesByTab = new Map();
  for (const pane of allPanes) {
    if (!pane?.tab) continue;
    let list = panesByTab.get(pane.tab);
    if (!list) {
      list = [];
      panesByTab.set(pane.tab, list);
    }
    list.push(pane);
  }

  const items = [];
  for (const space of allSpaces) {
    const tabs = space.tabs ?? [];
    const sRank = spaceRank.has(space.id) ? spaceRank.get(space.id) : Infinity;

    for (const tab of tabs) {
      const tabPanes = panesByTab.get(tab.id) ?? [];
      const lead = tabPanes.find(p => p.program?.agent) ?? tabPanes[0] ?? null;
      const title = resolveTabLabel(tab, lead);
      const progName = lead?.program?.name ?? "";
      const cwdName = folderTail(lead?.cwd);
      const subParts = [space.name];
      if (space.machine) subParts.push(space.machine);
      if (progName && progName.toLowerCase() !== title.toLowerCase()) subParts.push(progName);
      if (tab.panes > 1) subParts.push(`${tab.panes} panes`);
      if (cwdName && cwdName.toLowerCase() !== space.name.toLowerCase()) subParts.push(cwdName);

      const isCurrent = Boolean(space.active && tab.active);
      const key = `${space.id}::${tab.id}`;
      const rank = tabRank.has(key) ? tabRank.get(key) : Infinity;

      items.push({
        id: `switch-tab:${space.id}:${tab.id}`,
        kind: "switch-tab",
        group: "Tab",
        title,
        subtitle: subParts.join(" · "),
        words: `${space.name} ${space.branch || ""} ${space.folder || ""} ${space.machine || ""} ${tab.name} ${title} ${progName} ${lead?.title || ""} ${lead?.cwd || ""} tab`,
        shortcut: isCurrent ? "Current" : (space.active ? `Tab ${tab.index}` : `S${space.index}·T${tab.index}`),
        spaceId: space.id,
        tabId: tab.id,
        status: tab.status ?? null,
        isCurrent,
        mruRank: rank,
        order: space.index * 1000 + tab.index,
      });
    }

    const tabCount = tabs.length;
    const spaceSubParts = [`${tabCount} ${tabCount === 1 ? "tab" : "tabs"}`];
    if (space.branch) spaceSubParts.push(space.branch);
    if (space.machine) spaceSubParts.push(space.machine);
    const tail = folderTail(space.folder);
    if (tail && tail.toLowerCase() !== space.name.toLowerCase()) spaceSubParts.push(tail);

    items.push({
      id: `switch-space:${space.id}`,
      kind: "switch-space",
      group: "Space",
      title: space.name,
      subtitle: spaceSubParts.join(" · "),
      words: `${space.name} ${space.branch || ""} ${space.folder || ""} ${space.machine || ""} space`,
      shortcut: space.active ? "Current" : `Space ${space.index}`,
      spaceId: space.id,
      tabId: null,
      status: space.status ?? null,
      isCurrent: Boolean(space.active),
      mruRank: sRank,
      order: space.index * 1000 + 999,
    });
  }

  items.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? 1 : -1;
    if (a.mruRank !== b.mruRank) return a.mruRank - b.mruRank;
    if (a.kind !== b.kind) return a.kind === "switch-tab" ? -1 : 1;
    return a.order - b.order;
  });

  const firstMru = items.find(item => !item.isCurrent && item.mruRank < Infinity);
  if (firstMru) {
    firstMru.shortcut = "Last";
    firstMru.isLast = true;
  }

  return items;
}

export function switchToTarget(item) {
  if (!item?.spaceId) return;
  if (item.kind === "switch-space") {
    run("space.select", { id: item.spaceId });
    return;
  }
  if (item.kind === "switch-tab" && item.tabId) {
    const targetSpace = (spaces() ?? []).find(s => s.id === item.spaceId);
    if (targetSpace && !targetSpace.active) {
      run("space.select", { id: item.spaceId });
    }
    run("tab.select", { id: item.tabId });
  }
}

const CUSTOM_COMMANDS = [
  {
    id: "custom:switch-space-tab",
    group: "Switch",
    title: "Switch Space / Tab (@)",
    subtitle: "Jump between open spaces and tabs in recent (Alt-Tab) order",
    words: "switch space tab alt-tab jump window workspace @",
    action: { kind: "enter-switcher" },
  },
  {
    id: "custom:web",
    group: "Web",
    title: "Open Web Launcher",
    subtitle: "Launch Chrome profile, Clean session, or active HTTP port",
    words: "web browser chrome url link port",
    action: { kind: "mod.open", name: "web-launcher" },
  },
  {
    id: "custom:create-file",
    group: "Files",
    title: "Create File",
    subtitle: "Create a new file in the active folder (supports nested paths)",
    words: "new file create touch add",
    action: { kind: "switch-mode", mode: "create-file" },
  },
  {
    id: "custom:create-folder",
    group: "Files",
    title: "Create Folder",
    subtitle: "Create a new folder in the active directory",
    words: "new folder directory mkdir create add",
    action: { kind: "switch-mode", mode: "create-folder" },
  },
  {
    id: "custom:quick-edit",
    group: "Files",
    title: "Quick Edit in Terminal (micro / nano)",
    subtitle: "Create or open a file directly in micro/nano",
    words: "edit micro nano editor terminal create file",
    action: { kind: "switch-mode", mode: "quick-edit" },
  },
  {
    id: "custom:run-command",
    group: "Terminal",
    title: "Run Command (> )",
    subtitle: "Execute a shell command or saved alias in a new terminal",
    words: "run exec shell terminal alias >",
    action: { kind: "enter-runner" },
  },
  {
    id: "custom:edit-aliases",
    group: "Terminal",
    title: "Edit Command Aliases (command-aliases.json)",
    subtitle: "Open the configurable aliases JSON file in file-viewer",
    words: "aliases commands json config settings",
    action: { kind: "edit-aliases" },
  },
  {
    id: "custom:close-tab",
    group: "Tab",
    title: "Close tab (save to history)",
    subtitle: "Close current tab and save it for Ctrl+Shift+T",
    words: "close tab ctrl-w",
    shortcutKey: "pane-custom.close_tab",
    action: { kind: "run", command: "pane-custom.close_tab" },
  },
  {
    id: "custom:reopen-tab",
    group: "Tab",
    title: "Reopen closed tab",
    subtitle: "Restore the most recently closed tab",
    words: "reopen restore undo tab ctrl-shift-t",
    shortcutKey: "pane-custom.reopen_tab",
    action: { kind: "run", command: "pane-custom.reopen_tab" },
  },
  {
    id: "custom:native-palette",
    group: "App",
    title: "Open Native Herdr Palette",
    subtitle: "Fallback to Herdr built-in app.palette",
    words: "native built-in palette",
    action: { kind: "run", command: "app.palette" },
  },
];

function groupForCommand(name) {
  const prefix = name.split(".")[0] || "App";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export function buildCommandList() {
  const keyMap = buildKeyMap();
  const custom = CUSTOM_COMMANDS.map(c => ({
    ...c,
    shortcut: c.shortcutKey ? keyMap.get(c.shortcutKey) ?? "" : "",
  }));

  const native = (commands() ?? [])
    .filter(c => {
      if (!c?.name || c.name === "app.palette") return false;
      const hasRequired = (c.args ?? []).some(a => a.required);
      return !hasRequired;
    })
    .map(c => ({
      id: `cmd:${c.name}`,
      group: groupForCommand(c.name),
      title: c.name,
      subtitle: c.about || "",
      words: `${c.name} ${c.about || ""}`,
      shortcut: keyMap.get(c.name) ?? "",
      action: { kind: "run", command: c.name },
    }));

  return [...custom, ...native];
}
