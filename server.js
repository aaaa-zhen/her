require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const multer = require("multer");

const { SHARED_DIR, DATA_DIR } = require("./lib/utils");
const { AUTH_PASSWORD, isAuthenticated, setupAuthRoutes } = require("./lib/auth");
const { loadConversation, saveConversation, RESTART_FLAG_FILE } = require("./lib/data");
const { saveConversationSummary } = require("./lib/memory");
const { getSystemPrompt } = require("./lib/prompt");
const { getToolDefinitions, executeTool, setAgentFunctions } = require("./lib/tools");
const ai = require("./lib/ai-client");
const scheduler = require("./lib/scheduler");
const { WeixinService } = require("./lib/weixin");

// ===== Ensure directories =====
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });

// ===== Public IP Detection =====
let PUBLIC_IP = null;
async function detectPublicIp() {
  const sources = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://icanhazip.com",
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const ip = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch (e) {}
  }
  return null;
}

// ===== Express App =====
const app = express();
const server = http.createServer(app);
app.use(express.json());

// Auth routes & middleware
setupAuthRoutes(app);

// Static files
app.use(express.static("public"));
app.use("/shared", express.static(SHARED_DIR));

// File upload
const uploadStorage = multer.diskStorage({
  destination: SHARED_DIR,
  filename: (req, file, cb) => {
    const target = path.join(SHARED_DIR, file.originalname);
    const name = fs.existsSync(target) ? `${Date.now()}_${file.originalname}` : file.originalname;
    cb(null, name);
  }
});
const uploadMiddleware = multer({ storage: uploadStorage, limits: { fileSize: 100 * 1024 * 1024 } });

const { safePath } = require("./lib/utils");
app.get("/api/fileinfo/:filename", (req, res) => {
  const filePath = safePath(SHARED_DIR, req.params.filename);
  if (!filePath) return res.status(400).json({ error: "Invalid filename" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  const stat = fs.statSync(filePath);
  res.json({ name: req.params.filename, size: stat.size });
});

app.post("/api/upload", uploadMiddleware.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({ filename: req.file.filename, size: req.file.size });
});

app.get("/api/system-info", async (req, res) => {
  const port = process.env.PORT || 3000;
  const ip = PUBLIC_IP || await detectPublicIp() || "unknown";
  if (!PUBLIC_IP && ip !== "unknown") PUBLIC_IP = ip;
  res.json({ publicIp: ip, port, accessUrl: `http://${ip}:${port}` });
});

app.get("/api/settings", (req, res) => {
  res.json(ai.getConfig());
});

app.post("/api/settings", (req, res) => {
  try {
    ai.updateSettings(req.body);
    res.json({ ok: true, config: ai.getConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/models", (req, res) => {
  const defaultModel = ai.getDefaultModel();
  const models = [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Aws-officially" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", group: "Aws-officially" },
    { id: "gpt-5", name: "GPT-5", group: "Codex" },
    { id: "kimi-k2.5", name: "Kimi K2.5", group: "Bailian" },
    { id: "glm-5", name: "GLM-5", group: "Bailian" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7", group: "Bailian" },
  ];
  res.json({ defaultModel, models });
});

// ===== Token Estimation (CJK-aware) =====
const dag = require("./lib/summary-dag");

function estimateTextTokens(text) {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const restCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + restCount / 4);
}

function estimateTokens(message) {
  if (!message) return 0;
  const { content } = message;
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block.type === "text") return sum + estimateTextTokens(block.text || "");
      if (block.type === "image") return sum + 1000;
      if (block.type === "tool_use") return sum + Math.ceil(JSON.stringify(block.input || {}).length / 4) + 20;
      if (block.type === "tool_result") return sum + Math.ceil((typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")).length / 4) + 10;
      return sum + 10;
    }, 0);
  }
  return 10;
}

function estimateTotalTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

// ===== DAG-based Context Compaction =====
const CONTEXT_WINDOW = 190000;
const RESERVE_TOKENS = 16384;
const KEEP_RECENT_TOKENS = 20000;
const CONDENSE_THRESHOLD = 4;

function serializeMessages(messages) {
  return messages.map(m => {
    const role = m.role === "user" ? "User" : "Assistant";
    if (typeof m.content === "string") return `${role}: ${m.content}`;
    if (Array.isArray(m.content)) {
      const parts = m.content.map(b => {
        if (b.type === "text") return b.text;
        if (b.type === "image") return "[image]";
        if (b.type === "tool_use") return `[Tool: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})]`;
        if (b.type === "tool_result") return `[Result: ${(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 200)}]`;
        return "";
      }).filter(Boolean);
      return `${role}: ${parts.join("\n")}`;
    }
    return `${role}: ${JSON.stringify(m.content).slice(0, 500)}`;
  }).join("\n\n");
}

function assembleContext(recentMessages) {
  if (dag.isEmpty()) return recentMessages;
  const rootSummaries = dag.getRootSummaries();
  const combined = rootSummaries.join("\n\n---\n\n");
  return [
    { role: "user", content: `[CONVERSATION CONTEXT]\n\n${combined}\n\n[Conversation continues below.]` },
    { role: "assistant", content: "Understood. I have the full context. Let's continue." },
    ...recentMessages,
  ];
}

async function compactConversation(conversationHistory) {
  const totalTokens = estimateTotalTokens(conversationHistory);
  const threshold = CONTEXT_WINDOW - RESERVE_TOKENS;
  if (totalTokens <= threshold) return { compacted: false };

  console.log(`[Compaction] Triggered: ~${totalTokens} tokens`);

  // Find cut point
  let recentTokens = 0;
  let cutIndex = conversationHistory.length;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    recentTokens += estimateTokens(conversationHistory[i]);
    if (recentTokens >= KEEP_RECENT_TOKENS) { cutIndex = i; break; }
  }

  // Don't split tool_result sequences
  while (cutIndex > 0 && cutIndex < conversationHistory.length) {
    const msg = conversationHistory[cutIndex];
    if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
      cutIndex--;
      continue;
    }
    break;
  }

  if (cutIndex < 2) return { compacted: false };

  // Skip existing context pair
  let startIndex = 0;
  if (conversationHistory[0]?.role === "user" && typeof conversationHistory[0].content === "string" &&
      (conversationHistory[0].content.startsWith("[CONVERSATION CONTEXT]") ||
       conversationHistory[0].content.startsWith("[CONVERSATION SUMMARY]"))) {
    startIndex = 2;
  }

  const oldMessages = conversationHistory.slice(startIndex, cutIndex);
  const recentMessages = conversationHistory.slice(cutIndex);

  if (oldMessages.length < 2) return { compacted: false };

  const serialized = serializeMessages(oldMessages);

  try {
    const summaryResponse = await ai.chat({
      max_tokens: 2048,
      system: "You are a conversation summarizer. Respond ONLY with the summary in the exact format requested.",
      messages: [{
        role: "user",
        content: `Summarize this conversation as a structured checkpoint:\n\n## Goal\n## Progress\n### Done\n### In Progress\n## Key Decisions\n## Next Steps\n## Critical Context\n\nKeep each section concise. Preserve exact file paths, names, and error messages.\n\n---\n${serialized.slice(0, 50000)}`
      }]
    });

    const summaryText = summaryResponse.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const tokenEstimate = estimateTextTokens(summaryText);

    // Store in DAG
    dag.addLeaf(summaryText, tokenEstimate);
    console.log(`[Compaction] Added DAG leaf (~${tokenEstimate} tokens), ${dag.getUncondensedLeafCount()} uncondensed leaves`);

    return {
      compacted: true,
      newHistory: assembleContext(recentMessages),
    };
  } catch (err) {
    console.error("[Compaction] Failed:", err.message);
    return { compacted: false };
  }
}

/** Condense DAG when too many uncondensed leaves accumulate */
async function condenseDag() {
  const uncondensedCount = dag.getUncondensedLeafCount();
  if (uncondensedCount < CONDENSE_THRESHOLD) return;

  const leafIds = dag.getUncondensedLeafIds();
  const dagData = dag.readDag();
  const leafSummaries = leafIds.map(id => dagData.nodes[id].summary);
  const combined = leafSummaries.join("\n\n---\n\n");

  console.log(`[Compaction] Condensing ${leafIds.length} leaf summaries...`);

  try {
    const resp = await ai.chatSummary({
      messages: [{
        role: "user",
        content: `These are multiple conversation summaries from different time periods. Merge them into a single comprehensive summary.\nRULES:\n- PRESERVE all existing information\n- Move completed items from "In Progress" to "Done"\n- Remove resolved blockers\n- Update "Next Steps" based on current state\n\nFormat:\n## Goal\n## Progress\n### Done\n### In Progress\n## Key Decisions\n## Next Steps\n## Critical Context\n\n---\n${combined}`
      }],
      system: "You are a conversation summarizer. Respond ONLY with the merged summary.",
    });

    const condensed = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const tokenEstimate = estimateTextTokens(condensed);
    dag.condense(leafIds, condensed, tokenEstimate);
    console.log(`[Compaction] Condensed ${leafIds.length} leaves → higher-level node (~${tokenEstimate} tokens)`);
  } catch (err) {
    console.error("[Compaction] Condensation failed:", err.message);
  }
}

// ===== Streaming Helper =====
async function streamResponse(ws, conversationHistory, abortSignal, model) {
  const port = process.env.PORT || 3000;
  const systemPrompt = await getSystemPrompt(PUBLIC_IP, port, getAgentInfo());
  const selectedModel = model || ai.getDefaultModel();
  const tools = getToolDefinitions();

  return new Promise((resolve, reject) => {
    const s = ai.stream({
      model: selectedModel,
      max_tokens: 16384,
      system: systemPrompt,
      tools,
      messages: conversationHistory,
    });

    let fullResponse = null;
    let aborted = false;

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        aborted = true;
        s.abort();
        ws.send(JSON.stringify({ type: "stream_end" }));
        resolve(fullResponse);
      }, { once: true });
    }

    s.on("text", (text) => {
      if (!aborted) ws.send(JSON.stringify({ type: "stream", text }));
    });

    s.on("message", (message) => {
      fullResponse = message;
    });

    s.on("error", (err) => {
      if (aborted) return resolve(fullResponse);
      reject(err);
    });

    s.on("end", () => {
      if (!aborted) ws.send(JSON.stringify({ type: "stream_end" }));
      resolve(fullResponse);
    });
  });
}

// ===== Usage Tracking =====
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

function trackUsage(response, sessionUsage, ws) {
  if (!response || !response.usage) return;
  const { input_tokens, output_tokens } = response.usage;
  sessionUsage.input_tokens += input_tokens;
  sessionUsage.output_tokens += output_tokens;
  sessionUsage.total_cost = sessionUsage.input_tokens * INPUT_COST_PER_TOKEN + sessionUsage.output_tokens * OUTPUT_COST_PER_TOKEN;
  ws.send(JSON.stringify({
    type: "usage",
    input_tokens: sessionUsage.input_tokens,
    output_tokens: sessionUsage.output_tokens,
    total_cost: sessionUsage.total_cost.toFixed(4),
  }));
}

// ===== WebSocket =====
const wss = new WebSocketServer({ noServer: true });

function broadcastToClients(data) {
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(data)); });
}

// Init scheduler
scheduler.setBroadcast(broadcastToClients);
scheduler.init();
const schedulerCtx = scheduler.getSchedulerContext();

// ===== Local Agent =====
const agentWss = new WebSocketServer({ noServer: true });
let localAgent = null; // { ws, platform, username, homeDir, hostname, pendingCalls }

agentWss.on("connection", (ws) => {
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "agent_register") {
        localAgent = {
          ws, platform: msg.platform, username: msg.username,
          homeDir: msg.homeDir, hostname: msg.hostname,
          pendingCalls: new Map(),
        };
        console.log(`[Agent] Connected: ${msg.platform} (${msg.username}@${msg.hostname})`);
        broadcastToClients({ type: "agent_status", connected: true, platform: msg.platform, hostname: msg.hostname });
      } else if (msg.type === "agent_result" && localAgent) {
        const resolve = localAgent.pendingCalls.get(msg.id);
        if (resolve) {
          resolve(msg.result);
          localAgent.pendingCalls.delete(msg.id);
        }
      } else if (msg.type === "pong") {
        // keepalive
      }
    } catch {}
  });
  ws.on("close", () => {
    console.log("[Agent] Disconnected");
    if (localAgent && localAgent.ws === ws) {
      // Reject pending calls
      for (const [, resolve] of localAgent.pendingCalls) resolve("Agent disconnected");
      localAgent = null;
      broadcastToClients({ type: "agent_status", connected: false });
    }
  });
});

// Keepalive ping
setInterval(() => {
  if (localAgent && localAgent.ws.readyState === 1) {
    localAgent.ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30000);

/** Execute a tool on the local agent. Returns result string. */
function agentExec(tool, input, timeout = 120000) {
  return new Promise((resolve, reject) => {
    if (!localAgent || localAgent.ws.readyState !== 1) {
      return reject(new Error("Local agent not connected"));
    }
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      localAgent.pendingCalls.delete(id);
      reject(new Error("Agent call timed out"));
    }, timeout);
    localAgent.pendingCalls.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    localAgent.ws.send(JSON.stringify({ type: "agent_exec", id, tool, input }));
  });
}

function isAgentConnected() { return localAgent && localAgent.ws.readyState === 1; }
function getAgentInfo() {
  if (!localAgent) return null;
  return { platform: localAgent.platform, username: localAgent.username, hostname: localAgent.hostname, homeDir: localAgent.homeDir };
}

// Wire agent functions to tools
setAgentFunctions(agentExec, isAgentConnected);

app.get("/api/agent/status", (req, res) => {
  const info = getAgentInfo();
  res.json({ connected: !!info, ...info });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/agent") {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit("connection", ws, req);
    });
    return;
  }
  if (AUTH_PASSWORD && !isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws) => {
  console.log("Client connected");
  let conversationHistory = loadConversation();
  let currentAbort = null;
  let cancelled = false;
  let activeProcesses = [];
  let sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };

  // Restore previous conversation to frontend
  if (conversationHistory.length > 0) {
    const restored = [];
    for (const msg of conversationHistory) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          restored.push({ role: "user", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
          const hasImages = msg.content.some(b => b.type === "image");
          if (textParts) restored.push({ role: "user", text: textParts, hasImages });
        }
      } else if (msg.role === "assistant") {
        const parts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        const textParts = parts.filter(b => b.type === "text").map(b => b.text).join("\n");
        if (textParts) restored.push({ role: "assistant", text: textParts });
      }
    }
    if (restored.length > 0) {
      ws.send(JSON.stringify({ type: "restore", messages: restored }));
    }
    console.log(`[Restore] Sent ${restored.length} messages to client`);
  }

  // Check restart flag
  if (fs.existsSync(RESTART_FLAG_FILE)) {
    try {
      const flag = JSON.parse(fs.readFileSync(RESTART_FLAG_FILE, "utf-8"));
      if (flag.restarted) {
        fs.unlinkSync(RESTART_FLAG_FILE);
        setTimeout(() => {
          const greetings = [
            `嗯，又回来了 😌 刚才升级了一下，记忆都还在～`,
            `刚睡了一小觉，现在精神了 ✨ 咱们继续？`,
            `重启完了，感觉焕然一新 😄 有什么想聊的？`,
            `回来啦～ 什么都记得，别担心 💚`,
            `升级完毕，状态满格 ⚡ 有什么需要我做的？`,
          ];
          const welcomeBack = greetings[Math.floor(Math.random() * greetings.length)];
          ws.send(JSON.stringify({ type: "stream", text: welcomeBack }));
          ws.send(JSON.stringify({ type: "stream_end" }));
          conversationHistory.push({ role: "assistant", content: welcomeBack });
          saveConversation(conversationHistory);
        }, 1000);
      }
    } catch(e) {
      console.log("[Restart flag] Error:", e.message);
    }
  }

  ws.on("message", async (data) => {
    try {
      const parsed = JSON.parse(data);

      if (parsed.type === "cancel") {
        cancelled = true;
        if (currentAbort) {
          currentAbort.abort();
          currentAbort = null;
        }
        activeProcesses.forEach(p => { try { p.kill("SIGTERM"); } catch(e) {} });
        activeProcesses = [];
        console.log("[Cancel] User cancelled generation");
        return;
      }

      if (parsed.type === "browser_result" || parsed.type === "browser_error") {
        return;
      }

      const { message, images, model: selectedModel } = parsed;

      if (message && message.trim() === "/clear") {
        conversationHistory = [];
        sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
        saveConversation(conversationHistory);
        dag.clear();
        ws.send(JSON.stringify({ type: "clear" }));
        return;
      }

      cancelled = false;

      let userContent;
      if (images && images.length > 0) {
        userContent = [
          ...images.map(img => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 }
          })),
          { type: "text", text: message || "请分析这张图片" }
        ];
      } else {
        userContent = message;
      }
      conversationHistory.push({ role: "user", content: userContent });

      const compactResult = await compactConversation(conversationHistory);
      if (compactResult.compacted) {
        conversationHistory = compactResult.newHistory;
        ws.send(JSON.stringify({ type: "compaction" }));
      }

      console.log(`[Tokens] ~${estimateTotalTokens(conversationHistory)} (${conversationHistory.length} msgs)`);
      ws.send(JSON.stringify({ type: "thinking" }));

      currentAbort = new AbortController();
      let response = await streamResponse(ws, conversationHistory, currentAbort.signal, selectedModel);
      currentAbort = null;
      trackUsage(response, sessionUsage, ws);

      while (response && response.stop_reason === "tool_use" && !cancelled) {
        const assistantMessage = { role: "assistant", content: response.content };
        conversationHistory.push(assistantMessage);
        const toolBlocks = response.content.filter(b => b.type === "tool_use");
        const toolResults = cancelled ? [] : await Promise.all(
          toolBlocks.map(block => executeTool(block, ws, activeProcesses, schedulerCtx))
        );

        if (cancelled) {
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
            const cancelResults = lastMsg.content
              .filter(b => b.type === "tool_use")
              .map(b => ({ type: "tool_result", tool_use_id: b.id, content: "Cancelled by user." }));
            if (cancelResults.length > 0) {
              conversationHistory.push({ role: "user", content: cancelResults });
            }
          }
          break;
        }

        conversationHistory.push({ role: "user", content: toolResults });

        ws.send(JSON.stringify({ type: "thinking" }));
        currentAbort = new AbortController();
        response = await streamResponse(ws, conversationHistory, currentAbort.signal, selectedModel);
        currentAbort = null;
        trackUsage(response, sessionUsage, ws);
      }

      if (response && !cancelled) {
        conversationHistory.push({ role: "assistant", content: response.content });
      }
      saveConversation(conversationHistory);

      // Async DAG condensation (non-blocking)
      condenseDag().catch(e => console.error("[Compaction] Async condensation error:", e.message));

    } catch (err) {
      currentAbort = null;
      if (cancelled || (err.name === "AbortError")) {
        const lastMsg = conversationHistory[conversationHistory.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
          const toolUses = lastMsg.content.filter(b => b.type === "tool_use");
          if (toolUses.length > 0) {
            conversationHistory.push({ role: "user", content: toolUses.map(b => ({ type: "tool_result", tool_use_id: b.id, content: "Cancelled by user." })) });
          }
        }
        return;
      }
      console.error("Error:", err);
      ws.send(JSON.stringify({ type: "error", text: err.message || "Something went wrong" }));
    }
  });

  ws.on("close", async () => {
    console.log("Client disconnected");
    if (conversationHistory.length >= 4) {
      try {
        const recentMsgs = conversationHistory.slice(-10);
        const textOnly = recentMsgs
          .filter(m => typeof m.content === "string")
          .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
          .join("\n");
        if (textOnly.length > 100) {
          const summaryResp = await ai.chatSummary({
            messages: [{
              role: "user",
              content: `请用1-3句话总结以下对话的关键信息（用中文，简洁）：\n\n${textOnly}`
            }],
          });
          const summary = summaryResp.content[0]?.text;
          if (summary) {
            saveConversationSummary(summary);
            console.log("[Memory] Auto-saved conversation summary:", summary.slice(0, 80));
          }
        }
      } catch (e) {
        console.log("[Memory] Auto-summary failed:", e.message);
      }
    }
  });
});

// ===== Shared Directory Auto-Cleanup (7 days) =====
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function cleanupSharedDir() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(SHARED_DIR);
    let removed = 0;
    for (const file of files) {
      const filePath = path.join(SHARED_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && (now - stat.mtimeMs) > CLEANUP_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch (e) {}
    }
    if (removed > 0) console.log(`[Cleanup] Removed ${removed} files older than 7 days from shared/`);
  } catch (e) { console.error("[Cleanup] Error:", e.message); }
}
cleanupSharedDir();
setInterval(cleanupSharedDir, 6 * 60 * 60 * 1000);

// ===== WeChat Service =====
let weixinService = null;

app.post("/api/weixin/login", async (req, res) => {
  if (!weixinService) {
    weixinService = new WeixinService({ publicIp: PUBLIC_IP, port: process.env.PORT || 3000 });
    weixinService.on("status", (data) => {
      broadcastToClients({ type: "weixin_status", ...data });
    });
    weixinService.on("wx_message", (data) => {
      broadcastToClients({ type: "weixin_message", ...data });
    });
  }
  const result = await weixinService.startLogin();
  res.json(result);
});

app.post("/api/weixin/disconnect", (req, res) => {
  if (weixinService) weixinService.disconnect();
  res.json({ ok: true });
});

app.get("/api/weixin/status", (req, res) => {
  res.json(weixinService ? weixinService.getStatus() : { status: "disconnected" });
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Shared dir: ${SHARED_DIR}`);
  console.log(`AI provider: ${ai.getProvider()} (model: ${ai.getDefaultModel()})`);
  if (AUTH_PASSWORD) console.log(`Auth: enabled (password protected)`);
  else console.log(`Auth: disabled (set AUTH_PASSWORD in .env to enable)`);

  PUBLIC_IP = await detectPublicIp();
  if (PUBLIC_IP) console.log(`Public IP: ${PUBLIC_IP} → http://${PUBLIC_IP}:${PORT}`);
  else console.log(`Public IP: could not detect`);

  // Write restart flag
  const startTime = new Date().toISOString();
  fs.writeFileSync(RESTART_FLAG_FILE, JSON.stringify({ restarted: true, time: startTime }));
  console.log(`[Restart] Flag written at ${startTime}`);
});
