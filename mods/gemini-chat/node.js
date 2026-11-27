import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import { WebSocket } from "websocket";
import { appHome, exec, home, readTextFile } from "herdr";

export const CONFIG_FILE_NAME = "gemini-chat.json";
export const SECRET_FILE_NAME = "gemini-chat.secret.json";
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const RESOLVE_TIMEOUT_MS = 15_000;
const COOKIE_IMPORT_TIMEOUT_MS = 15_000;
const WORKER_START_TIMEOUT_MS = 4000;
const WORKER_POLL_MS = 60;

const AUTO_MODEL = {
  id: "default",
  label: "Auto",
  description: "Account default on gemini.google.com",
  capacity: 1,
  capacityField: 12,
  modelNumber: 1,
};

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

export function secretFilePath() {
  return `${appHome()}/${SECRET_FILE_NAME}`;
}

export function dataDirPath() {
  return `${appHome()}/data/gemini-chat`;
}

export function prefsFilePath() {
  return `${dataDirPath()}/prefs.json`;
}

export function modelsCachePath() {
  return `${dataDirPath()}/models.json`;
}

export async function ensurePrivateDataDir() {
  const dir = dataDirPath();
  await exec("sh", ["-c", 'umask 077 && mkdir -p -- "$1" "$1/chats" "$1/media" && chmod 700 -- "$1" "$1/chats" "$1/media"', "_", dir], { timeout: 3000 });
  return dir;
}

export function isSafeProfileName(profile) {
  if (!profile || typeof profile !== "string") return false;
  if (profile.startsWith("-") || profile.includes("/") || profile.includes("\\") || profile.includes("\0")) return false;
  return profile !== "." && profile !== "..";
}

function safeInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback;
}

function normalizeModelEntry(raw) {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, label: id, description: "", capacity: 1, capacityField: 12, modelNumber: 1 } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    label: String(raw.label || id).trim() || id,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    capacity: safeInt(raw.capacity, 1),
    capacityField: safeInt(raw.capacityField, 12),
    modelNumber: safeInt(raw.modelNumber, 1),
  };
}

export function defaultConfig() {
  return {
    node: "",
    chromeProfile: "Default",
    defaultModel: AUTO_MODEL.id,
    models: [{ ...AUTO_MODEL }],
  };
}

export async function loadCachedModels() {
  try {
    const raw = await readTextFile(modelsCachePath());
    if (!raw) return [{ ...AUTO_MODEL }];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.models)
      ? parsed.models.map(normalizeModelEntry).filter(Boolean).slice(0, 21)
      : [];
    return list.length ? list : [{ ...AUTO_MODEL }];
  } catch {
    return [{ ...AUTO_MODEL }];
  }
}

export async function saveCachedModels(models) {
  await ensurePrivateDataDir();
  const normalized = (models || []).map(normalizeModelEntry).filter(Boolean).slice(0, 21);
  const finalList = normalized.length ? normalized : [{ ...AUTO_MODEL }];
  await fs.writeFile(modelsCachePath(), JSON.stringify({ updatedAt: Date.now(), models: finalList }, null, 2) + "\n");
  return finalList;
}

export async function loadConfig() {
  const base = defaultConfig();
  let fileCfg = {};
  let userPrefs = {};
  try {
    const raw = await readTextFile(configFilePath());
    if (raw) fileCfg = JSON.parse(raw) || {};
  } catch {}
  try {
    const rawPrefs = await readTextFile(prefsFilePath());
    if (rawPrefs) userPrefs = JSON.parse(rawPrefs) || {};
  } catch {}

  const merged = { ...base, ...fileCfg, ...userPrefs };
  const cachedModels = await loadCachedModels();
  const customModels = Array.isArray(fileCfg.models)
    ? fileCfg.models.map(normalizeModelEntry).filter(Boolean).slice(0, 20)
    : [];
  const models = cachedModels.length > 1
    ? cachedModels
    : (customModels.length ? customModels : cachedModels);
  const requestedModel = typeof merged.defaultModel === "string" ? merged.defaultModel.trim() : "";
  const defaultModel = models.some(m => m.id === requestedModel) ? requestedModel : models[0].id;
  const rawProfile = typeof merged.chromeProfile === "string" ? merged.chromeProfile.trim() : "";

  return {
    node: typeof fileCfg.node === "string" ? fileCfg.node.trim() : "",
    chromeProfile: isSafeProfileName(rawProfile) ? rawProfile : "Default",
    defaultModel,
    models,
  };
}

export async function saveConfig(config) {
  await ensurePrivateDataDir();
  const prefs = {
    chromeProfile: isSafeProfileName(config.chromeProfile) ? config.chromeProfile : "Default",
    defaultModel: config.defaultModel || AUTO_MODEL.id,
  };
  await fs.writeFile(prefsFilePath(), JSON.stringify(prefs, null, 2) + "\n");
}

export async function resolveNode(configuredNode) {
  const res = await exec("sh", ["-c", RESOLVE_NODE_SCRIPT, "sh", configuredNode || ""], { timeout: RESOLVE_TIMEOUT_MS });
  const binPath = (res.stdout || "").trim().split("\n").pop();
  if (res.code === 0 && binPath?.startsWith("/")) return { path: binPath };
  if (configuredNode) {
    return { error: `"node": "${configuredNode}" in ${CONFIG_FILE_NAME} is not a valid Node binary.` };
  }
  return { error: `Node.js not found. Install Node 24+ or set "node" in ~/.config/herdr-app/${CONFIG_FILE_NAME}.` };
}

export async function listChromeProfiles() {
  try {
    const raw = await readTextFile(`${home()}/.config/google-chrome/Local State`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const cache = parsed?.profile?.info_cache;
    if (!cache || typeof cache !== "object") return [];
    return Object.entries(cache)
      .filter(([id]) => isSafeProfileName(id))
      .map(([id, meta]) => ({
        id,
        name: String(meta?.name || id),
        email: String(meta?.user_name || meta?.gaia_name || ""),
      }))
      .sort((a, b) => (a.id === "Default" ? -1 : b.id === "Default" ? 1 : a.name.localeCompare(b.name)));
  } catch {
    return [];
  }
}

export async function openGeminiInChrome(profileId) {
  if (!isSafeProfileName(profileId)) return;
  await exec(
    "sh",
    ["-c", 'nohup google-chrome --profile-directory="$1" "https://gemini.google.com/app" </dev/null >/dev/null 2>&1 &', "_", profileId],
    { timeout: 3000 },
  );
}

export async function importChromeCookies(nodePath, profileId) {
  if (!isSafeProfileName(profileId)) return { ok: false, error: "Invalid Chrome profile name." };
  const scriptPath = `${appHome()}/mods/gemini-chat/chrome-cookies.mjs`;
  const res = await exec(
    nodePath,
    ["--no-warnings", scriptPath, `--profile=${profileId}`, `--secret-file=${secretFilePath()}`],
    { timeout: COOKIE_IMPORT_TIMEOUT_MS },
  );
  try {
    const parsed = JSON.parse((res.stdout || "").trim().split("\n").pop() || "{}");
    if (parsed.ok) return parsed;
    return { ok: false, error: parsed.error || (res.stderr || "Cookie import failed").trim() };
  } catch {
    return { ok: false, error: (res.stderr || res.stdout || "Cookie import failed").trim() };
  }
}

async function terminateWorkerPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  await exec("kill", ["-TERM", String(pid)], { timeout: 2000 }).catch(() => null);
}

export async function startWorkerConnection(nodePath, cx) {
  const dir = await ensurePrivateDataDir();
  const launchId = randomUUID().slice(0, 12);
  const workerInfoPath = `${dir}/worker-${launchId}.json`;
  const tokenPath = `${dir}/worker-${launchId}.token`;
  const errLogPath = `${dir}/worker-${launchId}.err`;
  const workerScript = `${appHome()}/mods/gemini-chat/worker.mjs`;
  const token = randomUUID();

  await fs.writeFile(tokenPath, token);
  await exec("chmod", ["600", tokenPath], { timeout: 2000 }).catch(() => null);

  await exec(
    "sh",
    [
      "-c",
      'umask 077 && nohup "$1" --no-warnings --max-http-header-size=131072 "$2" --data-dir="$3" --secret-file="$4" --token-file="$5" --worker-info-file="$6" </dev/null >/dev/null 2>"$7" &',
      "_",
      nodePath,
      workerScript,
      dir,
      secretFilePath(),
      tokenPath,
      workerInfoPath,
      errLogPath,
    ],
    { timeout: 3000 },
  );

  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    const raw = await readTextFile(workerInfoPath).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.port) {
          info = parsed;
          break;
        }
      } catch {}
    }
    await cx.sleep(WORKER_POLL_MS);
  }

  if (!info?.port) {
    const errDetail = (await readTextFile(errLogPath).catch(() => "") || "").trim().slice(0, 220);
    await fs.unlink(tokenPath).catch(() => null);
    await fs.unlink(errLogPath).catch(() => null);
    throw new Error(errDetail ? `Gemini Web worker failed to start: ${errDetail}` : "Timed out waiting for Gemini Web worker to start.");
  }

  await fs.unlink(errLogPath).catch(() => null);
  try {
    const ws = await WebSocket.connect(`ws://127.0.0.1:${info.port}`);
    await ws.write(JSON.stringify({ type: "auth", token }));
    const replyRaw = await ws.read();
    const reply = JSON.parse(typeof replyRaw === "string" ? replyRaw : Buffer.from(replyRaw).toString("utf8"));
    if (reply?.type !== "auth_ok") {
      await ws.close().catch(() => null);
      throw new Error(reply?.message || "Worker authentication failed.");
    }
    return { ws, port: info.port, pid: info.pid, reading: false };
  } catch (err) {
    await terminateWorkerPid(info.pid);
    await fs.unlink(workerInfoPath).catch(() => null);
    throw err;
  }
}

export async function pickFilesWithFallback(pickFilesFn) {
  try {
    const picked = await pickFilesFn({ prompt: "Attach file to Gemini Web", multiple: true });
    if (picked !== null) return picked;
    return [];
  } catch {
    const res = await exec(
      "zenity",
      ["--file-selection", "--multiple", "--separator=\n", "--title=Attach file to Gemini Web"],
      { timeout: 120_000 },
    ).catch(() => ({ code: 1, stdout: "" }));
    if (res.code !== 0 || !res.stdout) return [];
    return res.stdout.split("\n").map(s => s.trim()).filter(Boolean);
  }
}

export async function pasteClipboardImageToFile() {
  const dir = await ensurePrivateDataDir();
  const mediaDir = `${dir}/media`;
  const fileName = `paste-${randomUUID().slice(0, 10)}.png`;
  const absPath = `${mediaDir}/${fileName}`;
  const script = `
    umask 077
    mkdir -p -- "$1"
    if command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "image/png"; then
      xclip -selection clipboard -t image/png -o > "$2" && exit 0
    fi
    if command -v wl-paste >/dev/null 2>&1 && wl-paste --list-types 2>/dev/null | grep -q "image/png"; then
      wl-paste --type image/png > "$2" && exit 0
    fi
    rm -f -- "$2"
    exit 1
  `;
  const res = await exec("sh", ["-c", script, "_", mediaDir, absPath], { timeout: 4000 });
  if (res.code !== 0) return null;
  return stageAttachmentFile(absPath, { reuseMediaPath: `data/gemini-chat/media/${fileName}` });
}

export async function stageAttachmentFile(absPath, { reuseMediaPath = null } = {}) {
  if (!absPath || typeof absPath !== "string") throw new Error("Invalid file path.");
  const name = absPath.split("/").pop() || "file";
  const statRes = await exec("sh", ["-c", '[ -f "$1" ] && [ -r "$1" ] && stat -c "%s" -- "$1"', "_", absPath], { timeout: 3000 });
  const size = Number((statRes.stdout || "").trim());
  if (statRes.code !== 0 || !Number.isFinite(size)) {
    throw new Error(`Cannot read "${name}".`);
  }
  if (size <= 0) {
    throw new Error(`"${name}" is empty.`);
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${name}" exceeds the 10 MB upload limit.`);
  }

  const isImage = IMAGE_EXT_RE.test(name);
  let previewRelPath = reuseMediaPath;
  if (isImage && !previewRelPath) {
    const dir = await ensurePrivateDataDir();
    const ext = name.split(".").pop().toLowerCase();
    const stagedName = `att-${randomUUID().slice(0, 10)}.${ext}`;
    const mediaDir = `${dir}/media`;
    const stagedAbs = `${mediaDir}/${stagedName}`;
    const cpRes = await exec("sh", ["-c", 'umask 077 && mkdir -p -- "$1" && cp -f -- "$2" "$3"', "_", mediaDir, absPath, stagedAbs], { timeout: 4000 });
    if (cpRes.code === 0) previewRelPath = `data/gemini-chat/media/${stagedName}`;
  }

  return {
    id: randomUUID().slice(0, 12),
    kind: isImage ? "image" : "file",
    name,
    path: absPath,
    size,
    previewRelPath,
    stagedOwned: Boolean(previewRelPath),
  };
}

export async function cleanupStagedAttachment(att) {
  if (!att?.stagedOwned || !att?.previewRelPath) return;
  if (!att.previewRelPath.startsWith("data/gemini-chat/media/")) return;
  await fs.unlink(`${appHome()}/${att.previewRelPath}`).catch(() => null);
}
