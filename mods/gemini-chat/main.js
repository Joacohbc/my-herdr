import { Buffer } from "buffer";
import { randomUUID } from "crypto";
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, Textarea, TextareaState, InputState, ScrollHandle } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  hc,
  appHome,
  pickFiles,
  theme,
  settings,
  window,
  layout,
  checking,
  run,
  shared,
  setShared,
  props,
  nextCommand,
  notify,
} from "herdr";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  saveCachedModels,
  resolveNode,
  listChromeProfiles,
  openGeminiInChrome,
  importChromeCookies,
  startWorkerConnection,
  pickFilesWithFallback,
  pasteClipboardImageToFile,
  stageAttachmentFile,
  cleanupStagedAttachment,
  MAX_ATTACHMENTS,
} from "./node.js";
import {
  createEmptyChat,
  loadIndex,
  loadChat,
  saveChat,
  deleteChatById,
  clearAllChats,
  readSecretStatus,
  saveWebSecrets,
  MAX_MESSAGES_PER_CHAT,
} from "./storage.js";
import { renderSettingsPanel } from "./settings-view.js";

const IDLE_EVICT_MS = 30_000;
const VISIBILITY_CHECK_MS = 15_000;
const STREAM_RENDER_THROTTLE_MS = 45;

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function isGeminiPanelVisible() {
  if (window()?.visible === false) return false;
  const root = layout();
  const panel = findLayoutNode(root, "panel");
  if (!panel || panel.hidden) return false;
  const body = findLayoutNode(root, "panel-body");
  return body?.active === "gemini";
}

function getActiveContext() {
  const activeSpace = spaces().find(s => s.active) ?? null;
  const focus = focused();
  const sameSpace = focus?.space === activeSpace?.id ? focus : null;
  const tabId = sameSpace?.tab ?? activeSpace?.tabs?.find(t => t.active)?.id ?? null;
  const allPanes = panes();
  const viewerMeta = shared("file-viewer.meta") ?? {};
  const tabPanes = tabId ? allPanes.filter(p => p.tab === tabId) : [];

  const activeViewer = tabPanes.find(p => p.pane === sameSpace?.pane && p.mod === "file-viewer")
    ?? tabPanes.find(p => p.mod === "file-viewer");
  const meta = activeViewer ? viewerMeta[activeViewer.pane] : null;
  const activeFilePath = meta?.file && meta?.root && !meta.on
    ? `${meta.root.replace(/\/+$/, "")}/${meta.file.replace(/^\/+/, "")}`
    : null;

  const terminalAddr = sameSpace?.terminal
    ?? tabPanes.find(p => p.focused && p.terminal)?.terminal
    ?? tabPanes.find(p => p.terminal)?.terminal
    ?? null;

  return { activeFilePath, activeFileName: meta?.file?.split("/").pop() ?? null, terminalAddr };
}

function extractPrimaryCodeBlock(markdown) {
  const match = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/.exec(markdown || "");
  return match?.[1]?.trim() || (markdown || "").trim();
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fitImageDimensions(width, height, maxW = 300, maxH = 260) {
  const w = Number(width) > 0 ? Number(width) : maxW;
  const h = Number(height) > 0 ? Number(height) : maxH;
  const scale = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(48, Math.round(w * scale)), h: Math.max(48, Math.round(h * scale)) };
}

export default class GeminiChat extends View {
  init(initialProps, cx) {
    this.initProps = (initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props();
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.composer = TextareaState.new({
      placeholder: "Ask Gemini Web… (Ctrl+Enter or Send)",
      rows: 2,
    });
    this.composer.set_auto_grow(2, 7);
    this.composer.set_soft_wrap(true);
    this.composer.on("submit", (e, cx) => {
      if (e?.shift) return;
      this.sendMessage(cx);
    });
    this.composer.on("paste_other", (_e, cx) => {
      this.pasteClipboardImage(cx);
    });

    this.config = defaultConfig();
    this.model = this.config.defaultModel;
    this.secretStatus = { hasWebPsid: false, hasWebPsidts: false, webProfileId: "", webUpdatedAt: 0 };
    this.chromeProfiles = [];
    this.index = [];
    this.chat = createEmptyChat(this.model);
    this.attachments = [];

    this.showHistory = false;
    this.showSettings = false;
    this.temporaryMode = false;
    this.confirmAction = null;
    this.editingMsgId = null;
    this.editInput = null;
    this.streaming = false;
    this.activeReqId = null;
    this.error = null;
    this.settingsNote = null;
    this.settingsNoteIsError = false;
    this.importingCookies = false;
    this.syncingModels = false;
    this.modelsReqId = null;
    this.nodePath = null;
    this.nodeError = null;
    this.workerConn = null;
    this.workerStartPromise = null;
    this.pendingRetryDraft = null;
    this.deltaFlushScheduled = false;
    this.chatLoadSeq = 0;
    this.closed = false;

    this.psidInput = null;
    this.psidtsInput = null;

    this.hiddenSince = null;
    this.evicted = false;
    this.restoring = false;
    this.lastGcSeq = Number(shared("herdr.gc")?.seq || 0);
    this.lastStatusSig = "";
    this.lastStreamNotifyAt = 0;

    if (checking()) return;

    cx.spawn(async cx => {
      await this.bootstrap(cx);
    });

    cx.spawn(async cx => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.composer?.focus();
          cx.notify();
        } else if (cmd === "open_settings") {
          this.openSettings(cx);
        }
      }
    });

    cx.timer.every(VISIBILITY_CHECK_MS, cx => this.checkLifecycle(cx));
  }

  async bootstrap(cx) {
    const seq = ++this.chatLoadSeq;
    const [config, secretStatus, index] = await Promise.all([
      loadConfig(),
      readSecretStatus(),
      loadIndex(),
    ]);
    if (this.closed || seq !== this.chatLoadSeq) return;
    this.config = config;
    this.secretStatus = secretStatus;
    this.index = index;
    if (this.chat.messages.length === 0 && !this.hasDraft() && !this.temporaryMode) {
      if (this.index.length > 0) {
        const latest = await loadChat(this.index[0].id);
        if (this.closed || seq !== this.chatLoadSeq) return;
        if (latest) {
          this.chat = latest;
          this.model = this.config.models.some(m => m.id === latest.model) ? latest.model : this.config.defaultModel;
        }
      } else {
        this.model = this.config.defaultModel;
        this.chat = createEmptyChat(this.model);
      }
    } else if (!this.config.models.some(m => m.id === this.model)) {
      this.model = this.config.defaultModel;
    }
    this.evicted = false;
    cx.notify();
  }

  currentModelEntry() {
    return (this.config.models || []).find(m => m.id === this.model)
      ?? this.config.models?.[0]
      ?? { id: "default", label: "Default", header: "" };
  }

  hasDraft() {
    const text = (this.composer?.value() ?? "").trim();
    return text.length > 0 || this.attachments.length > 0;
  }

  publishStatus(streaming, unread, cx) {
    const sig = `${streaming ? 1 : 0}:${unread ? 1 : 0}`;
    if (sig === this.lastStatusSig) return;
    this.lastStatusSig = sig;
    cx.spawn(async () => {
      await cx.sleep(0);
      setShared("gemini.status", { streaming, unread });
    });
  }

  async shutdownWorker(sendShutdown = true) {
    const conn = this.workerConn;
    this.workerConn = null;
    if (!conn?.ws) return;
    if (sendShutdown) {
      await conn.ws.write(JSON.stringify({ type: "shutdown" })).catch(() => null);
    }
    await conn.ws.close().catch(() => null);
  }

  cleanupTemporaryWebChat(cx) {
    const tempCid = this.chat?.temporary ? this.chat?.webContext?.cid : null;
    if (!tempCid) return;
    const conn = this.workerConn;
    if (conn?.ws) {
      cx.spawn(async () => {
        await conn.ws.write(JSON.stringify({ type: "delete_web_chat", cid: tempCid })).catch(() => null);
      });
    }
  }

  discardDraftAttachments(cx) {
    if (!this.attachments.length) return;
    const stale = this.attachments;
    this.attachments = [];
    cx.spawn(async () => {
      for (const att of stale) await cleanupStagedAttachment(att);
    });
  }

  toggleTemporaryMode(cx) {
    if (this.streaming) return;
    this.chatLoadSeq++;
    this.cleanupTemporaryWebChat(cx);
    this.discardDraftAttachments(cx);
    this.temporaryMode = !this.temporaryMode;
    this.cancelEditMessage();
    this.chat = { ...createEmptyChat(this.model), temporary: this.temporaryMode };
    if (this.temporaryMode) this.chat.title = "Temporary chat";
    this.error = null;
    this.showHistory = false;
    this.showSettings = false;
    this.confirmAction = null;
    this.composer?.focus();
    cx.notify();
  }

  evictCaches(cx) {
    const busy = this.streaming
      || this.importingCookies
      || this.syncingModels
      || this.hasDraft()
      || Boolean(this.editingMsgId)
      || (this.temporaryMode && this.chat.messages.length > 0);
    if (busy) return;
    this.cleanupTemporaryWebChat(cx);
    this.evicted = true;
    this.temporaryMode = false;
    this.chat = createEmptyChat(this.model);
    this.attachments = [];
    this.chromeProfiles = [];
    this.showHistory = false;
    this.confirmAction = null;
    this.cancelEditMessage();
    this.releaseSettingsInputs();
    this.showSettings = false;
    cx.spawn(async () => {
      await this.shutdownWorker(true);
    });
    cx.notify();
  }

  checkLifecycle(cx) {
    if (this.closed) return;
    const visible = isGeminiPanelVisible();
    const gcSeq = Number(shared("herdr.gc")?.seq || 0);
    if (gcSeq > this.lastGcSeq) {
      this.lastGcSeq = gcSeq;
      if (!visible && !this.evicted) {
        this.evictCaches(cx);
        return;
      }
    }
    if (visible) {
      this.hiddenSince = null;
      return;
    }
    if (!this.hiddenSince) {
      this.hiddenSince = Date.now();
      return;
    }
    if (!this.evicted && Date.now() - this.hiddenSince >= IDLE_EVICT_MS) {
      this.evictCaches(cx);
    }
  }

  scheduleRestore(cx) {
    if (this.restoring) return;
    this.restoring = true;
    cx.spawn(async cx => {
      await cx.sleep(0);
      try {
        await this.bootstrap(cx);
      } finally {
        this.restoring = false;
      }
    });
  }

  releaseSettingsInputs() {
    for (const key of ["psidInput", "psidtsInput"]) {
      if (!this[key]) continue;
      try { this[key].release(); } catch {}
      this[key] = null;
    }
  }

  openSettings(cx) {
    this.showSettings = true;
    this.showHistory = false;
    this.confirmAction = null;
    this.settingsNote = null;
    if (!this.psidInput) {
      this.psidInput = InputState.new({ placeholder: "__Secure-1PSID value" });
      this.psidInput.set_masked(true);
    }
    if (!this.psidtsInput) {
      this.psidtsInput = InputState.new({ placeholder: "__Secure-1PSIDTS value (optional)" });
      this.psidtsInput.set_masked(true);
    }
    cx.spawn(async cx => {
      this.secretStatus = await readSecretStatus();
      this.chromeProfiles = await listChromeProfiles();
      if (this.chromeProfiles.length > 0 && !this.chromeProfiles.some(p => p.id === this.config.chromeProfile)) {
        this.config.chromeProfile = this.chromeProfiles[0].id;
      }
      cx.notify();
      if (this.secretStatus.hasWebPsid && (this.config.models?.length ?? 0) <= 1) {
        this.syncModelsFromWeb(cx);
      }
    });
    cx.notify();
  }

  closeSettings(cx) {
    this.showSettings = false;
    this.settingsNote = null;
    this.releaseSettingsInputs();
    cx.notify();
  }

  setModel(modelId, cx) {
    this.model = modelId;
    this.config = { ...this.config, defaultModel: modelId };
    cx.spawn(async () => { await saveConfig(this.config).catch(() => null); });
    cx.notify();
  }

  selectChromeProfile(profileId, cx) {
    this.config = { ...this.config, chromeProfile: profileId };
    this.settingsNote = null;
    cx.spawn(async () => { await saveConfig(this.config).catch(() => null); });
    cx.notify();
  }

  openSelectedProfileInChrome(cx) {
    const profileId = this.config.chromeProfile || "Default";
    cx.spawn(async () => {
      await openGeminiInChrome(profileId).catch(() => null);
    });
  }

  async ensureNode() {
    if (this.nodePath) return this.nodePath;
    const resolved = await resolveNode(this.config.node);
    if (resolved.error) {
      this.nodeError = resolved.error;
      throw new Error(resolved.error);
    }
    this.nodeError = null;
    this.nodePath = resolved.path;
    return this.nodePath;
  }

  importCookiesFromProfile(cx) {
    if (this.importingCookies) return;
    const profileId = this.config.chromeProfile || "Default";
    this.importingCookies = true;
    this.settingsNote = null;
    this.settingsNoteIsError = false;
    cx.notify();

    cx.spawn(async cx => {
      try {
        const nodeBin = await this.ensureNode();
        const result = await importChromeCookies(nodeBin, profileId);
        if (!result.ok) {
          this.settingsNote = result.error || "Could not copy cookies.";
          this.settingsNoteIsError = true;
        } else {
          this.secretStatus = await readSecretStatus();
          this.error = null;
          this.settingsNote = `Copied from "${profileId}" (${result.hasPsidts ? "PSID + PSIDTS" : "PSID"}). Syncing live models…`;
          this.settingsNoteIsError = false;
          cx.notify();
          this.syncModelsFromWeb(cx);
        }
      } catch (err) {
        this.settingsNote = err?.message || String(err);
        this.settingsNoteIsError = true;
      } finally {
        this.importingCookies = false;
        cx.notify();
      }
    });
  }

  saveManualCookies(cx) {
    const psid = (this.psidInput?.value() ?? "").trim();
    const psidts = (this.psidtsInput?.value() ?? "").trim();
    if (!psid) {
      this.settingsNote = "Enter __Secure-1PSID first.";
      this.settingsNoteIsError = true;
      cx.notify();
      return;
    }
    this.psidInput?.set_value("");
    this.psidtsInput?.set_value("");
    cx.spawn(async cx => {
      this.secretStatus = await saveWebSecrets({
        profileId: this.config.chromeProfile || "manual",
        psid,
        psidts,
      });
      this.error = null;
      this.settingsNote = "Manual cookies saved securely (0600). Syncing live models…";
      this.settingsNoteIsError = false;
      cx.notify();
      this.syncModelsFromWeb(cx);
    });
  }

  syncModelsFromWeb(cx) {
    if (this.syncingModels || !this.secretStatus.hasWebPsid) return;
    const reqId = randomUUID().slice(0, 12);
    this.syncingModels = true;
    this.modelsReqId = reqId;
    cx.notify();

    cx.spawn(async cx => {
      try {
        const conn = await this.ensureWorker(cx);
        if (this.closed || this.modelsReqId !== reqId) return;
        await conn.ws.write(JSON.stringify({ type: "list_models", reqId }));
      } catch (err) {
        if (this.closed || this.modelsReqId !== reqId) return;
        this.syncingModels = false;
        this.modelsReqId = null;
        this.settingsNote = err?.message || String(err);
        this.settingsNoteIsError = true;
        cx.notify();
      }
    });
  }

  clearWebCookies(cx) {
    cx.spawn(async cx => {
      this.secretStatus = await saveWebSecrets(null);
      const resetModels = await saveCachedModels([]);
      this.config = { ...this.config, models: resetModels };
      this.model = resetModels[0].id;
      this.settingsNote = "Web cookies removed.";
      this.settingsNoteIsError = false;
      cx.notify();
    });
  }

  startNewChat(cx) {
    if (this.streaming) return;
    this.chatLoadSeq++;
    this.cleanupTemporaryWebChat(cx);
    this.discardDraftAttachments(cx);
    this.cancelEditMessage();
    this.chat = { ...createEmptyChat(this.model), temporary: this.temporaryMode };
    if (this.temporaryMode) this.chat.title = "Temporary chat";
    this.error = null;
    this.showHistory = false;
    this.confirmAction = null;
    this.composer?.focus();
    cx.notify();
  }

  selectChat(chatId, cx) {
    if (this.streaming) return;
    const seq = ++this.chatLoadSeq;
    this.cleanupTemporaryWebChat(cx);
    this.discardDraftAttachments(cx);
    this.temporaryMode = false;
    this.cancelEditMessage();
    this.showHistory = false;
    this.confirmAction = null;
    cx.spawn(async cx => {
      const loaded = await loadChat(chatId);
      if (this.closed || seq !== this.chatLoadSeq || !loaded) return;
      this.chat = loaded;
      this.model = this.config.models.some(m => m.id === loaded.model) ? loaded.model : this.config.defaultModel;
      this.error = null;
      cx.notify();
      await cx.sleep(0);
      this.scrollToLatest();
    });
  }

  confirmDestructive(cx) {
    if (this.streaming) return;
    const action = this.confirmAction;
    this.confirmAction = null;
    if (!action) return;
    const seq = ++this.chatLoadSeq;
    cx.spawn(async cx => {
      if (action.kind === "delete-chat" && action.id) {
        this.index = await deleteChatById(action.id);
        if (this.closed || seq !== this.chatLoadSeq) return;
        if (this.chat.id === action.id) {
          this.chat = this.index[0]
            ? (await loadChat(this.index[0].id)) ?? createEmptyChat(this.model)
            : createEmptyChat(this.model);
        }
      } else if (action.kind === "clear-all") {
        this.index = await clearAllChats();
        if (this.closed || seq !== this.chatLoadSeq) return;
        this.chat = createEmptyChat(this.model);
      }
      cx.notify();
    });
  }

  async attachPaths(paths, cx) {
    const uniquePaths = [];
    const seen = new Set(this.attachments.map(a => a.path));
    for (const absPath of paths || []) {
      if (!absPath || seen.has(absPath)) continue;
      seen.add(absPath);
      uniquePaths.push(absPath);
    }
    if (this.attachments.length >= MAX_ATTACHMENTS) {
      this.error = `At most ${MAX_ATTACHMENTS} attachments per message.`;
      cx.notify();
      return;
    }

    const candidates = uniquePaths.slice(0, MAX_ATTACHMENTS - this.attachments.length);
    for (const absPath of candidates) {
      try {
        const staged = await stageAttachmentFile(absPath);
        if (this.closed || this.attachments.length >= MAX_ATTACHMENTS || this.attachments.some(a => a.path === staged.path)) {
          await cleanupStagedAttachment(staged);
          continue;
        }
        this.attachments = [...this.attachments, staged];
        this.error = null;
      } catch (err) {
        this.error = err?.message || String(err);
      }
    }
    cx.notify();
  }

  pickAttachments(cx) {
    cx.spawn(async cx => {
      try {
        const picked = await pickFilesWithFallback(pickFiles);
        if (this.closed || !picked?.length) return;
        await this.attachPaths(picked, cx);
      } catch (err) {
        this.error = err?.message || "Could not open file picker.";
        cx.notify();
      }
    });
  }

  pasteClipboardImage(cx) {
    if (this.attachments.length >= MAX_ATTACHMENTS) {
      this.error = `At most ${MAX_ATTACHMENTS} attachments per message.`;
      cx.notify();
      return;
    }
    cx.spawn(async cx => {
      try {
        const staged = await pasteClipboardImageToFile();
        if (!staged) return;
        if (this.closed || this.attachments.length >= MAX_ATTACHMENTS) {
          await cleanupStagedAttachment(staged);
          return;
        }
        this.attachments = [...this.attachments, staged];
        this.error = null;
        cx.notify();
      } catch (err) {
        this.error = err?.message || String(err);
        cx.notify();
      }
    });
  }

  startEditMessage(msgId, cx) {
    if (this.streaming) return;
    const msg = this.chat.messages.find(m => m.id === msgId);
    if (!msg || msg.role !== "user") return;
    this.cancelEditMessage();
    this.editingMsgId = msg.id;
    this.editInput = TextareaState.new({ value: msg.text || "", rows: 2 });
    this.editInput.set_auto_grow(2, 8);
    this.editInput.set_soft_wrap(true);
    this.editInput.on("submit", (e, cx) => {
      if (e?.shift) return;
      this.submitEditMessage(cx);
    });
    this.editInput.focus();
    cx.notify();
  }

  cancelEditMessage(cx = null) {
    this.editingMsgId = null;
    if (this.editInput) {
      try { this.editInput.release(); } catch {}
      this.editInput = null;
    }
    if (cx) cx.notify();
  }

  submitEditMessage(cx) {
    if (this.streaming || !this.editInput || !this.editingMsgId) return;
    const idx = this.chat.messages.findIndex(m => m.id === this.editingMsgId);
    const msg = idx >= 0 ? this.chat.messages[idx] : null;
    if (!msg || msg.role !== "user") {
      this.cancelEditMessage(cx);
      return;
    }
    const nextText = (this.editInput.value() ?? "").trim();
    const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!nextText && !hasAttachments) return;

    this.cancelEditMessage();
    this.showHistory = false;
    this.confirmAction = null;
    this.error = null;
    this.chat.webContext = msg.prevWebContext ? { ...msg.prevWebContext } : null;
    const updatedUserMsg = {
      ...msg,
      text: nextText,
      at: Date.now(),
    };
    const assistantMsg = {
      id: randomUUID().slice(0, 12),
      role: "model",
      text: "",
      at: Date.now(),
      images: [],
    };
    this.chat.messages = [...this.chat.messages.slice(0, idx), updatedUserMsg, assistantMsg].slice(-MAX_MESSAGES_PER_CHAT);
    this.pendingRetryDraft = null;
    this.dispatchStreamRequest(updatedUserMsg.attachments || [], cx);
  }

  openImageInViewer(img) {
    if (!img?.relPath) return;
    const name = img.relPath.split("/").pop() || "gemini-image.png";
    run("tab.new", {
      name,
      mod: "file-viewer",
      props: { file: img.relPath, root: appHome(), on: null, tab: null, solo: true },
    });
  }

  attachActiveFile(cx) {
    const ctx = getActiveContext();
    if (!ctx.activeFilePath) return;
    cx.spawn(async cx => {
      await this.attachPaths([ctx.activeFilePath], cx);
    });
  }

  handleDrop(event, cx) {
    if (!event?.paths?.length) return;
    cx.spawn(async cx => {
      await this.attachPaths(event.paths, cx);
    });
  }

  handleKeyDown(event, cx) {
    if (event.keystroke === "escape" && this.editingMsgId) {
      this.cancelEditMessage(cx);
      cx.stop_propagation();
      return;
    }
    if (event.keystroke === "escape" && this.confirmAction) {
      this.confirmAction = null;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (event.keystroke === "escape" && this.showSettings) {
      this.closeSettings(cx);
      cx.stop_propagation();
      return;
    }
    if (event.keystroke === "escape" && this.showHistory) {
      this.showHistory = false;
      cx.stop_propagation();
      cx.notify();
    }
  }

  scrollToLatest() {
    const count = this.chat?.messages?.length ?? 0;
    if (count > 0 && this.scroll) {
      try { this.scroll.scroll_to_item(count - 1); } catch {}
    }
  }

  async ensureWorker(cx) {
    if (this.workerConn?.ws) return this.workerConn;
    if (this.workerStartPromise) return this.workerStartPromise;

    const promise = (async () => {
      const nodeBin = await this.ensureNode();
      const conn = await startWorkerConnection(nodeBin, cx);
      if (this.closed) {
        await conn.ws.write(JSON.stringify({ type: "shutdown" })).catch(() => null);
        await conn.ws.close().catch(() => null);
        throw new Error("Panel closed");
      }
      this.workerConn = conn;
      this.startWorkerReader(conn, cx);
      return conn;
    })().finally(() => {
      if (this.workerStartPromise === promise) this.workerStartPromise = null;
    });

    this.workerStartPromise = promise;
    return promise;
  }

  startWorkerReader(conn, cx) {
    if (conn.reading) return;
    conn.reading = true;
    cx.spawn(async cx => {
      try {
        for (;;) {
          if (this.closed || this.workerConn !== conn) break;
          const raw = await conn.ws.read();
          const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
          let msg;
          try { msg = JSON.parse(text); } catch { continue; }
          await this.handleWorkerEvent(msg, cx);
        }
      } catch {
        if (this.workerConn === conn) {
          this.workerConn = null;
          if (this.syncingModels) {
            this.syncingModels = false;
            this.modelsReqId = null;
            this.settingsNote = "Worker connection closed while syncing models.";
            this.settingsNoteIsError = true;
            cx.notify();
          }
          if (this.streaming) {
            this.finishStreamWithError("Worker connection closed unexpectedly.", cx);
          }
        }
      } finally {
        conn.reading = false;
      }
    });
  }

  scheduleDeltaFlush(cx) {
    if (this.deltaFlushScheduled) return;
    this.deltaFlushScheduled = true;
    cx.spawn(async cx => {
      await cx.sleep(STREAM_RENDER_THROTTLE_MS);
      this.deltaFlushScheduled = false;
      if (this.closed || !this.streaming) return;
      this.lastStreamNotifyAt = Date.now();
      this.scrollToLatest();
      cx.notify();
    });
  }

  async handleWorkerEvent(msg, cx) {
    if (this.closed) return;
    if (msg?.reqId && msg.reqId === this.modelsReqId) {
      this.syncingModels = false;
      this.modelsReqId = null;
      if (msg.type === "models" && Array.isArray(msg.models)) {
        const savedModels = await saveCachedModels(msg.models);
        if (this.closed) return;
        this.config = { ...this.config, models: savedModels };
        if (!savedModels.some(m => m.id === this.model)) {
          this.model = savedModels[0].id;
        }
        const count = Number(msg.discoveredCount || 0);
        this.settingsNote = count > 0
          ? `Synced ${count} live models from gemini.google.com.`
          : "Connected to gemini.google.com (using Auto default model).";
        this.settingsNoteIsError = false;
      } else if (msg.type === "error") {
        this.settingsNote = msg.message || "Could not sync models from gemini.google.com.";
        this.settingsNoteIsError = true;
      }
      cx.notify();
      return;
    }

    if (!msg?.reqId || msg.reqId !== this.activeReqId) return;
    const assistantMsg = this.chat.messages[this.chat.messages.length - 1];
    if (!assistantMsg || assistantMsg.role !== "model") return;

    if (msg.type === "delta" && typeof msg.text === "string") {
      this.pendingRetryDraft = null;
      assistantMsg.text += msg.text;
      const now = Date.now();
      if (now - this.lastStreamNotifyAt >= STREAM_RENDER_THROTTLE_MS) {
        this.lastStreamNotifyAt = now;
        this.scrollToLatest();
        cx.notify();
      } else {
        this.scheduleDeltaFlush(cx);
      }
      return;
    }

    if (msg.type === "replace" && typeof msg.text === "string") {
      this.pendingRetryDraft = null;
      assistantMsg.text = msg.text;
      this.scrollToLatest();
      cx.notify();
      return;
    }

    if (msg.type === "images" && Array.isArray(msg.images)) {
      this.pendingRetryDraft = null;
      assistantMsg.images = msg.images;
      this.scrollToLatest();
      cx.notify();
      return;
    }

    if (msg.type === "done" || msg.type === "aborted") {
      this.pendingRetryDraft = null;
      if (msg.webContext) this.chat.webContext = msg.webContext;
      const chatSnapshot = { ...this.chat, messages: [...this.chat.messages] };
      this.streaming = false;
      this.activeReqId = null;
      const visible = isGeminiPanelVisible();
      this.publishStatus(false, !visible, cx);
      this.scrollToLatest();
      cx.notify();

      if (!chatSnapshot.temporary) {
        const saved = await saveChat(chatSnapshot).catch(() => null);
        if (saved && !this.closed) {
          this.index = saved.index;
          if (this.chat.id === saved.chat.id) {
            this.chat.title = saved.chat.title;
            this.chat.updatedAt = saved.chat.updatedAt;
          }
          cx.notify();
        }
      }
      return;
    }

    if (msg.type === "error") {
      this.finishStreamWithError(msg.message || "Request failed.", cx);
    }
  }

  finishStreamWithError(message, cx) {
    const draft = this.pendingRetryDraft;
    this.pendingRetryDraft = null;
    this.streaming = false;
    this.activeReqId = null;
    this.error = message;
    const last = this.chat.messages[this.chat.messages.length - 1];
    if (last?.role === "model" && !last.text && !(last.images?.length > 0)) {
      this.chat.messages.pop();
      if (draft) {
        const prevUser = this.chat.messages[this.chat.messages.length - 1];
        if (prevUser?.id === draft.userMsgId) {
          this.chat.messages.pop();
          if (this.composer && !this.composer.value()) this.composer.set_value(draft.promptText);
          if (draft.attachments?.length && this.attachments.length === 0) {
            this.attachments = draft.attachments;
          }
        }
      }
    }
    this.publishStatus(false, false, cx);
    cx.notify();
  }

  sendMessage(cx) {
    if (this.streaming) return;
    const promptText = (this.composer?.value() ?? "").trim();
    if (!promptText && this.attachments.length === 0) return;

    this.cancelEditMessage();
    const outgoingAttachments = this.attachments;
    this.attachments = [];
    this.composer?.set_value("");
    this.error = null;
    this.showHistory = false;
    this.confirmAction = null;

    const userMsg = {
      id: randomUUID().slice(0, 12),
      role: "user",
      text: promptText || `(Attached ${outgoingAttachments.map(a => a.name).join(", ")})`,
      at: Date.now(),
      prevWebContext: this.chat.webContext ? { ...this.chat.webContext } : null,
      attachments: outgoingAttachments.map(a => ({
        name: a.name,
        kind: a.kind,
        size: a.size,
        path: a.path,
        previewRelPath: a.previewRelPath || null,
      })),
    };
    const assistantMsg = {
      id: randomUUID().slice(0, 12),
      role: "model",
      text: "",
      at: Date.now(),
      images: [],
    };

    this.chat.model = this.model;
    this.chat.messages = [...this.chat.messages, userMsg, assistantMsg].slice(-MAX_MESSAGES_PER_CHAT);
    this.pendingRetryDraft = { userMsgId: userMsg.id, promptText, attachments: outgoingAttachments };
    this.dispatchStreamRequest(outgoingAttachments, cx);
  }

  dispatchStreamRequest(outgoingAttachments, cx) {
    const reqId = randomUUID().slice(0, 12);
    this.activeReqId = reqId;
    this.streaming = true;
    this.lastStreamNotifyAt = 0;
    this.publishStatus(true, false, cx);
    this.scrollToLatest();
    cx.notify();

    const modelEntry = this.currentModelEntry();
    const payload = {
      type: "send",
      reqId,
      temporary: Boolean(this.chat.temporary),
      modelSpec: {
        id: modelEntry.id,
        capacity: Number(modelEntry.capacity || 1),
        capacityField: Number(modelEntry.capacityField || 12),
        modelNumber: Number(modelEntry.modelNumber || 1),
      },
      webContext: this.chat.webContext || null,
      messages: this.chat.messages.slice(0, -1).map(m => ({ role: m.role, text: m.text })),
      attachments: (outgoingAttachments || []).filter(a => a?.path).map(a => ({ name: a.name, path: a.path, kind: a.kind })),
    };

    cx.spawn(async cx => {
      try {
        const conn = await this.ensureWorker(cx);
        if (this.closed || this.activeReqId !== reqId) return;
        await conn.ws.write(JSON.stringify(payload));
      } catch (err) {
        if (this.closed || this.activeReqId !== reqId) return;
        this.finishStreamWithError(err?.message || String(err), cx);
      }
    });
  }

  abortStream(cx) {
    if (!this.streaming || !this.activeReqId) return;
    const reqId = this.activeReqId;
    cx.spawn(async () => {
      if (this.workerConn?.ws) {
        await this.workerConn.ws.write(JSON.stringify({ type: "abort", reqId })).catch(() => null);
      }
    });
  }

  sendToTerminal(markdown, cx) {
    const snippet = extractPrimaryCodeBlock(markdown);
    if (!snippet) return;
    const { terminalAddr } = getActiveContext();
    if (!terminalAddr) {
      cx.write_to_clipboard(snippet);
      notify({ title: "Gemini Web", body: "No terminal focused — copied snippet to clipboard.", timeout: 2200 });
      return;
    }
    cx.spawn(async () => {
      const res = await hc(["send", terminalAddr, snippet]).catch(() => ({ code: 1 }));
      if (res.code === 0) {
        notify({ title: "Sent to terminal", body: terminalAddr, level: "success", timeout: 1800 });
      }
    });
  }

  async close() {
    this.closed = true;
    const tempCid = this.chat?.temporary ? this.chat?.webContext?.cid : null;
    const conn = this.workerConn;
    this.workerConn = null;
    this.cancelEditMessage();
    this.releaseSettingsInputs();
    if (this.composer) {
      try { this.composer.release(); } catch {}
      this.composer = null;
    }
    if (this.scroll) {
      try { this.scroll.release(); } catch {}
      this.scroll = null;
    }
    if (this.handle) {
      try { this.handle.release(); } catch {}
      this.handle = null;
    }
    if (conn?.ws) {
      if (tempCid) {
        conn.ws.write(JSON.stringify({ type: "delete_web_chat", cid: tempCid })).catch(() => null);
      }
      conn.ws.write(JSON.stringify({ type: "shutdown" })).catch(() => null);
      conn.ws.close().catch(() => null);
    }
  }

  renderHeader(t) {
    const profileLabel = this.secretStatus.webProfileId || this.config.chromeProfile || "Web";
    return h_flex()
      .flex_none()
      .h(36)
      .px(10)
      .gap(6)
      .items_center()
      .justify_between()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .min_w(0)
          .flex_1()
          .gap(6)
          .items_center()
          .child(svg("mods/gemini-chat/icon.svg").size(14).flex_none().text_color(t.accent))
          .child(
            div()
              .id("gc-history-toggle")
              .min_w(0)
              .px(5)
              .py(2)
              .rounded(4)
              .text_size(12)
              .font_semibold()
              .text_color(t.foreground)
              .truncate()
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.showSettings = false;
                this.showHistory = !this.showHistory;
                cx.notify();
              })
              .child(`${this.chat.title || "New chat"} ▾`),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(4)
          .items_center()
          .child(
            div()
              .id("gc-profile-pill")
              .px(6)
              .h(22)
              .max_w(90)
              .rounded(4)
              .bg(t.raised)
              .border_1()
              .border_color(this.secretStatus.hasWebPsid ? t.border : t.ansi1)
              .flex()
              .items_center()
              .truncate()
              .text_size(10.5)
              .text_color(this.secretStatus.hasWebPsid ? t.accent : t.ansi1)
              .cursor_pointer()
              .hover(s => s.bg(t.hover))
              .tooltip(`Gemini Web · Profile: ${profileLabel} · Model: ${this.currentModelEntry().label}`)
              .on_click((_e, cx) => (this.showSettings ? this.closeSettings(cx) : this.openSettings(cx)))
              .child(this.secretStatus.hasWebPsid ? profileLabel : "No cookie"),
          )
          .child(
            div()
              .id("gc-temp-toggle")
              .size(24)
              .rounded(5)
              .flex()
              .items_center()
              .justify_center()
              .bg(this.temporaryMode ? t.selected : t.surface)
              .border_1()
              .border_color(this.temporaryMode ? t.accent : t.surface)
              .text_color(this.temporaryMode ? t.accent : t.muted)
              .cursor_pointer()
              .hover(s => s.bg(this.temporaryMode ? t.selected : t.hover).text_color(this.temporaryMode ? t.accent : t.foreground))
              .tooltip(this.temporaryMode ? "Temporary chat ON (click to turn off)" : "Turn on temporary chat")
              .on_click((_e, cx) => this.toggleTemporaryMode(cx))
              .child(svg("mods/gemini-chat/temp.svg").size(14)),
          )
          .child(
            div()
              .id("gc-new-chat")
              .size(24)
              .rounded(5)
              .flex()
              .items_center()
              .justify_center()
              .text_size(13)
              .text_color(t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip("New chat")
              .on_click((_e, cx) => this.startNewChat(cx))
              .child("+"),
          )
          .child(
            div()
              .id("gc-settings-btn")
              .size(24)
              .rounded(5)
              .flex()
              .items_center()
              .justify_center()
              .text_size(12.5)
              .bg(this.showSettings ? t.selected : t.surface)
              .text_color(this.showSettings ? t.accent : t.muted)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Settings (Chrome profile cookies & Model)")
              .on_click((_e, cx) => (this.showSettings ? this.closeSettings(cx) : this.openSettings(cx)))
              .child("⚙"),
          ),
      );
  }

  renderConfirmBar(t) {
    return h_flex()
      .flex_none()
      .px(10)
      .py(6)
      .gap(6)
      .items_center()
      .justify_between()
      .bg(t.raised)
      .border_b(1)
      .border_color(t.ansi1)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.ansi1).child(this.confirmAction.label))
      .child(
        h_flex()
          .gap(5)
          .child(
            div()
              .id("gc-confirm-yes")
              .h(22)
              .px(8)
              .rounded(4)
              .bg(t.ansi1)
              .text_color(t.solid_foreground)
              .flex()
              .items_center()
              .text_size(11)
              .font_semibold()
              .cursor_pointer()
              .on_click((_e, cx) => this.confirmDestructive(cx))
              .child("Delete"),
          )
          .child(
            div()
              .id("gc-confirm-no")
              .h(22)
              .px(7)
              .rounded(4)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_color(t.muted)
              .flex()
              .items_center()
              .text_size(11)
              .cursor_pointer()
              .on_click((_e, cx) => {
                this.confirmAction = null;
                cx.notify();
              })
              .child("Cancel"),
          ),
      );
  }

  renderHistoryList(t) {
    return v_flex()
      .flex_none()
      .max_h(210)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .px(10)
          .py(5)
          .items_center()
          .justify_between()
          .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(`Recent chats (${this.index.length})`))
          .when(this.index.length > 0, el =>
            el.child(
              div()
                .id("gc-clear-history")
                .text_size(10.5)
                .text_color(t.ansi1)
                .cursor_pointer()
                .hover(s => s.opacity(0.8))
                .on_click((_e, cx) => {
                  this.confirmAction = { kind: "clear-all", label: `Delete all ${this.index.length} chats?` };
                  cx.notify();
                })
                .child("Clear all"),
            ),
          ),
      )
      .child(
        v_flex()
          .id("gc-history-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(6)
          .pb(6)
          .gap(2)
          .when(this.index.length === 0, el =>
            el.child(div().px(6).py(8).text_size(11).text_color(t.dim).child("No saved conversations yet.")),
          )
          .children(
            this.index.map(item => {
              const active = item.id === this.chat.id;
              return h_flex()
                .id(`gc-chat-${item.id}`)
                .h(28)
                .flex_none()
                .px(7)
                .gap(6)
                .items_center()
                .rounded(5)
                .bg(active ? t.selected : t.chrome)
                .hover(s => s.bg(active ? t.selected : t.hover))
                .cursor_pointer()
                .on_click((_e, cx) => this.selectChat(item.id, cx))
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11.5)
                    .text_color(active ? t.accent : t.foreground)
                    .child(item.title),
                )
                .child(
                  div()
                    .id(`gc-del-${item.id}`)
                    .size(20)
                    .flex_none()
                    .rounded(4)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(t.dim)
                    .opacity(0.55)
                    .hover(s => s.opacity(1).bg(t.raised).text_color(t.ansi1))
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.confirmAction = { kind: "delete-chat", id: item.id, label: `Delete "${item.title}"?` };
                      cx.notify();
                    })
                    .child(svg("mods/pane/close.svg").size(10)),
                );
            }),
          ),
      );
  }

  renderMessageCard(msg, idx, t) {
    const isUser = msg.role === "user";
    const isEditing = isUser && this.editingMsgId === msg.id && Boolean(this.editInput);
    const isLastStreaming = this.streaming && idx === this.chat.messages.length - 1 && !isUser;
    const msgImages = Array.isArray(msg.images) ? msg.images : [];
    const attImages = Array.isArray(msg.attachments) ? msg.attachments.filter(a => a.previewRelPath) : [];

    return v_flex()
      .id(`gc-msg-${msg.id}`)
      .w_full()
      .min_w(0)
      .flex_none()
      .p(9)
      .gap(6)
      .rounded(8)
      .border_1()
      .border_color(isEditing ? t.accent : (isUser ? t.border : t.raised))
      .bg(isUser ? t.raised : t.background)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .items_center()
              .gap(5)
              .child(
                div()
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(isUser ? t.muted : t.accent)
                  .child(isUser ? "You" : `Gemini Web · ${this.currentModelEntry().label}`),
              )
              .when(isLastStreaming, el =>
                el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.accent).spin(900)),
              ),
          )
          .when(isUser && !isEditing, el =>
            el.child(
              div()
                .id(`gc-edit-${msg.id}`)
                .px(5)
                .py(1)
                .rounded(4)
                .text_size(10)
                .text_color(t.dim)
                .opacity(this.streaming ? 0.3 : 0.65)
                .when(!this.streaming, btn => btn.cursor_pointer().hover(s => s.opacity(1).bg(t.hover).text_color(t.foreground)))
                .on_click((_e, cx) => this.startEditMessage(msg.id, cx))
                .child("Edit"),
            ),
          )
          .when(!isUser && Boolean(msg.text), el =>
            el.child(
              h_flex()
                .gap(4)
                .child(
                  div()
                    .id(`gc-copy-${msg.id}`)
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .text_size(10)
                    .text_color(t.dim)
                    .opacity(0.65)
                    .cursor_pointer()
                    .hover(s => s.opacity(1).bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      cx.write_to_clipboard(msg.text);
                      notify({ title: "Gemini Web", body: "Response copied to clipboard.", timeout: 1500 });
                    })
                    .child("Copy"),
                )
                .child(
                  div()
                    .id(`gc-term-${msg.id}`)
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .text_size(10)
                    .text_color(t.dim)
                    .opacity(0.65)
                    .cursor_pointer()
                    .hover(s => s.opacity(1).bg(t.hover).text_color(t.foreground))
                    .tooltip("Send code block to focused terminal")
                    .on_click((_e, cx) => this.sendToTerminal(msg.text, cx))
                    .child("→ Term"),
                ),
            ),
          ),
      )
      .when(Array.isArray(msg.attachments) && msg.attachments.length > 0, el =>
        el.child(
          h_flex()
            .id(`gc-msg-att-${msg.id}`)
            .w_full()
            .min_w(0)
            .h(24)
            .flex_none()
            .gap(4)
            .items_center()
            .overflow_x_scrollbar()
            .children(
              msg.attachments.map((att, aIdx) =>
                div()
                  .id(`gc-matt-${msg.id}-${aIdx}`)
                  .h(20)
                  .flex_none()
                  .px(6)
                  .rounded(4)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .flex()
                  .items_center()
                  .text_size(10)
                  .text_color(t.muted)
                  .child(`${att.name} (${formatBytes(att.size || 0)})`),
              ),
            ),
        ),
      )
      .when(attImages.length > 0, el =>
        el.child(
          h_flex()
            .id(`gc-att-thumbs-${msg.id}`)
            .w_full()
            .min_w(0)
            .h(68)
            .flex_none()
            .gap(6)
            .items_center()
            .overflow_x_scrollbar()
            .children(
              attImages.map((att, aIdx) =>
                div()
                  .id(`gc-att-thumb-${msg.id}-${aIdx}`)
                  .flex_none()
                  .rounded(5)
                  .overflow_hidden()
                  .border_1()
                  .border_color(t.border)
                  .cursor_pointer()
                  .on_click(() => this.openImageInViewer({ relPath: att.previewRelPath }))
                  .child(image(att.previewRelPath).w(64).h(64)),
              ),
            ),
        ),
      )
      .when(isEditing, el =>
        el.child(
          v_flex()
            .w_full()
            .gap(6)
            .child(
              div()
                .rounded(6)
                .bg(t.input)
                .border_1()
                .border_color(t.accent)
                .px(8)
                .py(6)
                .child(Textarea.new(this.editInput).w_full().text_size(12.5).text_color(t.foreground)),
            )
            .child(
              h_flex()
                .justify_end()
                .gap(6)
                .child(
                  div()
                    .id(`gc-edit-cancel-${msg.id}`)
                    .h(24)
                    .px(8)
                    .rounded(5)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_color(t.muted)
                    .flex()
                    .items_center()
                    .text_size(11)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.cancelEditMessage(cx))
                    .child("Cancel"),
                )
                .child(
                  div()
                    .id(`gc-edit-save-${msg.id}`)
                    .h(24)
                    .px(10)
                    .rounded(5)
                    .bg(t.solid)
                    .text_color(t.solid_foreground)
                    .flex()
                    .items_center()
                    .text_size(11)
                    .font_semibold()
                    .cursor_pointer()
                    .hover(s => s.opacity(0.9))
                    .on_click((_e, cx) => this.submitEditMessage(cx))
                    .child("Save & Send"),
                ),
            ),
        ),
      )
      .when(!isEditing, el =>
        el.child(
          isUser
            ? div().text_size(12.5).text_color(t.foreground).child(msg.text)
            : (msg.text
                ? TextView.markdown(`gc-md-${msg.id}`, msg.text)
                    .selectable(true)
                    .raw_html(false)
                    .on_link_click((url, cx) => cx.open_url(url))
                    .text_size(12.5)
                    .text_color(t.foreground)
                : (msgImages.length === 0 ? div().text_size(11.5).text_color(t.dim).child("Thinking…") : div())),
        ),
      )
      .when(msgImages.length > 0, el =>
        el.child(
          v_flex()
            .w_full()
            .gap(6)
            .children(
              msgImages.map((img, iIdx) => {
                const dim = fitImageDimensions(img.width, img.height, 300, 260);
                return v_flex()
                  .id(`gc-gen-img-${msg.id}-${iIdx}`)
                  .gap(3)
                  .child(
                    div()
                      .id(`gc-gen-img-open-${msg.id}-${iIdx}`)
                      .w(dim.w)
                      .h(dim.h)
                      .rounded(6)
                      .overflow_hidden()
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .tooltip("Click to open full size in file-viewer")
                      .on_click(() => this.openImageInViewer(img))
                      .child(image(img.relPath).w(dim.w).h(dim.h)),
                  )
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(div().text_size(10).text_color(t.dim).child(`${img.width}×${img.height}`))
                      .child(
                        div()
                          .id(`gc-gen-img-viewer-${msg.id}-${iIdx}`)
                          .text_size(10)
                          .text_color(t.accent)
                          .cursor_pointer()
                          .hover(s => s.opacity(0.8))
                          .on_click(() => this.openImageInViewer(img))
                          .child("Open in viewer ↗"),
                      ),
                  );
              }),
            ),
        ),
      );
  }

  renderEmptyState(t) {
    const hasCookies = this.secretStatus.hasWebPsid;
    const profileLabel = this.secretStatus.webProfileId || this.config.chromeProfile || "Default";

    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .p(18)
      .gap(10)
      .child(svg("mods/gemini-chat/icon.svg").size(28).text_color(t.accent))
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Gemini Web inside Herdr"))
      .child(
        div()
          .text_size(11.5)
          .text_color(hasCookies ? t.ansi2 : t.muted)
          .child(
            hasCookies
              ? `Ready · Profile: ${profileLabel} · ${this.currentModelEntry().label}`
              : `Chrome profile: ${profileLabel} · Cookies needed`,
          ),
      )
      .when(!hasCookies, el =>
        el.child(
          div()
            .id("gc-empty-setup")
            .mt(4)
            .h(28)
            .px(12)
            .rounded(6)
            .bg(t.solid)
            .text_color(t.solid_foreground)
            .flex()
            .items_center()
            .text_size(11.5)
            .font_medium()
            .cursor_pointer()
            .hover(s => s.opacity(0.9))
            .on_click((_e, cx) => this.openSettings(cx))
            .child("Copy cookies from Chrome"),
        ),
      );
  }

  renderErrorBanner(t) {
    return v_flex()
      .flex_none()
      .mx(8)
      .mb(6)
      .p(8)
      .gap(6)
      .rounded(6)
      .bg(t.raised)
      .border_1()
      .border_color(t.ansi1)
      .child(div().text_size(11).text_color(t.ansi1).child(this.error))
      .child(
        h_flex()
          .gap(6)
          .child(
            div()
              .id("gc-err-reimport")
              .h(24)
              .px(8)
              .rounded(4)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .flex()
              .items_center()
              .text_size(10.5)
              .font_medium()
              .cursor_pointer()
              .on_click((_e, cx) => this.importCookiesFromProfile(cx))
              .child(`Copy cookies (${this.config.chromeProfile})`),
          )
          .child(
            div()
              .id("gc-err-settings")
              .h(24)
              .px(8)
              .rounded(4)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_color(t.foreground)
              .flex()
              .items_center()
              .text_size(10.5)
              .cursor_pointer()
              .on_click((_e, cx) => this.openSettings(cx))
              .child("Open Settings"),
          ),
      );
  }

  renderComposer(t) {
    const ctx = getActiveContext();
    return v_flex()
      .flex_none()
      .w_full()
      .min_w(0)
      .p(8)
      .gap(6)
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome)
      .when(this.attachments.length > 0, el =>
        el.child(
          h_flex()
            .id("gc-attach-strip")
            .w_full()
            .min_w(0)
            .h(26)
            .flex_none()
            .gap(5)
            .items_center()
            .overflow_x_scrollbar()
            .children(
              this.attachments.map(att =>
                h_flex()
                  .id(`gc-att-${att.id}`)
                  .h(22)
                  .flex_none()
                  .px(7)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .child(div().text_size(10.5).text_color(t.foreground).child(att.name))
                  .child(
                    div()
                      .id(`gc-att-rm-${att.id}`)
                      .text_color(t.dim)
                      .cursor_pointer()
                      .hover(s => s.text_color(t.ansi1))
                      .on_click((_e, cx) => {
                        this.attachments = this.attachments.filter(a => a.id !== att.id);
                        cx.spawn(async () => { await cleanupStagedAttachment(att); });
                        cx.notify();
                      })
                      .child("×"),
                  ),
              ),
            ),
        ),
      )
      .child(
        div()
          .rounded(7)
          .bg(t.input)
          .border_1()
          .border_color(t.border)
          .px(8)
          .py(6)
          .child(Textarea.new(this.composer).w_full().text_size(12.5).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(
                div()
                  .id("gc-attach-btn")
                  .h(24)
                  .px(7)
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(t.muted)
                  .flex()
                  .items_center()
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Attach file (or drag & drop / Ctrl+V image)")
                  .on_click((_e, cx) => this.pickAttachments(cx))
                  .child("+ File"),
              )
              .child(
                div()
                  .id("gc-paste-img-btn")
                  .h(24)
                  .px(7)
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(t.muted)
                  .flex()
                  .items_center()
                  .cursor_pointer()
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Attach image from clipboard (or press Ctrl+V in composer)")
                  .on_click((_e, cx) => this.pasteClipboardImage(cx))
                  .child("+ Img"),
              )
              .when(Boolean(ctx.activeFileName), el =>
                el.child(
                  div()
                    .id("gc-attach-active")
                    .h(24)
                    .px(7)
                    .rounded(5)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10.5)
                    .text_color(t.accent)
                    .flex()
                    .items_center()
                    .max_w(130)
                    .truncate()
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .tooltip(`Attach open file: ${ctx.activeFileName}`)
                    .on_click((_e, cx) => this.attachActiveFile(cx))
                    .child(`+ ${ctx.activeFileName}`),
                ),
              ),
          )
          .child(
            this.streaming
              ? div()
                  .id("gc-stop-btn")
                  .h(26)
                  .px(11)
                  .rounded(6)
                  .bg(t.ansi1)
                  .text_color(t.solid_foreground)
                  .flex()
                  .items_center()
                  .text_size(11.5)
                  .font_semibold()
                  .cursor_pointer()
                  .on_click((_e, cx) => this.abortStream(cx))
                  .child("Stop")
              : div()
                  .id("gc-send-btn")
                  .h(26)
                  .px(12)
                  .rounded(6)
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .flex()
                  .items_center()
                  .text_size(11.5)
                  .font_semibold()
                  .cursor_pointer()
                  .hover(s => s.opacity(0.9))
                  .on_click((_e, cx) => this.sendMessage(cx))
                  .child("Send"),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const fontFamily = settings().font_family ?? settings().font;
    const visible = !checking() && isGeminiPanelVisible();

    if (visible) {
      this.hiddenSince = null;
      if (this.evicted) this.scheduleRestore(cx);
      if (shared("gemini.status")?.unread) {
        this.publishStatus(this.streaming, false, cx);
      }
    }

    return v_flex()
      .id("gc-root")
      .size_full()
      .min_w(0)
      .bg(t.surface)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .when(Boolean(fontFamily), el => el.font_family(fontFamily))
      .on_drop((e, cx) => this.handleDrop(e, cx))
      .on_key_down((e, cx) => this.handleKeyDown(e, cx))
      .child(this.renderHeader(t))
      .when(this.temporaryMode && !this.showSettings, el =>
        el.child(
          h_flex()
            .flex_none()
            .px(10)
            .py(5)
            .gap(6)
            .items_center()
            .justify_between()
            .bg(t.raised)
            .border_b(1)
            .border_color(t.border)
            .child(
              h_flex()
                .items_center()
                .gap(5)
                .child(svg("mods/gemini-chat/temp.svg").size(12).text_color(t.accent))
                .child(div().text_size(10.5).text_color(t.muted).child("Temporary chat · not saved to history")),
            )
            .child(
              div()
                .id("gc-temp-off")
                .text_size(10)
                .text_color(t.accent)
                .cursor_pointer()
                .hover(s => s.opacity(0.8))
                .on_click((_e, cx) => this.toggleTemporaryMode(cx))
                .child("Turn off"),
            ),
        ),
      )
      .when(Boolean(this.confirmAction), el => el.child(this.renderConfirmBar(t)))
      .when(this.showHistory && !this.showSettings, el => el.child(this.renderHistoryList(t)))
      .when(this.showSettings, el => el.child(renderSettingsPanel(this, t)))
      .when(!this.showSettings, el =>
        el
          .child(
            this.chat.messages.length === 0
              ? this.renderEmptyState(t)
              : v_flex()
                  .id("gc-messages")
                  .flex_1()
                  .w_full()
                  .min_w(0)
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .track_scroll(this.scroll)
                  .p(10)
                  .gap(8)
                  .children(this.chat.messages.map((msg, idx) => this.renderMessageCard(msg, idx, t))),
          )
          .when(Boolean(this.error), box => box.child(this.renderErrorBanner(t)))
          .child(this.renderComposer(t)),
      );
  }
}
