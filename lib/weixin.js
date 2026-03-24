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
  constructor({ publicIp, port }) {
    super();
    this.publicIp = publicIp;
    this.port = port;
    this.sessions = new Map();
    this.abortController = null;
    this.status = "disconnected";
    this.accountId = null;
    this._cleanupTimer = setInterval(() => this._cleanupIdleSessions(), 5 * 60 * 1000);
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

    const sdk = await import("weixin-agent-sdk");
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
    return {
      chat: async (request) => {
        const { conversationId, text, media } = request;

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

        messageText = `[via 微信] ${messageText}`;

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

    const systemPrompt = await getSystemPrompt(this.publicIp, this.port);
    const tools = getToolDefinitions();

    // Non-streaming call with tool loop
    let response = await ai.chat({
      messages: session.history,
      system: systemPrompt,
      tools,
      max_tokens: 8192,
    });

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
      session.history.push({ role: "assistant", content: response.content });
      const toolBlocks = response.content.filter(b => b.type === "tool_use");
      const toolResults = await Promise.all(
        toolBlocks.map(block => executeTool(block, fakeWs, activeProcesses, schedulerCtx))
      );
      session.history.push({ role: "user", content: toolResults });

      response = await ai.chat({
        messages: session.history,
        system: systemPrompt,
        tools,
        max_tokens: 8192,
      });
    }

    if (response) {
      session.history.push({ role: "assistant", content: response.content });
    }

    // Extract text
    const textParts = (response?.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    // Keep history manageable
    if (session.history.length > 40) {
      session.history = session.history.slice(-20);
    }

    this._saveSession(conversationId, session);

    const result = { text: textParts || undefined };

    // Attach file if any
    if (session.lastFile) {
      const filePath = path.join(SHARED_DIR, session.lastFile.filename);
      if (fs.existsSync(filePath)) {
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
}

module.exports = { WeixinService };
