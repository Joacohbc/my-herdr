import { exec } from "herdr";

export const MAX_CONTAINERS = 64;
export const MAX_CPU_HISTORY = 30;

const UNIT_BYTES = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };

export function parseBytes(text) {
  const match = /([\d.]+)\s*([A-Za-z]+)/.exec(String(text ?? ""));
  if (!match) return 0;
  return Number(match[1]) * (UNIT_BYTES[match[2].toUpperCase()] ?? 1);
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${Math.round(bytes)}B`;
}

function parseJsonLines(stdout) {
  const rows = [];
  for (const line of (stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function parseLabels(text) {
  const labels = {};
  for (const pair of String(text ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

function shortPorts(text) {
  const published = new Set();
  for (const match of String(text ?? "").matchAll(/:(\d+)->(\d+)\/(tcp|udp)/g)) published.add(`${match[1]}→${match[2]}`);
  return [...published].slice(0, 4);
}

function toContainer(row, stats) {
  const labels = parseLabels(row.Labels);
  const memUsage = String(stats?.MemUsage ?? "").split("/");
  const running = row.State === "running";
  return {
    id: row.ID,
    name: row.Names,
    image: row.Image,
    state: row.State,
    status: row.Status,
    project: labels["com.docker.compose.project"] || "",
    service: labels["com.docker.compose.service"] || "",
    ports: shortPorts(row.Ports),
    running,
    hasStats: running && Boolean(stats),
    cpuPct: running ? parseFloat(stats?.CPUPerc) || 0 : 0,
    memPct: running ? parseFloat(stats?.MemPerc) || 0 : 0,
    memBytes: running ? parseBytes(memUsage[0]) : 0,
    memLimitBytes: running ? parseBytes(memUsage[1]) : 0,
    pids: running ? Number(stats?.PIDs) || 0 : 0,
  };
}

function containerOrder(a, b) {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (a.project !== b.project) return a.project.localeCompare(b.project);
  return a.name.localeCompare(b.name);
}

export async function sampleContainers() {
  const ps = await exec("docker", ["ps", "-a", "--no-trunc", "--format", "{{json .}}"], { timeout: 8000 });
  if (ps.code !== 0) return { ok: false, error: (ps.stderr || "docker ps failed").trim().split("\n")[0], containers: [] };

  const rows = parseJsonLines(ps.stdout).slice(0, MAX_CONTAINERS);
  const hasRunning = rows.some(row => row.State === "running");
  const statsByName = new Map();
  if (hasRunning) {
    const stats = await exec("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { timeout: 10000 });
    for (const row of parseJsonLines(stats.stdout)) statsByName.set(row.Name, row);
  }

  const containers = rows.map(row => toContainer(row, statsByName.get(row.Names))).sort(containerOrder);
  return { ok: true, error: null, containers };
}

export async function runContainerAction(action, id) {
  const res = await exec("docker", [action, "--", id], { timeout: 30000 });
  return { ok: res.code === 0, error: res.code === 0 ? null : (res.stderr || `docker ${action} failed`).trim().split("\n")[0] };
}
