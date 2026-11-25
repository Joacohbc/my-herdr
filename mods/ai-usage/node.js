import { appHome, exec, readTextFile } from "herdr";

export const CONFIG_FILE_NAME = "ai-usage.json";
const RESOLVE_TIMEOUT_MS = 15_000;
const COLLECT_TIMEOUT_MS = 120_000;

// "$1" is the configured node (binary or Node home dir, "~" allowed). Without it,
// PATH is tried first, then the login shell's interactive PATH (nvm, fnm, volta…).
const RESOLVE_NODE_SCRIPT = `
cfg="$1"
case "$cfg" in "~"|"~/"*) cfg="$HOME\${cfg#\\~}";; esac
if [ -n "$cfg" ]; then
  for candidate in "$cfg" "$cfg/bin/node" "$cfg/node"; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then echo "$candidate"; exit 0; fi
  done
  exit 2
fi
command -v node && exit 0
"\${SHELL:-sh}" -ic 'which node' </dev/null 2>/dev/null | grep '^/' | tail -n 1
`;

export function configFilePath() {
  return `${appHome()}/${CONFIG_FILE_NAME}`;
}

export async function loadConfig() {
  const raw = await readTextFile(configFilePath()).catch(() => null);
  if (!raw) return { node: "", claude: "", agy: "", claudeQuota: true, antigravityQuota: true };
  try {
    const parsed = JSON.parse(raw);
    return {
      node: typeof parsed.node === "string" ? parsed.node.trim() : "",
      claude: typeof parsed.claude === "string" ? parsed.claude.trim() : "",
      agy: typeof parsed.agy === "string" ? parsed.agy.trim() : "",
      claudeQuota: parsed.claudeQuota !== false,
      antigravityQuota: parsed.antigravityQuota !== false,
    };
  } catch (err) {
    return { node: "", claude: "", agy: "", claudeQuota: true, antigravityQuota: true, error: `Invalid JSON in ${CONFIG_FILE_NAME}: ${err?.message ?? err}` };
  }
}

export async function resolveNode(configuredNode) {
  const res = await exec("sh", ["-c", RESOLVE_NODE_SCRIPT, "sh", configuredNode], { timeout: RESOLVE_TIMEOUT_MS });
  const path = (res.stdout || "").trim().split("\n").pop();
  if (res.code === 0 && path?.startsWith("/")) return { path };
  if (configuredNode) return { error: `"node": "${configuredNode}" in ${CONFIG_FILE_NAME} is not a node binary or Node home` };
  return { error: `Node.js not found. Install it or set "node" (binary or Node home) in ~/.config/herdr-app/${CONFIG_FILE_NAME}` };
}

export async function runCollector(nodePath, { claude, agy, claudeQuota, antigravityQuota }, { force = false } = {}) {
  const args = ["--no-warnings", `${appHome()}/mods/ai-usage/collect.mjs`];
  if (!claudeQuota) args.push("--no-quota");
  if (!antigravityQuota) args.push("--no-agy-quota");
  if (claude) args.push(`--claude=${claude}`);
  if (agy) args.push(`--agy=${agy}`);
  if (force) args.push("--force");
  const res = await exec(nodePath, args, { timeout: COLLECT_TIMEOUT_MS });
  let parsed = {};
  try { parsed = JSON.parse(res.stdout || "{}"); } catch {}
  const error = parsed.error ?? (res.code === 0 ? null : (res.stderr || `collector exited with ${res.code}`).trim().split("\n")[0]);
  return { data: parsed.claude || parsed.antigravity ? parsed : null, error, failedToStart: res.code === 127 };
}
