import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import { appHome, exec, readTextFile } from "herdr";
import { dataDirPath, ensurePrivateDataDir, secretFilePath } from "./node.js";

export const MAX_CONVERSATIONS = 50;
export const MAX_MESSAGES_PER_CHAT = 100;

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
let storageQueue = Promise.resolve();

function enqueueStorage(task) {
  const run = storageQueue.then(task, task);
  storageQueue = run.catch(() => null);
  return run;
}

function indexPath() {
  return `${dataDirPath()}/index.json`;
}

function chatsDirPath() {
  return `${dataDirPath()}/chats`;
}

function chatFilePath(chatId) {
  if (!SAFE_ID_RE.test(chatId)) throw new Error("Invalid conversation ID.");
  return `${chatsDirPath()}/${chatId}.json`;
}

async function writeJsonAtomic(targetPath, payload, mode = "600") {
  const dir = await ensurePrivateDataDir();
  const tempPath = `${dir}/.tmp-${randomUUID().slice(0, 10)}.json`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n");
  const moveRes = await exec(
    "sh",
    ["-c", 'chmod "$1" -- "$2" && mv -f -- "$2" "$3"', "_", mode, tempPath, targetPath],
    { timeout: 3000 },
  );
  if (moveRes.code !== 0) {
    await fs.unlink(tempPath).catch(() => null);
    throw new Error(`Failed to persist ${targetPath}`);
  }
}

async function unlinkChatMedia(chatObj) {
  if (!chatObj?.messages) return;
  const base = appHome();
  for (const msg of chatObj.messages) {
    for (const img of msg?.images || []) {
      if (img?.relPath?.startsWith("data/gemini-chat/media/")) {
        await fs.unlink(`${base}/${img.relPath}`).catch(() => null);
      }
    }
    for (const att of msg?.attachments || []) {
      if (att?.previewRelPath?.startsWith("data/gemini-chat/media/")) {
        await fs.unlink(`${base}/${att.previewRelPath}`).catch(() => null);
      }
    }
  }
}

export function createEmptyChat(model) {
  const now = Date.now();
  return {
    id: randomUUID().slice(0, 16),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    model,
    webContext: null,
    messages: [],
  };
}

export function deriveChatTitle(messages) {
  const firstUser = (messages || []).find(m => m.role === "user" && m.text?.trim());
  if (!firstUser) return "New chat";
  const singleLine = firstUser.text.trim().replace(/\s+/g, " ");
  return singleLine.length > 48 ? `${singleLine.slice(0, 47)}…` : singleLine;
}

export async function loadIndex() {
  const raw = await readTextFile(indexPath()).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && SAFE_ID_RE.test(String(item.id || "")))
      .slice(0, MAX_CONVERSATIONS);
  } catch {
    return [];
  }
}

export async function loadChat(chatId) {
  if (!SAFE_ID_RE.test(String(chatId || ""))) return null;
  const raw = await readTextFile(chatFilePath(chatId)).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.slice(-MAX_MESSAGES_PER_CHAT)
      : [];
    return {
      id: chatId,
      title: String(parsed.title || deriveChatTitle(messages)),
      createdAt: Number(parsed.createdAt || Date.now()),
      updatedAt: Number(parsed.updatedAt || Date.now()),
      model: parsed.model || "default",
      webContext: parsed.webContext || null,
      messages,
    };
  } catch {
    return null;
  }
}

export function saveChat(chat) {
  return enqueueStorage(async () => {
    const trimmedMessages = (chat.messages || []).slice(-MAX_MESSAGES_PER_CHAT).map(m => ({
      id: m.id,
      role: m.role,
      text: m.text || "",
      at: m.at || Date.now(),
      prevWebContext: m.prevWebContext || undefined,
      attachments: Array.isArray(m.attachments)
        ? m.attachments.map(a => ({ name: a.name, kind: a.kind, size: a.size, path: a.path, previewRelPath: a.previewRelPath || undefined }))
        : undefined,
      images: Array.isArray(m.images) && m.images.length
        ? m.images.map(img => ({ id: img.id, relPath: img.relPath, absPath: img.absPath, width: img.width, height: img.height, url: img.url }))
        : undefined,
      error: m.error || undefined,
    }));

    const normalized = {
      id: chat.id,
      title: chat.title && chat.title !== "New chat" ? chat.title : deriveChatTitle(trimmedMessages),
      createdAt: chat.createdAt || Date.now(),
      updatedAt: Date.now(),
      model: chat.model || "default",
      webContext: chat.webContext || null,
      messages: trimmedMessages,
    };

    await writeJsonAtomic(chatFilePath(normalized.id), normalized, "600");

    const diskIndex = await loadIndex();
    const meta = {
      id: normalized.id,
      title: normalized.title,
      updatedAt: normalized.updatedAt,
      messageCount: trimmedMessages.length,
      model: normalized.model,
    };

    const merged = [meta, ...diskIndex.filter(item => item.id !== normalized.id)];
    const kept = merged.slice(0, MAX_CONVERSATIONS);
    const evicted = merged.slice(MAX_CONVERSATIONS);
    for (const old of evicted) {
      const oldChat = await loadChat(old.id).catch(() => null);
      await unlinkChatMedia(oldChat);
      await fs.unlink(chatFilePath(old.id)).catch(() => null);
    }
    await writeJsonAtomic(indexPath(), kept, "600");
    return { chat: normalized, index: kept };
  });
}

export function deleteChatById(chatId) {
  return enqueueStorage(async () => {
    const existing = await loadChat(chatId).catch(() => null);
    await unlinkChatMedia(existing);
    await fs.unlink(chatFilePath(chatId)).catch(() => null);
    const diskIndex = await loadIndex();
    const nextIndex = diskIndex.filter(item => item.id !== chatId);
    await writeJsonAtomic(indexPath(), nextIndex, "600");
    return nextIndex;
  });
}

export function clearAllChats() {
  return enqueueStorage(async () => {
    const diskIndex = await loadIndex();
    for (const item of diskIndex) {
      const existing = await loadChat(item.id).catch(() => null);
      await unlinkChatMedia(existing);
      await fs.unlink(chatFilePath(item.id)).catch(() => null);
    }
    await writeJsonAtomic(indexPath(), [], "600");
    return [];
  });
}

export async function readSecretStatus() {
  const path = secretFilePath();
  let parsed = {};
  try {
    const raw = await readTextFile(path);
    if (raw) parsed = JSON.parse(raw);
  } catch {}
  return {
    hasWebPsid: Boolean(typeof parsed?.web?.psid === "string" && parsed.web.psid.trim()),
    hasWebPsidts: Boolean(typeof parsed?.web?.psidts === "string" && parsed.web.psidts.trim()),
    webProfileId: typeof parsed?.web?.profileId === "string" ? parsed.web.profileId : "",
    webUpdatedAt: Number(parsed?.web?.updatedAt || 0),
  };
}

export function saveWebSecrets(webPatch) {
  return enqueueStorage(async () => {
    const path = secretFilePath();
    let existing = {};
    try {
      const raw = await readTextFile(path);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
      }
    } catch {}

    const next = { ...existing };
    if (!webPatch) {
      delete next.web;
    } else {
      next.web = {
        profileId: String(webPatch.profileId || "manual"),
        psid: String(webPatch.psid || "").trim(),
        psidts: String(webPatch.psidts || "").trim(),
        updatedAt: Date.now(),
      };
    }

    await writeJsonAtomic(path, next, "600");
    return readSecretStatus();
  });
}
