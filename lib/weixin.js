/**
 * WeChat Bridge Service for her-main.
 *
 * Handles QR login, message monitoring, and per-user conversations.
 * Uses the unified ai-client for AI responses.
 */

const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");
const { DATA_DIR, SHARED_DIR, execAsync } = require("./utils");
const { getSystemPrompt } = require("./prompt");
const { getToolDefinitions, executeTool } = require("./tools");
const ai = require("./ai-client");

const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
const QR_POLL_TIMEOUT_MS = 35000;
const SESSION_TTL_MS = 30 * 60 * 1000;

const WEIXIN_DATA_DIR = path.join(DATA_DIR, "weixin");
if (!fs.existsSync(WEIXIN_DATA_DIR)) fs.mkdirSync(WEIXIN_DATA_DIR, { recursive: true });

async function fetchQrCode() {
  const url = `${WEIXIN_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return await res.json();
}

async function pollQrStatus(qrcode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const url = `${WEIXIN_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

class WeixinService extends EventEmitter {
  constructor({ publicIp, port, getAgentInfo }) {
    super();
    this.publicIp = publicIp;
    this.port = port;
    this.getAgentInfo = getAgentInfo || (() => null);
    this.sessions = new Map();
    this.abortController = null;
    this.status = "disconnected";
    this.accountId = null;
    this._cleanupTimer = setInterval(() => this._cleanupIdleSessions(), 5 * 60 * 1000);
  }

  // ── Auto-reconnect on startup ──

  async tryAutoReconnect() {
    try {
      const os = require("os");
      const stateDir = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
      const listFile = path.join(stateDir, "..", "accounts.json");
      if (!fs.existsSync(listFile)) return false;

      const list = JSON.parse(fs.readFileSync(listFile, "utf-8"));
      if (!list || list.length === 0) return false;

      const accountId = list[0]; // Most recent account
      const accountFile = path.join(stateDir, `${accountId}.json`);
      if (!fs.existsSync(accountFile)) return false;

      const data = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
      if (!data.token) return false;

      console.log(`[WeChat] Auto-reconnecting account ${accountId}...`);
      this.accountId = accountId;
      this.status = "connected";
      this.emit("status", { status: "connected", accountId });
      this._startMonitor();
      return true;
    } catch (e) {
      console.log("[WeChat] Auto-reconnect failed:", e.message);
      return false;
    }
  }

  // ── Login ──

  async startLogin() {
    if (this.status === "qr_pending") return { success: false, error: "登录进行中" };

    this.status = "qr_pending";
    this.emit("status", { status: "qr_pending" });

    try {
      console.log("[WeChat] Fetching QR code...");
      const qrData = await fetchQrCode();
      const qrUrl = qrData.qrcode_img_content;
      const qrToken = qrData.qrcode;
      if (!qrUrl) throw new Error("No QR code URL received");

      console.log("[WeChat] QR code ready, waiting for scan...");
      this.emit("status", { status: "qr_pending", qrUrl });

      const deadline = Date.now() + 480000;
      let maxRefresh = 3;
      let currentQrToken = qrToken;

      while (Date.now() < deadline) {
        const result = await pollQrStatus(currentQrToken);

        switch (result.status) {
          case "wait":
            break;
          case "scaned":
            console.log("[WeChat] QR scanned, waiting for confirmation...");
            this.emit("status", { status: "qr_scanned" });
            break;
          case "expired":
            maxRefresh--;
            if (maxRefresh <= 0) throw new Error("二维码多次过期，请重试");
            console.log("[WeChat] QR expired, refreshing...");
            const newQr = await fetchQrCode();
            currentQrToken = newQr.qrcode;
            this.emit("status", { status: "qr_pending", qrUrl: newQr.qrcode_img_content });
            break;
          case "confirmed":
            if (!result.ilink_bot_id) throw new Error("登录失败：未返回 bot ID");

            const accountId = result.ilink_bot_id;
            await this._persistAccount(accountId, result.bot_token, result.baseurl);

            this.accountId = accountId;
            this.status = "connected";
            this.emit("status", { status: "connected", accountId });
            console.log(`[WeChat] Connected! accountId=${accountId}`);

            this._startMonitor();
            return { success: true, accountId };
        }

        await new Promise((r) => setTimeout(r, 1000));
      }

      throw new Error("登录超时，请重试");
    } catch (err) {
      console.error("[WeChat] Login failed:", err.message);
      this.status = "disconnected";
      this.emit("status", { status: "disconnected", error: err.message });
      return { success: false, error: err.message };
    }
  }

  async _persistAccount(accountId, token, baseUrl) {
    const os = require("os");
    const stateDir = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    const accountFile = path.join(stateDir, `${accountId}.json`);
    const existing = fs.existsSync(accountFile) ? JSON.parse(fs.readFileSync(accountFile, "utf-8")) : {};
    existing.token = token;
    if (baseUrl) existing.baseUrl = baseUrl;
    fs.writeFileSync(accountFile, JSON.stringify(existing, null, 2));

    const listFile = path.join(stateDir, "..", "accounts.json");
    let list = [];
    try { list = JSON.parse(fs.readFileSync(listFile, "utf-8")); } catch {}
    if (!list.includes(accountId)) {
      list.unshift(accountId);
      fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
    }
  }

  // ── Monitor ──

  async _startMonitor() {
    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();

    const sdk = await import("./weixin-sdk/index.mjs");
    const agent = this._createAgent();

    try {
      await sdk.start(agent, {
        accountId: this.accountId,
        abortSignal: this.abortController.signal,
        log: (msg) => {
          console.log(`[WeChat] ${msg}`);
          this.emit("log", msg);
        },
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[WeChat] Monitor error:", err.message);
        this.status = "disconnected";
        this.emit("status", { status: "disconnected", error: err.message });
      }
    }
  }

  // ── Agent ──

  _createAgent() {
    const recentMsgIds = new Map(); // msgKey → timestamp, for dedup
    return {
      chat: async (request) => {
        const { conversationId, text, media } = request;

        // Dedup: skip if same message from same user within 5 seconds
        const msgKey = `${conversationId}:${text || ""}:${media?.filePath || ""}`;
        const now = Date.now();
        const lastSeen = recentMsgIds.get(msgKey);
        if (lastSeen && now - lastSeen < 5000) {
          console.log(`[WeChat] Skipping duplicate: ${msgKey.slice(0, 60)}`);
          return { text: undefined };
        }
        recentMsgIds.set(msgKey, now);
        // Cleanup old entries
        if (recentMsgIds.size > 100) {
          for (const [k, t] of recentMsgIds) { if (now - t > 30000) recentMsgIds.delete(k); }
        }

        let messageText = text || "";
        const images = [];

        if (media) {
          if (media.type === "image" && media.filePath) {
            try {
              const data = fs.readFileSync(media.filePath);
              const base64 = data.toString("base64");
              const ext = path.extname(media.filePath).slice(1).toLowerCase();
              const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
              images.push({ mediaType: mimeMap[ext] || "image/jpeg", base64 });
            } catch (e) {}
            if (!messageText) messageText = "[图片]";
          } else if (media.type === "audio") {
            if (!messageText) messageText = "[语音消息]";
          } else if (media.type === "video") {
            messageText += messageText ? `\n[视频: ${media.filePath}]` : `[视频: ${media.filePath}]`;
          } else if (media.type === "file") {
            messageText += messageText ? `\n[文件: ${media.fileName || media.filePath}]` : `[文件: ${media.fileName || media.filePath}]`;
          }
        }

        if (!messageText.trim()) return { text: undefined };

        messageText = `[via 微信, 文件上限200MB, 下载视频请用 max_size_mb:200] ${messageText}`;

        try {
          console.log(`[WeChat] ${conversationId}: ${messageText.slice(0, 80)}`);
          const response = await this._chat(conversationId, messageText, images);
          console.log(`[WeChat] Reply: ${(response.text || "").slice(0, 80)}`);
          // Broadcast to web UI
          this.emit("wx_message", { from: conversationId, userText: text, replyText: response.text });
          return response;
        } catch (err) {
          console.error(`[WeChat] Error:`, err.message);
          return { text: `出错了: ${err.message}` };
        }
      },
    };
  }

  // ── Chat with AI ──

  async _chat(conversationId, text, images = []) {
    const session = this._getOrCreateSession(conversationId);

    // Build user content
    let userContent;
    if (images.length > 0) {
      userContent = [
        ...images.map(img => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.base64 }
        })),
        { type: "text", text }
      ];
    } else {
      userContent = text;
    }

    session.history.push({ role: "user", content: userContent });

    // Auto-select vision model when images are present
    const VISION_FALLBACK = "google/gemini-3.1-flash-image-preview";
    const hasImages = images.length > 0 || (Array.isArray(userContent) && userContent.some(b => b.type === "image"));
    const currentModel = hasImages ? VISION_FALLBACK : ai.getDefaultModel();
    const systemPrompt = await getSystemPrompt(this.publicIp, this.port, this.getAgentInfo(), currentModel);
    const tools = getToolDefinitions(currentModel);

    // Strip base64 image data from older messages to avoid context overflow
    // Only keep images in the last 4 messages
    const cleanHistory = session.history.map((msg, i) => {
      if (i >= session.history.length - 4) return msg; // keep recent
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const cleaned = msg.content.filter(b => b.type !== "image").map(b => {
          if (b.type === "tool_result" && Array.isArray(b.content)) {
            return { ...b, content: b.content.filter(c => c.type !== "image") };
          }
          return b;
        });
        if (cleaned.length === 0) return { ...msg, content: "[图片已省略]" };
        return { ...msg, content: cleaned };
      }
      return msg;
    });

    // Non-streaming call with tool loop
    console.log(`[WeChat] Chat: model=${currentModel}, history=${cleanHistory.length} msgs, tools=${tools.length}`);
    let response;
    try {
      response = await ai.chat({
        messages: cleanHistory,
        system: systemPrompt,
        model: currentModel,
        tools,
        max_tokens: 8192,
      });
    } catch (err) {
      console.error(`[WeChat] AI error:`, err.message, err.status || "");
      // If history is corrupted, clear and retry with just the last message
      if (session.history.length > 1) {
        console.log("[WeChat] Retrying with fresh history...");
        const lastMsg = session.history[session.history.length - 1];
        session.history = [lastMsg];
        response = await ai.chat({
          messages: session.history,
          system: systemPrompt,
          model: currentModel,
          tools,
          max_tokens: 8192,
        });
      } else {
        throw err;
      }
    }

    // Fake ws for tool execution (logs only, no streaming to browser)
    const fakeWs = {
      send: (data) => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "file") session.lastFile = parsed;
        } catch {}
      },
      on: () => {},
      removeListener: () => {},
    };

    const activeProcesses = [];
    const schedulerCtx = { registerTask: () => {}, getNextTaskId: () => 0, processOutput: () => {} };

    // Tool loop
    let maxIterations = 10;
    while (response && response.stop_reason === "tool_use" && maxIterations-- > 0) {
      // Deduplicate tool calls (Kimi sometimes generates duplicates)
      const seen = new Set();
      const dedupedContent = response.content.filter(b => {
        if (b.type !== "tool_use") return true; // keep text blocks
        const key = `${b.name}:${JSON.stringify(b.input)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const aMsg = { role: "assistant", content: dedupedContent };
      session.history.push(aMsg);

      const toolBlocks = dedupedContent.filter(b => b.type === "tool_use");

      const toolResults = await Promise.all(
        toolBlocks.map(block => executeTool(block, fakeWs, activeProcesses, schedulerCtx))
      );
      session.history.push({ role: "user", content: toolResults });

      response = await ai.chat({
        messages: session.history,
        system: systemPrompt,
        model: currentModel,
        tools,
        max_tokens: 8192,
      });
    }

    if (response) {
      const finalMsg = { role: "assistant", content: response.content };
      session.history.push(finalMsg);
    }

    // Extract text — if model only returned tool calls with no text, generate a fallback
    let textParts = (response?.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();
    if (!textParts && response?.content?.some(b => b.type === "tool_use")) {
      textParts = "done";
    }

    // Keep history manageable — trim from front, but never break tool pairs
    if (session.history.length > 40) {
      let cutIndex = session.history.length - 20;
      // Don't cut in the middle of a tool_result sequence
      while (cutIndex < session.history.length) {
        const msg = session.history[cutIndex];
        if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
          cutIndex--; // back up to include the assistant tool_call message
        } else {
          break;
        }
      }
      if (cutIndex > 0) session.history = session.history.slice(cutIndex);
    }

    this._saveSession(conversationId, session);

    const result = { text: textParts || undefined };

    // Attach file if any
    if (session.lastFile) {
      // Try local path from URL query, then shared dir, then symlinks
      let filePath = null;
      const fileUrl = session.lastFile.url || "";
      const pathMatch = fileUrl.match(/[?&]path=([^&]+)/);
      if (pathMatch) {
        const decoded = decodeURIComponent(pathMatch[1]);
        if (fs.existsSync(decoded)) filePath = decoded;
      }
      if (!filePath) {
        const inShared = path.join(SHARED_DIR, session.lastFile.filename);
        if (fs.existsSync(inShared)) {
          // Resolve symlinks to get actual path
          filePath = fs.realpathSync(inShared);
        }
      }
      if (filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
        const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
        let mediaType = "file";
        if (imageExts.includes(ext)) mediaType = "image";
        else if (videoExts.includes(ext)) mediaType = "video";
        result.media = { type: mediaType, url: filePath, fileName: session.lastFile.filename };
      }
      session.lastFile = null;
    }

    return result;
  }

  // ── Session management ──

  _getOrCreateSession(conversationId) {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }

    // Try to load from disk
    const historyFile = this._sessionFile(conversationId);
    let history = [];
    try {
      if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      }
    } catch {}

    const session = { history, lastActive: Date.now(), lastFile: null };
    this.sessions.set(conversationId, session);
    console.log(`[WeChat] New session: ${conversationId}`);
    return session;
  }

  _sessionFile(conversationId) {
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = path.join(WEIXIN_DATA_DIR, safeId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "history.json");
  }

  _saveSession(conversationId, session) {
    try {
      const file = this._sessionFile(conversationId);
      fs.writeFileSync(file, JSON.stringify(session.history));
    } catch {}
  }

  _cleanupIdleSessions() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActive > SESSION_TTL_MS) {
        this._saveSession(id, entry);
        this.sessions.delete(id);
        console.log(`[WeChat] Cleaned idle session: ${id}`);
      }
    }
  }

  // ── Disconnect ──

  disconnect() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.status = "disconnected";
    this.accountId = null;
    this.emit("status", { status: "disconnected" });
  }

  destroy() {
    this.disconnect();
    clearInterval(this._cleanupTimer);
    this.sessions.clear();
  }

  getStatus() {
    return { status: this.status, accountId: this.accountId };
  }

  /**
   * Push a text message to the most recent WeChat conversation.
   * Used by scheduler to send reminders/task results.
   */
  async pushMessage(text) {
    if (this.status !== "connected" || !this.accountId) {
      throw new Error("WeChat not connected");
    }

    // Find the most recently active session
    let latestId = null;
    let latestTime = 0;
    for (const [id, session] of this.sessions) {
      if (session.lastActive > latestTime) {
        latestTime = session.lastActive;
        latestId = id;
      }
    }
    if (!latestId) {
      throw new Error("No active WeChat session");
    }

    // Load account credentials
    const os = require("os");
    const stateDir = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
    const accountFile = path.join(stateDir, `${this.accountId}.json`);
    const accountData = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    if (!accountData.token) throw new Error("No token");

    // Get contextToken from SDK's internal store
    const sdk = await import("./weixin-sdk/index.mjs");
    const ctxKey = sdk.contextTokenKey(this.accountId, latestId);
    const contextToken = sdk.contextTokenStore.get(ctxKey);

    if (!contextToken) {
      throw new Error("No contextToken — user hasn't sent a message yet in this session");
    }

    await sdk.sendMessageWeixin({
      to: latestId,
      text,
      opts: {
        baseUrl: accountData.baseUrl || "https://ilinkai.weixin.qq.com",
        token: accountData.token,
        contextToken,
      },
    });

    console.log(`[WeChat] Pushed to ${latestId}: ${text.slice(0, 60)}`);
  }
}

module.exports = { WeixinService };
