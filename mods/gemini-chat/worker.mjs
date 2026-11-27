import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WORKER_IDLE_MS = 90_000;
const AUTH_TIMEOUT_MS = 5000;
const SHUTDOWN_DELETE_GRACE_MS = 3000;
const FETCH_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 180_000;
const MAX_WS_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_STREAM_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 5;
const MAX_MEDIA_FILES = 32;
const MAX_MEDIA_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 20;

const STREAMING_FLAG_INDEX = 7;
const TEMPORARY_CHAT_FLAG_INDEX = 45;
const FIELD_WEB_IMAGES = 1;
const FIELD_GENERATED_IMAGES = 7;

const GEMINI_WEB_APP_URL = "https://gemini.google.com/app";
const GEMINI_WEB_BATCH_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";
const GEMINI_WEB_STREAM_URL = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_WEB_UPLOAD_URL = "https://content-push.googleapis.com/upload";
const GEMINI_WEB_UPLOAD_FALLBACK_URL = "https://push.clients6.google.com/upload/";
const GEMINI_WEB_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb";
const BATCH_EXEC_HEADERS = {
  [MODEL_HEADER_KEY]: "[1,null,null,null,null,null,null,null,[4,5,6,8],null,null,null,null,null,null,null]",
  "x-goog-ext-73010989-jspb": "[0]",
};

const CARD_CONTENT_RE = /^https?:\/\/googleusercontent\.com\/card_content\/\d+/;
const ARTIFACTS_RE = /!?\[[^\]]*\]\(https?:\/\/googleusercontent\.com\/(?:\w+\/)+\w+\)\n*|https?:\/\/googleusercontent\.com\/(?:\w+\/)+\w+\n*/g;
const GENERATED_IMAGE_URL_RE = /^https:\/\/lh3\.googleusercontent\.com\/(?:gg|rd-gg|gg-dl|rd-gg-dl)\//i;
const FLICKER_ESC_RE = /\\+[`*_~].*$/;

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  html: "text/html",
  css: "text/css",
  xml: "application/xml",
  svg: "image/svg+xml",
};

let secretWriteQueue = Promise.resolve();

function formatError(err) {
  const base = err?.message || String(err);
  const cause = err?.cause?.message || err?.cause?.code;
  return cause && !base.includes(cause) ? `${base} (${cause})` : base;
}

function combineSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (raw.startsWith("--data-dir=")) args.dataDir = raw.slice("--data-dir=".length);
    else if (raw.startsWith("--secret-file=")) args.secretFile = raw.slice("--secret-file=".length);
    else if (raw.startsWith("--token-file=")) args.tokenFile = raw.slice("--token-file=".length);
    else if (raw.startsWith("--worker-info-file=")) args.workerInfoFile = raw.slice("--worker-info-file=".length);
  }
  return args;
}

function safeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function encodeWsFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function sendWsJson(socket, message) {
  if (socket.destroyed || !socket.writable) return;
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  socket.write(encodeWsFrame(0x1, payload));
}

function sendWsClose(socket, code = 1000, destroy = false) {
  if (!socket.destroyed && socket.writable) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    socket.write(encodeWsFrame(0x8, payload));
    socket.end();
  }
  if (destroy) socket.destroy();
}

function tryConsumeWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const rsv = first & 0x70;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLen = second & 0x7f;
  let offset = 2;

  if (rsv !== 0 || !masked) {
    const err = new Error("Protocol error");
    err.wsCode = 1002;
    throw err;
  }

  const isControl = opcode >= 0x8;
  if (isControl && (!fin || payloadLen > 125)) {
    const err = new Error("Invalid control frame");
    err.wsCode = 1002;
    throw err;
  }

  if (payloadLen === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLen = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLen = buffer.readBigUInt64BE(offset);
    if (bigLen > BigInt(MAX_WS_PAYLOAD_BYTES)) {
      const err = new Error("WebSocket frame too large");
      err.wsCode = 1009;
      throw err;
    }
    payloadLen = Number(bigLen);
    offset += 8;
  }

  if (payloadLen > MAX_WS_PAYLOAD_BYTES) {
    const err = new Error("WebSocket frame too large");
    err.wsCode = 1009;
    throw err;
  }
  if (buffer.length < offset + 4 + payloadLen) return null;

  const mask = buffer.subarray(offset, offset + 4);
  const rawPayload = buffer.subarray(offset + 4, offset + 4 + payloadLen);
  const unmasked = Buffer.allocUnsafe(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    unmasked[i] = rawPayload[i] ^ mask[i & 3];
  }

  return {
    fin,
    opcode,
    payload: unmasked,
    remaining: buffer.subarray(offset + 4 + payloadLen),
  };
}

function getNested(data, path, fallback = undefined) {
  let current = data;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") {
      const idx = key < 0 ? current.length + key : key;
      if (idx < 0 || idx >= current.length) return fallback;
      current = current[idx];
    } else if (current && typeof current === "object" && typeof key === "string" && key in current) {
      current = current[key];
    } else {
      return fallback;
    }
  }
  return current === null || current === undefined ? fallback : current;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function getField(container, index, fallback = null) {
  if (!Array.isArray(container) || container.length === 0) return fallback;
  let value = index >= 0 && index < container.length ? container[index] : null;
  if (value === null || value === undefined || isPlainObject(value) || (Array.isArray(value) && value.length === 0)) {
    const tail = container[container.length - 1];
    if (isPlainObject(tail)) {
      value = tail[String(index + 1)];
    }
  }
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return fallback;
  return value;
}

function getRichContentField(candidate, index, fallback = null) {
  return getField(getNested(candidate, [12], null), index, fallback);
}

class StreamingFrameParser {
  constructor() {
    this.buffer = "";
    this.expectedUnits = null;
    this.payloadStart = 0;
    this.prefixChecked = false;
  }

  feed(chunk) {
    if (chunk) {
      this.buffer += chunk;
      if (this.buffer.length > MAX_STREAM_BUFFER_BYTES) {
        this.buffer = this.buffer.slice(-MAX_STREAM_BUFFER_BYTES);
        this.expectedUnits = null;
        this.payloadStart = 0;
      }
    }

    if (!this.prefixChecked) {
      const trimmed = this.buffer.replace(/^\uFEFF/, "").trimStart();
      if (!trimmed) return [];
      if (trimmed.length < 4 && ")]}'".startsWith(trimmed)) return [];
      this.buffer = trimmed.startsWith(")]}'") ? trimmed.slice(4).trimStart() : trimmed;
      this.prefixChecked = true;
    }

    const frames = [];
    for (;;) {
      if (this.expectedUnits === null) {
        this.buffer = this.buffer.trimStart();
        if (!this.buffer) break;
        const match = /^(\d+)\r?\n/.exec(this.buffer);
        if (!match) {
          const nextNl = this.buffer.indexOf("\n");
          if (nextNl === -1) break;
          const line = this.buffer.slice(0, nextNl).trim();
          this.buffer = this.buffer.slice(nextNl + 1);
          if (line.startsWith("[")) {
            try {
              const parsedLine = JSON.parse(line);
              if (Array.isArray(parsedLine)) frames.push(...parsedLine);
            } catch {}
          }
          continue;
        }
        this.expectedUnits = Number(match[1]);
        this.payloadStart = match[1].length;
      }

      if (this.buffer.length < this.payloadStart + this.expectedUnits) break;
      const raw = this.buffer.slice(this.payloadStart, this.payloadStart + this.expectedUnits);
      const rest = this.buffer.slice(this.payloadStart + this.expectedUnits);
      const trimmed = raw.trim();

      let parsed = null;
      if (trimmed) {
        try { parsed = JSON.parse(trimmed); } catch {}
      }
      if (parsed !== null) {
        this.buffer = rest;
        this.expectedUnits = null;
        this.payloadStart = 0;
        if (Array.isArray(parsed)) frames.push(...parsed);
        else frames.push(parsed);
        continue;
      }

      const nextNl = this.buffer.indexOf("\n", this.payloadStart + 1);
      this.buffer = nextNl === -1 ? "" : this.buffer.slice(nextNl + 1);
      this.expectedUnits = null;
      this.payloadStart = 0;
    }
    return frames;
  }

  flush() {
    const frames = this.feed("");
    if (!this.buffer.trim()) return frames;
    for (const rawLine of this.buffer.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("[")) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) frames.push(...parsed);
      } catch {}
    }
    this.buffer = "";
    this.expectedUnits = null;
    this.payloadStart = 0;
    return frames;
  }
}

async function readSecrets(secretFile) {
  try {
    const raw = await readFile(secretFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function updateRotatedPsidts(secretFile, nextPsidts, session = null) {
  if (!nextPsidts) return Promise.resolve();
  if (session?.webSecrets) {
    session.webSecrets.psidts = nextPsidts;
    session.cookieHeader = buildWebCookieHeader(session.webSecrets);
  }
  const job = async () => {
    const secrets = await readSecrets(secretFile);
    if (!secrets.web?.psid || secrets.web.psidts === nextPsidts) return;
    secrets.web = { ...secrets.web, psidts: nextPsidts, updatedAt: Date.now() };
    const dir = dirname(secretFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tempPath = join(dir, `.gemini-secret-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tempPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, secretFile);
      await chmod(secretFile, 0o600);
    } catch (err) {
      await unlink(tempPath).catch(() => null);
      throw err;
    }
  };
  secretWriteQueue = secretWriteQueue.then(job, job).catch(() => null);
  return secretWriteQueue;
}

function buildWebCookieHeader(webSecrets) {
  const parts = [`__Secure-1PSID=${webSecrets.psid}`];
  if (webSecrets.psidts) parts.push(`__Secure-1PSIDTS=${webSecrets.psidts}`);
  return parts.join("; ");
}

function extractRotatedPsidts(headers) {
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const cookie of setCookies) {
    const match = /^__Secure-1PSIDTS=([^;]+)/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchGeminiWebSession(webSecrets, secretFile, signal) {
  const response = await fetch(GEMINI_WEB_APP_URL, {
    headers: {
      cookie: buildWebCookieHeader(webSecrets),
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: combineSignal(signal, FETCH_TIMEOUT_MS),
  });
  const rotated = extractRotatedPsidts(response.headers);
  if (rotated) await updateRotatedPsidts(secretFile, rotated);
  if (!response.ok) {
    throw new Error(`Gemini Web returned HTTP ${response.status} while loading session.`);
  }
  const html = await response.text();
  const snlmMatch = /"SNlM0e":"([^"]+)"/.exec(html);
  if (!snlmMatch?.[1]) {
    throw new Error("SESSION_EXPIRED: Gemini Web session expired or cookies are invalid. Copy cookies from Chrome again in Settings.");
  }
  const blMatch = /"cfb2h":"([^"]+)"/.exec(html);
  const fsidMatch = /"FdrFJe":"([^"]+)"/.exec(html);
  const currentSecrets = { psid: webSecrets.psid, psidts: rotated || webSecrets.psidts || "" };
  return {
    snlm0e: snlmMatch[1],
    bl: blMatch?.[1] || "",
    fsid: fsidMatch?.[1] || "",
    sessionId: randomUUID(),
    webSecrets: currentSecrets,
    cookieHeader: buildWebCookieHeader(currentSecrets),
  };
}

function computeModelCapacity(tierFlags, capabilityFlags) {
  const tiers = Array.isArray(tierFlags) ? tierFlags : [];
  const caps = Array.isArray(capabilityFlags) ? capabilityFlags : [];
  if (tiers.includes(21)) return { capacity: 1, capacityField: 13 };
  if (tiers.includes(22)) return { capacity: 2, capacityField: 13 };
  if (caps.includes(115)) return { capacity: 4, capacityField: 12 };
  if (tiers.includes(16) || caps.includes(106)) return { capacity: 3, capacityField: 12 };
  if (tiers.includes(8) || caps.includes(19)) return { capacity: 2, capacityField: 12 };
  return { capacity: 1, capacityField: 12 };
}

function safePositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback;
}

function buildModelHeaders(modelSpec, sessionId) {
  const id = typeof modelSpec?.id === "string" ? modelSpec.id.trim() : "";
  if (!id || id === "default") return {};
  const capacity = safePositiveInt(modelSpec.capacity, 1);
  const capacityField = safePositiveInt(modelSpec.capacityField, 12);
  const modelNumber = safePositiveInt(modelSpec.modelNumber, 1);
  const headerArray = capacityField === 13
    ? [1, null, null, null, id, null, null, 0, [4, 5, 6, 8], null, null, null, capacity, null, null, modelNumber, 1, sessionId || randomUUID()]
    : [1, null, null, null, id, null, null, 0, [4, 5, 6, 8], null, null, capacity, null, null, modelNumber, 1, sessionId || randomUUID()];
  return {
    [MODEL_HEADER_KEY]: JSON.stringify(headerArray),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0,0,0]",
  };
}

async function batchExecute(session, secretFile, rpcId, payloadStr, signal) {
  const form = new URLSearchParams();
  form.set("at", session.snlm0e);
  form.set("f.req", JSON.stringify([[[rpcId, payloadStr, null, "generic"]]]));
  const params = new URLSearchParams({
    rpcids: rpcId,
    "source-path": "/app",
    hl: "en",
    _reqid: String(Math.floor(100000 + Math.random() * 899999)),
    rt: "c",
  });
  if (session.bl) params.set("bl", session.bl);
  if (session.fsid) params.set("f.sid", session.fsid);

  const response = await fetch(`${GEMINI_WEB_BATCH_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      cookie: session.cookieHeader,
      origin: "https://gemini.google.com",
      referer: "https://gemini.google.com/",
      "x-same-domain": "1",
      "user-agent": DEFAULT_USER_AGENT,
      ...BATCH_EXEC_HEADERS,
    },
    body: form.toString(),
    signal: combineSignal(signal, FETCH_TIMEOUT_MS),
  });

  const rotated = extractRotatedPsidts(response.headers);
  if (rotated) await updateRotatedPsidts(secretFile, rotated, session);
  if (!response.ok) {
    throw new Error(`Gemini Web RPC ${rpcId} failed with HTTP ${response.status}.`);
  }

  const parser = new StreamingFrameParser();
  const text = await response.text();
  return [...parser.feed(text), ...parser.flush()];
}

async function listGeminiWebModels(req, secretFile, send, signal) {
  const secrets = await readSecrets(secretFile);
  if (!secrets.web?.psid) {
    throw new Error("Gemini Web cookies not configured. Copy cookies from Chrome first.");
  }

  const session = await fetchGeminiWebSession(secrets.web, secretFile, signal);
  const frames = await batchExecute(session, secretFile, "otAQ7b", "[]", signal);
  const discovered = [];
  const seenIds = new Set();

  for (const part of frames) {
    if (!Array.isArray(part) || part[0] !== "wrb.fr" || part[1] !== "otAQ7b" || typeof part[2] !== "string") continue;
    let body;
    try { body = JSON.parse(part[2]); } catch { continue; }
    const modelsList = getNested(body, [15], null);
    if (!Array.isArray(modelsList)) continue;

    const { capacity, capacityField } = computeModelCapacity(getNested(body, [16], []), getNested(body, [17], []));
    for (const item of modelsList) {
      if (!Array.isArray(item) || discovered.length >= MAX_DISCOVERED_MODELS) continue;
      const modelId = getNested(item, [0], "");
      if (typeof modelId !== "string" || !modelId || seenIds.has(modelId)) continue;
      seenIds.add(modelId);

      const label = String(getNested(item, [11], "") || getNested(item, [19], "") || getNested(item, [1], "") || modelId).trim();
      const description = String(getNested(item, [12], "") || getNested(item, [2], "") || "").trim();
      const rawNumber = getNested(item, [17], null);
      const secondaryNumber = getNested(item, [9], null);
      const modelNumber = typeof rawNumber === "number" ? rawNumber : (typeof secondaryNumber === "number" ? secondaryNumber : 1);

      discovered.push({
        id: modelId,
        label,
        description,
        capacity,
        capacityField,
        modelNumber,
      });
    }
    if (discovered.length > 0) break;
  }

  const models = discovered.length > 0
    ? discovered
    : [{ id: "default", label: "Auto", description: "Account default on gemini.google.com", capacity: 1, capacityField: 12, modelNumber: 1 }];
  send({ type: "models", reqId: req.reqId, models, discoveredCount: discovered.length });
}

async function deleteGeminiWebChat(cid, secretFile, signal) {
  if (!cid || typeof cid !== "string") return;
  const secrets = await readSecrets(secretFile);
  if (!secrets.web?.psid) return;
  const session = await fetchGeminiWebSession(secrets.web, secretFile, signal);
  await batchExecute(session, secretFile, "GzXR5e", JSON.stringify([cid]), signal).catch(() => null);
}

function guessMimeType(filename) {
  const ext = String(filename || "").includes(".") ? filename.split(".").pop().toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

async function uploadAttachmentToGeminiWeb(att, session, signal) {
  if (!att?.path) return null;
  const fileName = att.name || "file";
  const fileStat = await stat(att.path);
  if (!fileStat.isFile()) {
    throw new Error(`"${fileName}" is not a regular file.`);
  }
  if (fileStat.size <= 0) {
    throw new Error(`"${fileName}" is empty.`);
  }
  if (fileStat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`"${fileName}" exceeds the 10 MB upload limit.`);
  }

  const bytes = await readFile(att.path);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`"${fileName}" exceeds the 10 MB upload limit.`);
  }

  const mimeType = guessMimeType(fileName);
  const endpoints = [
    {
      url: GEMINI_WEB_UPLOAD_URL,
      headers: {
        origin: "https://gemini.google.com",
        referer: "https://gemini.google.com/",
        "x-tenant-id": "bard-storage",
        "push-id": GEMINI_WEB_UPLOAD_PUSH_ID,
        cookie: session.cookieHeader,
        "user-agent": DEFAULT_USER_AGENT,
      },
    },
    {
      url: GEMINI_WEB_UPLOAD_FALLBACK_URL,
      headers: {
        origin: "https://gemini.google.com",
        referer: "https://gemini.google.com/",
        "push-id": GEMINI_WEB_UPLOAD_PUSH_ID,
        "user-agent": DEFAULT_USER_AGENT,
      },
    },
  ];

  let lastError = "unknown";
  for (const target of endpoints) {
    try {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), fileName);
      const res = await fetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: form,
        redirect: "follow",
        signal: combineSignal(signal, FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const uploadPath = (await res.text()).trim();
      if (uploadPath) return [[uploadPath], fileName];
      lastError = "empty upload reference";
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = formatError(err);
    }
  }
  throw new Error(`Upload failed for "${fileName}" (${lastError}).`);
}

function detectImageMeta(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) {
    return { ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { ext: "jpg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (i + 3 >= buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return { ext: "jpg", width: 1024, height: 1024 };
  }
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buf.length >= 30) {
      const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
      const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
      return { ext: "webp", width, height };
    }
    return { ext: "webp", width: 1024, height: 1024 };
  }
  if (buf.subarray(0, 3).toString("ascii") === "GIF" && buf.length >= 10) {
    return { ext: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  return null;
}

async function collectProtectedMediaNames(dataDir, extraProtected = []) {
  const protectedNames = new Set(extraProtected);
  const chatsDir = join(dataDir, "chats");
  try {
    const chatFiles = await readdir(chatsDir);
    for (const file of chatFiles) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(join(chatsDir, file), "utf8").catch(() => null);
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      for (const msg of parsed?.messages || []) {
        for (const img of msg?.images || []) {
          const tail = String(img?.relPath || "").split("/").pop();
          if (tail) protectedNames.add(tail);
        }
        for (const att of msg?.attachments || []) {
          const tail = String(att?.previewRelPath || "").split("/").pop();
          if (tail) protectedNames.add(tail);
        }
      }
    }
  } catch {}
  return protectedNames;
}

async function pruneMediaDir(mediaDir, dataDir, extraProtected = []) {
  try {
    const names = await readdir(mediaDir);
    const protectedNames = await collectProtectedMediaNames(dataDir, extraProtected);
    const entries = [];
    let totalBytes = 0;
    for (const name of names) {
      const full = join(mediaDir, name);
      const st = await stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;
      totalBytes += st.size;
      entries.push({ name, full, size: st.size, mtimeMs: st.mtimeMs, isProtected: protectedNames.has(name) });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let remainingCount = entries.length;
    for (const item of entries) {
      if (remainingCount <= MAX_MEDIA_FILES && totalBytes <= MAX_MEDIA_TOTAL_BYTES) break;
      if (item.isProtected) continue;
      await unlink(item.full).catch(() => null);
      remainingCount--;
      totalBytes -= item.size;
    }
  } catch {}
}

function collectFallbackImageUrls(node, foundSet, depth = 0) {
  if (depth > 12 || foundSet.size >= 6 || !node) return;
  if (typeof node === "string") {
    if (GENERATED_IMAGE_URL_RE.test(node)) foundSet.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectFallbackImageUrls(child, foundSet, depth + 1);
  } else if (typeof node === "object") {
    for (const val of Object.values(node)) collectFallbackImageUrls(val, foundSet, depth + 1);
  }
}

function extractImagesFromCandidate(candidate) {
  const urls = new Map();

  const genField = getRichContentField(candidate, FIELD_GENERATED_IMAGES, null);
  const genList = getNested(genField, [0], []);
  if (Array.isArray(genList)) {
    for (const item of genList) {
      const url = getNested(item, [0, 3, 3], "");
      if (typeof url === "string" && url.startsWith("https://")) {
        urls.set(url, { url, isGenerated: true, alt: String(getNested(item, [0, 3, 2], "") || "") });
      }
    }
  }

  const webList = getRichContentField(candidate, FIELD_WEB_IMAGES, []);
  if (Array.isArray(webList)) {
    for (const item of webList) {
      const url = getNested(item, [0, 0, 0], "");
      if (typeof url === "string" && url.startsWith("https://") && !urls.has(url)) {
        urls.set(url, { url, isGenerated: false, alt: String(getNested(item, [0, 4], "") || "") });
      }
    }
  }

  if (urls.size === 0) {
    const fallback = new Set();
    collectFallbackImageUrls(getNested(candidate, [12], candidate), fallback);
    for (const url of fallback) {
      urls.set(url, { url, isGenerated: true, alt: "" });
    }
  }

  return Array.from(urls.values());
}

function isGoogleCookieHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "google.com"
    || host.endsWith(".google.com")
    || host === "googleusercontent.com"
    || host.endsWith(".googleusercontent.com");
}

async function fetchImageBytesSafely(rawUrl, cookieHeader, signal) {
  let currentUrl;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (currentUrl.protocol !== "https:") return null;

  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const headers = { "user-agent": DEFAULT_USER_AGENT };
    if (isGoogleCookieHost(currentUrl.hostname)) {
      headers.cookie = cookieHeader;
      headers.origin = "https://gemini.google.com";
      headers.referer = "https://gemini.google.com/";
    }

    const res = await fetch(currentUrl.toString(), {
      headers,
      redirect: "manual",
      signal: combineSignal(signal, FETCH_TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== "https:") return null;
      currentUrl = nextUrl;
      continue;
    }

    if (!res.ok || !res.body) return null;
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > MAX_IMAGE_DOWNLOAD_BYTES) return null;

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => null);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }
  return null;
}

async function downloadImages(entries, session, dataDir, signal) {
  if (!entries.length) return [];
  const mediaDir = join(dataDir, "media");
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const results = [];
  const newlySavedNames = [];

  for (const entry of entries.slice(0, 4)) {
    let targetUrl = entry.url;
    if (entry.isGenerated && !targetUrl.includes("=s")) {
      targetUrl = `${targetUrl}=s1024-rj`;
    }
    try {
      const bytes = await fetchImageBytesSafely(targetUrl, session.cookieHeader, signal);
      const meta = detectImageMeta(bytes);
      if (!meta) continue;
      const id = randomBytes(6).toString("hex");
      const fileName = `gen-${id}.${meta.ext}`;
      const absPath = join(mediaDir, fileName);
      await writeFile(absPath, bytes, { mode: 0o600 });
      newlySavedNames.push(fileName);
      results.push({
        id,
        relPath: `data/gemini-chat/media/${fileName}`,
        absPath,
        width: meta.width || 1024,
        height: meta.height || 1024,
        alt: entry.alt || "",
        url: targetUrl,
      });
    } catch {}
  }

  await pruneMediaDir(mediaDir, dataDir, newlySavedNames);
  return results;
}

function cleanResponseText(rawText, isFinal) {
  let cleaned = String(rawText || "").replace(ARTIFACTS_RE, "").replace(/\n{3,}/g, "\n\n");
  if (!isFinal) {
    cleaned = cleaned.replace(/\n```$/, "").replace(FLICKER_ESC_RE, "");
  }
  return cleaned.trimEnd();
}

function parseCandidateEnvelope(envelope) {
  if (!Array.isArray(envelope) || envelope[0] !== "wrb.fr" || typeof envelope[2] !== "string") return null;
  let inner;
  try { inner = JSON.parse(envelope[2]); } catch { return null; }
  if (!Array.isArray(inner)) return null;

  const meta = Array.isArray(inner[1]) ? inner[1] : [];
  const candidates = Array.isArray(inner[4]) ? inner[4] : [];
  const firstCandidate = candidates[0];
  if (!Array.isArray(firstCandidate)) return null;

  const rcid = typeof firstCandidate[0] === "string" ? firstCandidate[0] : null;
  let rawText = getNested(firstCandidate, [1, 0], null);
  if (typeof rawText === "string" && CARD_CONTENT_RE.test(rawText)) {
    rawText = getNested(firstCandidate, [22, 0], rawText);
  }
  const images = extractImagesFromCandidate(firstCandidate);
  const completionStatus = getNested(firstCandidate, [8, 0], null);

  if (rawText === null && images.length === 0) return null;
  return {
    rawText: typeof rawText === "string" ? rawText : null,
    images,
    isFinal: completionStatus === 2,
    cid: typeof meta[0] === "string" ? meta[0] : null,
    rid: typeof meta[1] === "string" ? meta[1] : null,
    rcid,
  };
}

async function streamGeminiWeb(req, dataDir, secretFile, send, signal) {
  const secrets = await readSecrets(secretFile);
  if (!secrets.web?.psid) {
    throw new Error("Gemini Web cookies not configured. Open Settings, pick your Chrome profile, and click Copy cookies from profile.");
  }

  const session = await fetchGeminiWebSession(secrets.web, secretFile, signal);
  const uploadedFiles = [];
  for (const att of req.attachments || []) {
    const uploaded = await uploadAttachmentToGeminiWeb(att, session, signal);
    if (uploaded) uploadedFiles.push(uploaded);
  }

  const lastMsg = (req.messages || []).filter(m => m.role === "user").pop();
  const promptText = (lastMsg?.text || "").trim() || "Analyze the attached file(s).";
  const ctx = req.webContext || {};
  const metadata = [ctx.cid || "", ctx.rid || "", ctx.rcid || "", null, null, null, null, null, null, ""];
  const messageContent = [
    promptText,
    0,
    null,
    uploadedFiles.length ? uploadedFiles : null,
    null,
    null,
    0,
  ];

  const innerReq = new Array(81).fill(null);
  const uuidVal = randomUUID().toUpperCase();
  const modelNumber = safePositiveInt(req.modelSpec?.modelNumber, 1);
  innerReq[0] = messageContent;
  innerReq[1] = ["en"];
  innerReq[2] = metadata;
  innerReq[6] = [1];
  innerReq[STREAMING_FLAG_INDEX] = 1;
  innerReq[10] = 1;
  innerReq[11] = 0;
  innerReq[17] = [[0]];
  innerReq[18] = 0;
  innerReq[27] = 1;
  innerReq[30] = [4];
  innerReq[41] = [1];
  if (req.temporary) {
    innerReq[TEMPORARY_CHAT_FLAG_INDEX] = 1;
  }
  innerReq[53] = 0;
  innerReq[59] = uuidVal;
  innerReq[61] = [];
  innerReq[68] = 1;
  innerReq[79] = modelNumber;
  innerReq[80] = 1;

  const fReq = JSON.stringify([null, JSON.stringify(innerReq)]);
  const form = new URLSearchParams();
  form.set("at", session.snlm0e);
  form.set("f.req", fReq);

  const params = new URLSearchParams({
    hl: "en",
    _reqid: String(Math.floor(100000 + Math.random() * 899999)),
    rt: "c",
  });
  if (session.bl) params.set("bl", session.bl);
  if (session.fsid) params.set("f.sid", session.fsid);

  const modelHeaders = buildModelHeaders(req.modelSpec, session.sessionId);
  const headers = {
    "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    cookie: session.cookieHeader,
    origin: "https://gemini.google.com",
    referer: "https://gemini.google.com/",
    "x-same-domain": "1",
    "x-goog-ext-525005358-jspb": `["${uuidVal}",1]`,
    "user-agent": DEFAULT_USER_AGENT,
    ...modelHeaders,
  };

  const response = await fetch(`${GEMINI_WEB_STREAM_URL}?${params.toString()}`, {
    method: "POST",
    headers,
    body: form.toString(),
    signal: combineSignal(signal, STREAM_TIMEOUT_MS),
  });

  const rotated = extractRotatedPsidts(response.headers);
  if (rotated) await updateRotatedPsidts(secretFile, rotated, session);
  if (!response.ok) {
    throw new Error(`Gemini Web HTTP ${response.status}: session may have expired. Re-import cookies in Settings.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new StreamingFrameParser();
  let emittedText = "";
  let latestRawText = "";
  const discoveredImages = new Map();
  const nextContext = { cid: ctx.cid || "", rid: ctx.rid || "", rcid: ctx.rcid || "" };

  const handleFrames = frames => {
    for (const envelope of frames) {
      const parsed = parseCandidateEnvelope(envelope);
      if (!parsed) continue;
      if (parsed.cid) nextContext.cid = parsed.cid;
      if (parsed.rid) nextContext.rid = parsed.rid;
      if (parsed.rcid) nextContext.rcid = parsed.rcid;
      for (const img of parsed.images) {
        if (!discoveredImages.has(img.url)) discoveredImages.set(img.url, img);
      }
      if (parsed.rawText === null) continue;
      latestRawText = parsed.rawText;
      const cleaned = cleanResponseText(parsed.rawText, parsed.isFinal);
      if (cleaned.length > emittedText.length && cleaned.startsWith(emittedText)) {
        const delta = cleaned.slice(emittedText.length);
        emittedText = cleaned;
        send({ type: "delta", reqId: req.reqId, text: delta });
      } else if (cleaned !== emittedText) {
        emittedText = cleaned;
        send({ type: "replace", reqId: req.reqId, text: cleaned });
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    handleFrames(parser.feed(decoder.decode(value, { stream: true })));
  }
  handleFrames(parser.feed(decoder.decode()));
  handleFrames(parser.flush());

  if (latestRawText) {
    const finalText = cleanResponseText(latestRawText, true);
    if (finalText !== emittedText) {
      emittedText = finalText;
      send({ type: "replace", reqId: req.reqId, text: finalText });
    }
  }

  const images = await downloadImages(Array.from(discoveredImages.values()), session, dataDir, signal);
  if (images.length > 0) {
    send({ type: "images", reqId: req.reqId, images });
  }

  if (!emittedText && images.length === 0) {
    throw new Error("Gemini Web returned no text (protocol response changed or session needs refresh).");
  }
  send({ type: "done", reqId: req.reqId, webContext: nextContext });
}

async function removeOwnedWorkerInfo(workerInfoPath) {
  try {
    const raw = await readFile(workerInfoPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.pid === process.pid) {
      await rm(workerInfoPath, { force: true }).catch(() => null);
    }
  } catch {}
}

async function main() {
  const { dataDir, secretFile, tokenFile, workerInfoFile } = parseArgs(process.argv.slice(2));
  if (!dataDir || !secretFile || !tokenFile) {
    throw new Error("Missing required --data-dir, --secret-file, or --token-file argument.");
  }

  const authToken = (await readFile(tokenFile, "utf8")).trim();
  await unlink(tokenFile).catch(() => null);
  if (!authToken) throw new Error("Empty auth token.");

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const workerInfoPath = workerInfoFile || join(dataDir, "worker.json");

  const authenticatedClients = new Set();
  const allClients = new Set();
  const activeStreams = new Map();
  const pendingDeletes = new Set();
  let idleTimer = null;
  let shuttingDown = false;

  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const controller of activeStreams.values()) controller.abort();
    activeStreams.clear();
    for (const socket of allClients) sendWsClose(socket, 1001, true);
    allClients.clear();
    authenticatedClients.clear();
    server.close();
    if (pendingDeletes.size > 0) {
      await Promise.race([
        Promise.allSettled(Array.from(pendingDeletes)),
        new Promise(resolve => setTimeout(resolve, SHUTDOWN_DELETE_GRACE_MS)),
      ]);
    }
    await secretWriteQueue.catch(() => null);
    await removeOwnedWorkerInfo(workerInfoPath);
    process.exit(0);
  }

  function refreshIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (authenticatedClients.size > 0 || activeStreams.size > 0 || pendingDeletes.size > 0) return;
    idleTimer = setTimeout(() => { shutdown(); }, WORKER_IDLE_MS);
  }

  function handleClientMessage(socket, state, msg) {
    if (!state.authenticated) {
      if (msg?.type === "auth" && safeTokenMatch(msg.token, authToken)) {
        state.authenticated = true;
        if (state.authTimer) {
          clearTimeout(state.authTimer);
          state.authTimer = null;
        }
        authenticatedClients.add(socket);
        refreshIdleTimer();
        sendWsJson(socket, { type: "auth_ok" });
        return;
      }
      sendWsJson(socket, { type: "error", message: "Unauthorized" });
      sendWsClose(socket, 4001, true);
      return;
    }

    if (msg?.type === "ping") {
      sendWsJson(socket, { type: "pong" });
      return;
    }

    if (msg?.type === "shutdown") {
      shutdown();
      return;
    }

    if (msg?.type === "abort" && msg.reqId) {
      const controller = activeStreams.get(msg.reqId);
      if (controller) {
        controller.abort();
        activeStreams.delete(msg.reqId);
        sendWsJson(socket, { type: "aborted", reqId: msg.reqId });
      }
      refreshIdleTimer();
      return;
    }

    if (msg?.type === "delete_web_chat" && typeof msg.cid === "string") {
      const task = deleteGeminiWebChat(msg.cid, secretFile, null)
        .catch(() => null)
        .finally(() => {
          pendingDeletes.delete(task);
          refreshIdleTimer();
        });
      pendingDeletes.add(task);
      refreshIdleTimer();
      return;
    }

    if (msg?.type === "list_models" && msg.reqId) {
      if (activeStreams.has(msg.reqId)) return;
      const controller = new AbortController();
      activeStreams.set(msg.reqId, controller);
      refreshIdleTimer();
      const send = payload => sendWsJson(socket, payload);
      listGeminiWebModels(msg, secretFile, send, controller.signal)
        .catch(err => {
          if (controller.signal.aborted) return;
          send({ type: "error", reqId: msg.reqId, message: formatError(err) });
        })
        .finally(() => {
          if (activeStreams.get(msg.reqId) === controller) activeStreams.delete(msg.reqId);
          refreshIdleTimer();
        });
      return;
    }

    if (msg?.type !== "send" || !msg.reqId) return;
    if (activeStreams.has(msg.reqId)) {
      sendWsJson(socket, { type: "error", reqId: msg.reqId, message: "Duplicate request ID." });
      return;
    }
    const controller = new AbortController();
    activeStreams.set(msg.reqId, controller);
    refreshIdleTimer();

    const send = payload => sendWsJson(socket, payload);
    streamGeminiWeb(msg, dataDir, secretFile, send, controller.signal)
      .catch(err => {
        if (controller.signal.aborted) return;
        send({ type: "error", reqId: msg.reqId, message: formatError(err) });
      })
      .finally(() => {
        if (activeStreams.get(msg.reqId) === controller) activeStreams.delete(msg.reqId);
        refreshIdleTimer();
      });
  }

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    allClients.add(socket);
    const state = {
      authenticated: false,
      buffer: Buffer.alloc(0),
      fragments: null,
      fragmentBytes: 0,
      authTimer: setTimeout(() => {
        if (!state.authenticated) sendWsClose(socket, 4001, true);
      }, AUTH_TIMEOUT_MS),
    };

    socket.on("data", chunk => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      try {
        for (;;) {
          const frame = tryConsumeWsFrame(state.buffer);
          if (!frame) break;
          state.buffer = frame.remaining;

          if (frame.opcode === 0x8) {
            sendWsClose(socket, 1000, true);
            break;
          }
          if (frame.opcode === 0x9) {
            socket.write(encodeWsFrame(0xA, frame.payload));
            continue;
          }
          if (frame.opcode === 0xA) continue;

          if (frame.opcode === 0x1) {
            if (state.fragments) {
              const err = new Error("Unexpected new message mid-fragment");
              err.wsCode = 1002;
              throw err;
            }
            if (!frame.fin) {
              state.fragments = [frame.payload];
              state.fragmentBytes = frame.payload.length;
              continue;
            }
            let parsed;
            try { parsed = JSON.parse(frame.payload.toString("utf8")); } catch { continue; }
            handleClientMessage(socket, state, parsed);
            continue;
          }

          if (frame.opcode === 0x0) {
            if (!state.fragments) {
              const err = new Error("Unexpected continuation frame");
              err.wsCode = 1002;
              throw err;
            }
            state.fragmentBytes += frame.payload.length;
            if (state.fragmentBytes > MAX_WS_PAYLOAD_BYTES) {
              const err = new Error("Fragmented WebSocket message too large");
              err.wsCode = 1009;
              throw err;
            }
            state.fragments.push(frame.payload);
            if (frame.fin) {
              const full = Buffer.concat(state.fragments, state.fragmentBytes);
              state.fragments = null;
              state.fragmentBytes = 0;
              let parsed;
              try { parsed = JSON.parse(full.toString("utf8")); } catch { continue; }
              handleClientMessage(socket, state, parsed);
            }
            continue;
          }
        }
      } catch (err) {
        state.buffer = Buffer.alloc(0);
        state.fragments = null;
        state.fragmentBytes = 0;
        sendWsClose(socket, err?.wsCode || 1002, true);
      }
    });

    const onDisconnect = () => {
      if (state.authTimer) {
        clearTimeout(state.authTimer);
        state.authTimer = null;
      }
      allClients.delete(socket);
      authenticatedClients.delete(socket);
      refreshIdleTimer();
    };
    socket.on("close", onDisconnect);
    socket.on("error", onDisconnect);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const tempInfo = join(dataDir, `.worker-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tempInfo, JSON.stringify({ port: address.port, pid: process.pid, startedAt: Date.now() }) + "\n", { mode: 0o600 });
    await chmod(tempInfo, 0o600);
    await rename(tempInfo, workerInfoPath);
    await chmod(workerInfoPath, 0o600);
  } catch (err) {
    await unlink(tempInfo).catch(() => null);
    throw err;
  }
  refreshIdleTimer();
}

main().catch(err => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});
