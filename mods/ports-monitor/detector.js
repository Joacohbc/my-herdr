import { exec } from "herdr";

export const MAX_PORTS = 120;
export const MAX_PROBE_CACHE = 128;
export const MAX_HTTP_SHARED = 32;

const KNOWN_PORTS = {
  22: { proto: "SSH", service: "SSH", system: true },
  53: { proto: "DNS", service: "DNS", system: true },
  67: { proto: "UDP", service: "DHCP", system: true },
  68: { proto: "UDP", service: "DHCP", system: true },
  80: { proto: "HTTP", service: "HTTP", system: false },
  111: { proto: "TCP", service: "RPCBind", system: true },
  123: { proto: "UDP", service: "NTP", system: true },
  137: { proto: "UDP", service: "NetBIOS", system: true },
  138: { proto: "UDP", service: "NetBIOS", system: true },
  139: { proto: "TCP", service: "SMB", system: true },
  443: { proto: "HTTPS", service: "HTTPS", system: false },
  445: { proto: "TCP", service: "SMB", system: true },
  631: { proto: "HTTP", service: "CUPS", system: true },
  1433: { proto: "DB", service: "MSSQL", system: false },
  3000: { proto: "HTTP", service: "Dev HTTP", system: false },
  3001: { proto: "HTTP", service: "Dev HTTP", system: false },
  3306: { proto: "DB", service: "MySQL", system: false },
  4000: { proto: "HTTP", service: "Dev HTTP", system: false },
  4200: { proto: "HTTP", service: "Angular", system: false },
  4222: { proto: "MQ", service: "NATS", system: false },
  4321: { proto: "HTTP", service: "Astro", system: false },
  5000: { proto: "HTTP", service: "HTTP App", system: false },
  5054: { proto: "TCP", service: "Ulauncher", system: true },
  5173: { proto: "HTTP", service: "Vite", system: false },
  5174: { proto: "HTTP", service: "Vite", system: false },
  5353: { proto: "DNS", service: "mDNS", system: true },
  5432: { proto: "DB", service: "PostgreSQL", system: false },
  5672: { proto: "MQ", service: "RabbitMQ", system: false },
  6379: { proto: "DB", service: "Redis", system: false },
  8000: { proto: "HTTP", service: "HTTP App", system: false },
  8008: { proto: "HTTP", service: "HTTP App", system: false },
  8080: { proto: "HTTP", service: "HTTP App", system: false },
  8081: { proto: "HTTP", service: "HTTP App", system: false },
  8123: { proto: "DB", service: "ClickHouse", system: false },
  8443: { proto: "HTTPS", service: "HTTPS App", system: false },
  8888: { proto: "HTTP", service: "Jupyter/HTTP", system: false },
  9000: { proto: "HTTP", service: "MinIO/HTTP", system: false },
  9001: { proto: "HTTP", service: "MinIO Console", system: false },
  9090: { proto: "HTTP", service: "Prometheus", system: false },
  9092: { proto: "MQ", service: "Kafka", system: false },
  9099: { proto: "HTTP", service: "Firebase Auth", system: false },
  9200: { proto: "DB", service: "Elasticsearch", system: false },
  15672: { proto: "HTTP", service: "RabbitMQ UI", system: false },
  27017: { proto: "DB", service: "MongoDB", system: false },
  41641: { proto: "UDP", service: "Tailscale", system: true },
};

const SYSTEM_PROCESS_RE = /^(systemd|cupsd|avahi|dnsmasq|NetworkManager|wpa_supplicant|tailscaled|warp-svc|ulauncher|sshd|rpcbind|chronyd|ntpd)/i;
const INTERNAL_IPC_PROC_RE = /^(agy|claude|code|agent-browser|chrome|electron|herdr)/i;

function parseAddressPort(raw) {
  let clean = (raw ?? "").trim();
  if (!clean) return null;

  let iface = "";
  const pctIdx = clean.indexOf("%");
  if (pctIdx !== -1) {
    const colonAfter = clean.lastIndexOf(":");
    if (colonAfter > pctIdx) {
      iface = clean.slice(pctIdx + 1, colonAfter);
      clean = clean.slice(0, pctIdx) + clean.slice(colonAfter);
    }
  }

  let addr = "";
  let portStr = "";
  if (clean.startsWith("[")) {
    const closeIdx = clean.indexOf("]:");
    if (closeIdx === -1) return null;
    addr = clean.slice(1, closeIdx);
    portStr = clean.slice(closeIdx + 2);
  } else {
    const lastColon = clean.lastIndexOf(":");
    if (lastColon === -1) return null;
    addr = clean.slice(0, lastColon);
    portStr = clean.slice(lastColon + 1);
  }

  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { addr, port, iface };
}

function classifyExposure(addr, iface) {
  if (addr === "0.0.0.0" || addr === "*" || addr === "::") {
    return { label: addr === "::" ? "[::]" : "0.0.0.0", scope: "public", connectHost: "localhost" };
  }
  if (addr === "127.0.0.1" || addr === "::1") {
    return { label: "localhost", scope: "local", connectHost: "localhost" };
  }
  if (addr.startsWith("127.")) {
    return { label: addr, scope: "loopback", connectHost: addr };
  }
  if (addr.startsWith("224.") || addr.startsWith("239.") || addr.startsWith("ff")) {
    return { label: "multicast", scope: "multicast", connectHost: addr };
  }
  if (iface === "tailscale0" || addr.startsWith("100.")) {
    return { label: "tailscale", scope: "vpn", connectHost: addr };
  }
  return { label: addr, scope: "lan", connectHost: addr };
}

function isSystemEntry(port, addr, transport, procName, known) {
  if (known?.system) return true;
  if (SYSTEM_PROCESS_RE.test(procName)) return true;
  if (addr === "127.0.0.53" || addr === "127.0.0.54" || addr.startsWith("127.0.2.")) return true;
  if (addr.startsWith("224.") || addr.startsWith("239.")) return true;
  if (transport === "udp" && port >= 32768) return true;
  if (port < 1024 && port !== 80 && port !== 443) return true;
  return false;
}

export function parseSsOutput(stdout) {
  const lines = (stdout ?? "").split("\n");
  const dedup = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;

    const transport = cols[0].toLowerCase().startsWith("udp") ? "udp" : "tcp";
    const state = cols[1];
    if (transport === "tcp" && state !== "LISTEN") continue;

    const parsed = parseAddressPort(cols[4]);
    if (!parsed) continue;
    const { addr, port, iface } = parsed;

    let procName = "";
    let pid = null;
    const userMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (userMatch) {
      procName = userMatch[1];
      pid = Number.parseInt(userMatch[2], 10);
    }

    const exposure = classifyExposure(addr, iface);
    const key = `${transport}:${port}:${exposure.label}`;
    if (dedup.has(key)) {
      const existing = dedup.get(key);
      if (!existing.process && procName) {
        existing.process = procName;
        existing.pid = pid;
      }
      continue;
    }

    const known = KNOWN_PORTS[port] ?? null;
    const system = isSystemEntry(port, addr, transport, procName, known);
    const proto = known?.proto ?? (transport === "udp" ? "UDP" : "TCP");
    const service = known?.service ?? (procName || `${transport.toUpperCase()} :${port}`);
    const needsProbe = transport === "tcp"
      && !known
      && !system
      && !INTERNAL_IPC_PROC_RE.test(procName)
      && (exposure.scope === "local" || exposure.scope === "public");

    dedup.set(key, {
      key,
      transport,
      port,
      addr,
      exposure,
      process: procName,
      pid,
      proto,
      service,
      system,
      needsProbe,
      url: proto === "HTTP" || proto === "HTTPS"
        ? `${proto.toLowerCase()}://${exposure.connectHost}:${port}`
        : null,
    });
  }

  return Array.from(dedup.values())
    .sort((a, b) => {
      if (a.system !== b.system) return a.system ? 1 : -1;
      const aHttp = a.proto === "HTTP" || a.proto === "HTTPS" ? 0 : 1;
      const bHttp = b.proto === "HTTP" || b.proto === "HTTPS" ? 0 : 1;
      if (aHttp !== bHttp) return aHttp - bHttp;
      return a.port - b.port;
    })
    .slice(0, MAX_PORTS);
}

export async function sampleListeningPorts() {
  const res = await exec("ss", ["-H", "-tulnp"], { timeout: 3000 });
  if (res.code !== 0) return [];
  return parseSsOutput(res.stdout);
}

export async function probeHttpProtocol(entry) {
  const host = entry.exposure?.connectHost || "127.0.0.1";
  const httpUrl = `http://${host}:${entry.port}/`;
  const r1 = await exec(
    "curl",
    ["-sS", "-I", "--max-time", "0.45", "--connect-timeout", "0.35", "-o", "/dev/null", "-w", "%{http_code}", "--", httpUrl],
    { timeout: 1500 },
  ).catch(() => null);

  const code1 = (r1?.stdout ?? "").trim();
  if (code1 && code1 !== "000") return "HTTP";

  const httpsUrl = `https://${host}:${entry.port}/`;
  const r2 = await exec(
    "curl",
    ["-ksS", "-I", "--max-time", "0.45", "--connect-timeout", "0.35", "-o", "/dev/null", "-w", "%{http_code}", "--", httpsUrl],
    { timeout: 1500 },
  ).catch(() => null);

  const code2 = (r2?.stdout ?? "").trim();
  if (code2 && code2 !== "000") return "HTTPS";
  return "TCP";
}

export function protocolIconPath(entry) {
  if (entry.system) return "mods/ports-monitor/icons/sys.svg";
  if (entry.proto === "HTTPS") return "mods/ports-monitor/icons/https.svg";
  if (entry.proto === "HTTP") return "mods/ports-monitor/icons/http.svg";
  if (entry.proto === "DB") return "mods/ports-monitor/icons/db.svg";
  if (entry.proto === "MQ") return "mods/ports-monitor/icons/mq.svg";
  if (entry.proto === "UDP" || entry.proto === "DNS") return "mods/ports-monitor/icons/udp.svg";
  return "mods/ports-monitor/icons/tcp.svg";
}

export function serviceIconSpec(entry) {
  const proc = (entry.process || "").toLowerCase();
  const svc = (entry.service || "").toLowerCase();

  if (svc.includes("vite") || entry.port === 5173 || entry.port === 5174) {
    return { path: "mods/files-search/micons/vite.svg", tint: false };
  }
  if (svc.includes("firebase") || entry.port === 9099) {
    return { path: "mods/files-search/micons/firebase.svg", tint: false };
  }
  if (svc.includes("angular") || entry.port === 4200) {
    return { path: "mods/files-search/micons/angular.svg", tint: false };
  }
  if (svc.includes("astro") || entry.port === 4321) {
    return { path: "mods/files-search/micons/astro.svg", tint: false };
  }
  if (svc.includes("jupyter") || entry.port === 8888) {
    return { path: "mods/files-search/micons/jupyter.svg", tint: false };
  }
  if (svc.includes("postgres") || entry.port === 5432) {
    return { path: "mods/system-monitor/icons/postgres.svg", tint: false };
  }
  if (svc.includes("mysql") || entry.port === 3306) {
    return { path: "mods/system-monitor/icons/mysql.svg", tint: false };
  }
  if (svc.includes("mongo") || entry.port === 27017) {
    return { path: "mods/system-monitor/icons/mongodb.svg", tint: false };
  }
  if (svc.includes("redis") || entry.port === 6379) {
    return { path: "mods/system-monitor/icons/redis.svg", tint: false };
  }
  if (svc.includes("rabbitmq") || entry.port === 5672 || entry.port === 15672) {
    return { path: "mods/system-monitor/icons/erlang.svg", tint: false };
  }
  if (proc.includes("agy") || proc.includes("antigravity")) {
    return { path: "icons/antigravity.svg", tint: false };
  }
  if (proc.includes("claude")) {
    return { path: "icons/claude.svg", tint: false };
  }
  if (proc === "code" || proc.includes("vscode")) {
    return { path: "mods/system-monitor/icons/vscode.svg", tint: false };
  }
  if (proc.includes("chrome")) {
    return { path: "mods/system-monitor/icons/google-chrome.svg", tint: false };
  }
  if (proc.includes("ulauncher")) {
    return { path: "mods/system-monitor/icons/ulauncher.svg", tint: false };
  }
  if (proc.includes("docker")) {
    return { path: "mods/system-monitor/icons/docker.svg", tint: false };
  }
  if (proc.includes("node") || proc.includes("mainthread")) {
    return { path: "mods/files-search/micons/nodejs.svg", tint: false };
  }
  if (proc.includes("python") || proc.includes("uvicorn") || proc.includes("gunicorn")) {
    return { path: "mods/system-monitor/icons/python.svg", tint: false };
  }
  if (proc.includes("java")) {
    return { path: "mods/system-monitor/icons/java.svg", tint: false };
  }
  if (proc === "go" || proc.includes("gopls")) {
    return { path: "mods/system-monitor/icons/go.svg", tint: false };
  }
  if (proc.includes("rust") || proc.includes("cargo")) {
    return { path: "mods/system-monitor/icons/rust.svg", tint: false };
  }
  if (!entry.system && entry.proto === "HTTP") {
    return { path: "mods/files-search/micons/http.svg", tint: false };
  }
  return { path: protocolIconPath(entry), tint: true };
}

export function buildSharedHttpList(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (e.system) continue;
    if (e.proto !== "HTTP" && e.proto !== "HTTPS") continue;
    const url = `${e.proto.toLowerCase()}://${e.exposure.connectHost}:${e.port}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      port: e.port,
      proto: e.proto,
      exposure: e.exposure.label,
      service: e.service,
      process: e.process || "",
    });
    if (out.length >= MAX_HTTP_SHARED) break;
  }
  return out;
}
