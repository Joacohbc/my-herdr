#!/usr/bin/env node
// Aggregates local Claude Code and Antigravity usage into one small JSON document
// for the ai-usage mod. Runs outside the GPUI sandbox so multi-hundred-MB logs
// never enter the mod's heap; incremental offsets live in a bounded cache file.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";

const HOME = homedir();
const CLAUDE_PROJECTS_DIR = join(HOME, ".claude", "projects");
const CLAUDE_SESSION_ENV_DIR = join(HOME, ".claude", "session-env");
const ANTIGRAVITY_CONVERSATION_DIRS = [
  join(HOME, ".gemini", "antigravity", "conversations"),
  join(HOME, ".gemini", "antigravity-cli", "conversations"),
];
const CACHE_DIR = join(HOME, ".config", "herdr-app", "data", "ai-usage");
const CACHE_FILE = join(CACHE_DIR, "cache.json");
const CACHE_VERSION = 2;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WINDOW_5H_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const BUCKET_MS = 5 * MINUTE_MS;
const MAX_CACHED_FILES = 600;
const MAX_GENERATIONS_PER_DB = 4000;
const MAX_DEDUP_IDS = 64;
const MAX_JSONL_DEPTH = 4;
const QUOTA_TTL_MS = 5 * MINUTE_MS;
const TOP_MODELS = 6;

const args = new Set(process.argv.slice(2));
const CLI_TIMEOUT_MS = 30_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function argValue(name) {
  return process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
}
const now = Date.now();
const weekStart = now - WEEK_MS;

function loadCache() {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (cache.version === CACHE_VERSION) return cache;
  } catch {}
  return { version: CACHE_VERSION, claudeFiles: {}, antigravityDbs: {}, quota: null };
}

function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, CACHE_FILE);
}

function listFiles(dir, extension, depth = 0, out = []) {
  if (depth > MAX_JSONL_DEPTH || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, extension, depth + 1, out);
    else if (entry.name.endsWith(extension)) out.push(path);
  }
  return out;
}

function recentFiles(paths) {
  const files = [];
  for (const path of paths) {
    try {
      const stat = statSync(path);
      if (stat.mtimeMs >= weekStart) files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CACHED_FILES);
}

function bucketOf(ts) {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function pruneBuckets(buckets) {
  for (const key of Object.keys(buckets)) if (Number(key) < weekStart) delete buckets[key];
}

function addClaudeEvent(entry, ts, model, usage) {
  const bucket = (entry.buckets[bucketOf(ts)] ??= {});
  const stats = (bucket[model] ??= [0, 0, 0, 0, 0]);
  stats[0] += 1;
  stats[1] += usage.input_tokens ?? 0;
  stats[2] += usage.output_tokens ?? 0;
  stats[3] += usage.cache_read_input_tokens ?? 0;
  stats[4] += usage.cache_creation_input_tokens ?? 0;
}

async function scanClaudeFile(file, entry) {
  const start = file.size < entry.offset ? 0 : entry.offset;
  if (start === 0) {
    entry.buckets = {};
    entry.recentIds = [];
  }
  const seen = new Set(entry.recentIds);
  let consumed = start;
  const lines = createInterface({ input: createReadStream(file.path, { start, end: file.size - 1 }), crlfDelay: Infinity });
  for await (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1;
    if (consumed + lineBytes > file.size) break;
    consumed += lineBytes;
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const message = record.message;
    const model = message?.model;
    if (!model || model === "<synthetic>" || !message.usage) continue;
    const ts = Date.parse(record.timestamp);
    if (!Number.isFinite(ts) || ts < weekStart) continue;
    const dedupId = `${message.id ?? ""}:${record.requestId ?? ""}`;
    if (seen.has(dedupId)) continue;
    seen.add(dedupId);
    entry.recentIds.push(dedupId);
    if (entry.recentIds.length > MAX_DEDUP_IDS) entry.recentIds.shift();
    addClaudeEvent(entry, ts, model, message.usage);
  }
  entry.offset = consumed;
  entry.size = file.size;
  entry.mtimeMs = file.mtimeMs;
}

async function collectClaudeBuckets(cache) {
  const files = recentFiles(listFiles(CLAUDE_PROJECTS_DIR, ".jsonl"));
  const next = {};
  for (const file of files) {
    const entry = cache.claudeFiles[file.path] ?? { offset: 0, size: 0, mtimeMs: 0, buckets: {}, recentIds: [] };
    if (entry.size !== file.size || entry.mtimeMs !== file.mtimeMs) {
      try { await scanClaudeFile(file, entry); } catch {}
    }
    pruneBuckets(entry.buckets);
    next[file.path] = entry;
  }
  cache.claudeFiles = next;
  return Object.values(next).map(entry => entry.buckets);
}

function prettyClaudeModel(model) {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  if (!match) return model;
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`;
}

function mergeClaudeEvents(bucketSets) {
  const merged = new Map();
  for (const buckets of bucketSets) {
    for (const [key, models] of Object.entries(buckets)) {
      const ts = Number(key);
      const slot = merged.get(ts) ?? {};
      for (const [model, stats] of Object.entries(models)) {
        const acc = (slot[model] ??= [0, 0, 0, 0, 0]);
        for (let i = 0; i < acc.length; i++) acc[i] += stats[i];
      }
      merged.set(ts, slot);
    }
  }
  return [...merged.entries()].sort((a, b) => a[0] - b[0]);
}

// Mirrors Claude's rolling session: a 5 h block opens on the first message after
// the previous block expired, floored to the hour.
function activeBlockStart(timestamps) {
  let blockStart = null;
  for (const ts of timestamps) {
    if (blockStart === null || ts >= blockStart + WINDOW_5H_MS) blockStart = Math.floor(ts / HOUR_MS) * HOUR_MS;
  }
  if (blockStart === null || now >= blockStart + WINDOW_5H_MS) return null;
  return blockStart;
}

function summarizeClaude(events) {
  const blockStart = activeBlockStart(events.map(([ts]) => ts));
  const models = new Map();
  const week = { messages: 0, tokens: 0 };
  const window = { messages: 0, tokens: 0, start: blockStart, resetsAt: blockStart === null ? null : blockStart + WINDOW_5H_MS };
  for (const [ts, slot] of events) {
    for (const [model, [messages, input, output, cacheRead, cacheWrite]] of Object.entries(slot)) {
      const name = prettyClaudeModel(model);
      const acc = models.get(name) ?? { model: name, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, window: 0 };
      acc.messages += messages;
      acc.input += input;
      acc.output += output;
      acc.cacheRead += cacheRead;
      acc.cacheWrite += cacheWrite;
      const tokens = input + output + cacheWrite;
      week.messages += messages;
      week.tokens += tokens;
      if (blockStart !== null && ts >= blockStart) {
        acc.window += messages;
        window.messages += messages;
        window.tokens += tokens;
      }
      models.set(name, acc);
    }
  }
  const ranked = [...models.values()].sort((a, b) => b.messages - a.messages).slice(0, TOP_MODELS);
  return { models: ranked, week, window };
}

function readVarint(buf, offset) {
  let value = 0;
  let scale = 1;
  let i = offset;
  for (;;) {
    const byte = buf[i++];
    if (byte === undefined) throw new RangeError("truncated varint");
    value += (byte & 0x7f) * scale;
    scale *= 128;
    if (!(byte & 0x80)) return [value, i];
  }
}

// steps.metadata is a protobuf whose field 1 is a Timestamp { seconds = 1 }.
function stepCreatedAtMs(blob) {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  try {
    let i = 0;
    while (i < buf.length) {
      let key;
      [key, i] = readVarint(buf, i);
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) { [, i] = readVarint(buf, i); continue; }
      if (wire === 1) { i += 8; continue; }
      if (wire === 5) { i += 4; continue; }
      if (wire !== 2) return null;
      let length;
      [length, i] = readVarint(buf, i);
      if (field === 1 && buf[i] === 0x08) return readVarint(buf, i + 1)[0] * 1000;
      i += length;
    }
  } catch {}
  return null;
}

function lengthDelimitedField(buf, wantedField) {
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) { [, i] = readVarint(buf, i); continue; }
    if (wire === 1) { i += 8; continue; }
    if (wire === 5) { i += 4; continue; }
    if (wire !== 2) return null;
    let length;
    [length, i] = readVarint(buf, i);
    if (field === wantedField) return buf.subarray(i, i + length);
    i += length;
  }
  return null;
}

function varintFields(buf) {
  const values = {};
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const wire = key % 8;
    if (wire === 0) { let value; [value, i] = readVarint(buf, i); values[Math.floor(key / 8)] = value; continue; }
    if (wire === 1) { i += 8; continue; }
    if (wire === 5) { i += 4; continue; }
    if (wire !== 2) break;
    let length;
    [length, i] = readVarint(buf, i);
    i += length;
  }
  return values;
}

// gen_metadata: field 1 (generation) → field 4 (usage) { 1: model id, 2: input, 3: output, 5: cached input }.
function generationTokens(blob) {
  try {
    const generation = lengthDelimitedField(Buffer.from(blob ?? []), 1);
    const usage = generation && lengthDelimitedField(generation, 4);
    if (!usage) return [0, 0, 0];
    const fields = varintFields(usage);
    return [fields[2] ?? 0, fields[3] ?? 0, fields[5] ?? 0];
  } catch {
    return [0, 0, 0];
  }
}

// "$1" is the configured binary ("~" allowed), "$2" its command name; otherwise PATH,
// then the interactive login shell's PATH (nvm, ~/.local/bin set up in .zshrc…).
const RESOLVE_BIN_SCRIPT = `
cfg="$1"
case "$cfg" in "~"|"~/"*) cfg="$HOME\${cfg#\\~}";; esac
if [ -n "$cfg" ]; then [ -x "$cfg" ] && { echo "$cfg"; exit 0; }; exit 2; fi
command -v "$2" && exit 0
"\${SHELL:-sh}" -ic 'which "$0"' "$2" </dev/null 2>/dev/null | grep '^/' | tail -n 1
`;

function run(file, argv, timeout) {
  return new Promise(resolve => {
    execFile(file, argv, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? "") }));
  });
}

const BINARY_MISS_TTL_MS = 30 * MINUTE_MS;

// A miss is remembered so an absent CLI does not cost an interactive shell every refresh;
// changing the configured path invalidates it.
async function resolveBinary(name, cache) {
  const configured = argValue(name);
  const misses = (cache.binaryMisses ??= {});
  const miss = misses[name];
  if (miss && miss.configured === configured && now - miss.at < BINARY_MISS_TTL_MS) return { missing: true, error: miss.error };
  const res = await run("sh", ["-c", RESOLVE_BIN_SCRIPT, "sh", configured, name], CLI_TIMEOUT_MS);
  const path = res.stdout.trim().split("\n").pop();
  if (path?.startsWith("/")) {
    delete misses[name];
    return { path };
  }
  const error = configured ? `"${name}": "${configured}" is not executable` : `${name} CLI not found`;
  misses[name] = { at: now, configured, error };
  return { missing: true, error };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function timeZoneOffsetMs(epochMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(epochMs)).map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epochMs;
}

// "Nov 25, 4:20pm" + "America/Montevideo" → epoch ms (the text carries no year).
function parseResetText(text, timeZone) {
  const match = /^([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const hour = (Number(match[3]) % 12) + (match[5].toLowerCase() === "pm" ? 12 : 0);
  const year = new Date(now).getUTCFullYear();
  for (const candidateYear of [year, year + 1]) {
    const wallClock = Date.UTC(candidateYear, month, Number(match[2]), hour, Number(match[4] ?? 0));
    let epoch = wallClock;
    try { epoch = wallClock - timeZoneOffsetMs(wallClock, timeZone); } catch {}
    if (epoch >= now - 24 * HOUR_MS) return epoch;
  }
  return null;
}

// "Current session: 68% used · resets Nov 25, 4:20pm (America/Montevideo)"
const CLAUDE_USAGE_LINE = /^Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · resets (.+?) \(([^)]+)\))?\s*$/;

function parseClaudeUsageText(text) {
  const quota = { plan: /subscription/i.test(text) ? "subscription" : null };
  for (const line of String(text ?? "").split("\n")) {
    const match = CLAUDE_USAGE_LINE.exec(line.trim());
    if (!match) continue;
    const entry = { pct: Number(match[3]), resetsAt: match[4] ? parseResetText(match[4], match[5]) : null };
    if (match[1] === "session") quota.fiveHour = entry;
    else if (!match[2] || /all models/i.test(match[2])) quota.sevenDay = entry;
    else if (/opus/i.test(match[2])) quota.sevenDayOpus = entry;
    else if (/sonnet/i.test(match[2])) quota.sevenDaySonnet = entry;
  }
  return quota;
}

// `claude -p /usage` is a local command: no model turn and zero tokens. It still leaves an
// empty ~/.claude/session-env/<session_id> directory, removed here (rmdir refuses non-empty dirs).
const SESSION_ENV_SETTLE_MS = 1_500;
const pendingSessionEnvDirs = [];

async function removeEmptySessionEnvDirs() {
  if (pendingSessionEnvDirs.length === 0) return;
  await new Promise(resolve => setTimeout(resolve, SESSION_ENV_SETTLE_MS));
  for (const sessionId of pendingSessionEnvDirs) {
    try { rmdirSync(join(CLAUDE_SESSION_ENV_DIR, sessionId)); } catch {}
  }
}

async function fetchClaudeQuota(cache) {
  if (args.has("--no-quota")) return { disabled: true };
  if (cache.quota && cache.quota.configured === argValue("claude") && now - cache.quota.at < QUOTA_TTL_MS) return cache.quota.data;
  let data;
  const claude = await resolveBinary("claude", cache);
  if (claude.missing) {
    data = { error: claude.error, missingCli: true };
  } else {
    const res = await run(claude.path, ["-p", "/usage", "--output-format", "json", "--no-session-persistence"], CLI_TIMEOUT_MS);
    try {
      const body = JSON.parse(res.stdout);
      if (SESSION_ID_PATTERN.test(body.session_id ?? "")) pendingSessionEnvDirs.push(body.session_id);
      const quota = parseClaudeUsageText(body.result);
      data = quota.fiveHour || quota.sevenDay ? quota : { error: body.is_error ? "claude /usage failed" : "no quota in claude /usage" };
    } catch {
      data = { error: res.ok ? "unexpected claude output" : "claude /usage failed" };
    }
  }
  cache.quota = { at: now, configured: argValue("claude"), data };
  return data;
}

function toAntigravityGroups(command) {
  return (command?.data?.groups ?? []).map(group => ({
    name: group.name,
    windows: (group.buckets ?? []).map(bucket => ({
      window: bucket.window,
      pct: Math.max(0, Math.min(100, (1 - Number(bucket.remaining_fraction ?? 1)) * 100)),
      resetsAt: bucket.reset_time ? Date.parse(bucket.reset_time) : null,
    })),
  }));
}

// `agy -p /usage` is answered locally by the CLI (no model turn, zero tokens).
async function fetchAntigravityQuota(cache) {
  if (args.has("--no-agy-quota")) return { disabled: true };
  if (cache.agyQuota && cache.agyQuota.configured === argValue("agy") && now - cache.agyQuota.at < QUOTA_TTL_MS) return cache.agyQuota.data;
  let data;
  const agy = await resolveBinary("agy", cache);
  if (agy.missing) {
    data = { error: agy.error, missingCli: true };
  } else {
    const res = await run(agy.path, ["-p", "/usage", "--output-format", "json"], CLI_TIMEOUT_MS);
    try {
      const body = JSON.parse(res.stdout);
      const groups = toAntigravityGroups(body.command);
      data = groups.length ? { groups } : { error: body.status ?? "no quota data" };
    } catch {
      data = { error: res.ok ? "unexpected agy output" : "agy /usage failed" };
    }
  }
  cache.agyQuota = { at: now, configured: argValue("agy"), data };
  return data;
}

const MODEL_LABEL_PATTERN = /(Gemini|Claude|GPT|Orchestrator)[ -~]{1,40}?\((?:Low|Medium|High|XHigh)\)/;

async function readAntigravityDb(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const generations = db.prepare("SELECT data FROM gen_metadata ORDER BY idx").all().map(row => ({
      model: MODEL_LABEL_PATTERN.exec(Buffer.from(row.data ?? []).toString("latin1"))?.[0] ?? null,
      tokens: generationTokens(row.data),
    }));
    const times = db.prepare("SELECT metadata FROM steps ORDER BY idx").all()
      .map(row => stepCreatedAtMs(row.metadata))
      .filter(ts => ts !== null)
      .sort((a, b) => a - b);
    if (times.length === 0) return [];
    // Generations carry no timestamp: spread them over the conversation's step timeline.
    return generations
      .map(({ model, tokens }, i) => [times[Math.min(times.length - 1, Math.floor((i / Math.max(1, generations.length)) * times.length))], model, ...tokens])
      .filter(([ts, model]) => model && ts >= weekStart)
      .slice(-MAX_GENERATIONS_PER_DB);
  } finally {
    db.close();
  }
}

async function collectAntigravityGenerations(cache) {
  const paths = ANTIGRAVITY_CONVERSATION_DIRS.flatMap(dir => listFiles(dir, ".db", MAX_JSONL_DEPTH));
  const files = recentFiles(paths);
  const next = {};
  for (const file of files) {
    let entry = cache.antigravityDbs[file.path];
    if (!entry || entry.mtimeMs !== file.mtimeMs) {
      try { entry = { mtimeMs: file.mtimeMs, generations: await readAntigravityDb(file.path) }; } catch { continue; }
    }
    entry.generations = entry.generations.filter(([ts]) => ts >= weekStart);
    next[file.path] = entry;
  }
  cache.antigravityDbs = next;
  return Object.values(next).flatMap(entry => entry.generations).sort((a, b) => a[0] - b[0]);
}

function summarizeAntigravity(generations) {
  const windowStart = now - WINDOW_5H_MS;
  const models = new Map();
  const week = { generations: 0, tokens: 0 };
  const window = { generations: 0, tokens: 0, start: windowStart };
  for (const [ts, model, input = 0, output = 0, cached = 0] of generations) {
    const tokens = input + output;
    const acc = models.get(model) ?? { model, generations: 0, window: 0, input: 0, output: 0, cached: 0 };
    acc.generations += 1;
    acc.input += input;
    acc.output += output;
    acc.cached += cached;
    week.generations += 1;
    week.tokens += tokens;
    if (ts >= windowStart) {
      acc.window += 1;
      window.generations += 1;
      window.tokens += tokens;
    }
    models.set(model, acc);
  }
  const ranked = [...models.values()].sort((a, b) => b.generations - a.generations).slice(0, TOP_MODELS);
  return { models: ranked, week, window, conversations: null };
}

function isCliPresent(quota) {
  return Boolean(quota) && !quota.disabled && !quota.missingCli;
}

async function main() {
  const cache = loadCache();
  const [claudeBuckets, antigravityGenerations] = await Promise.all([
    collectClaudeBuckets(cache),
    collectAntigravityGenerations(cache),
  ]);
  const claude = summarizeClaude(mergeClaudeEvents(claudeBuckets));
  claude.quota = await fetchClaudeQuota(cache);
  const antigravity = summarizeAntigravity(antigravityGenerations);
  antigravity.conversations = Object.keys(cache.antigravityDbs).length;
  antigravity.quota = await fetchAntigravityQuota(cache);
  claude.installed = existsSync(CLAUDE_PROJECTS_DIR) || isCliPresent(claude.quota);
  antigravity.installed = ANTIGRAVITY_CONVERSATION_DIRS.some(dir => existsSync(dir)) || isCliPresent(antigravity.quota);
  saveCache(cache);
  await removeEmptySessionEnvDirs();
  process.stdout.write(JSON.stringify({ at: now, claude, antigravity }));
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ at: now, error: String(err?.message ?? err) }));
  process.exitCode = 1;
});
