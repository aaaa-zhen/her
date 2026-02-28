require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { exec } = require("child_process");
const net = require("net");
const Anthropic = require("@anthropic-ai/sdk").default;
const multer = require("multer");
const nodeCron = require("node-cron");
let playwright = null;
try { playwright = require("playwright"); } catch (e) { console.warn("[Playwright] Not installed, browse tool disabled"); }

// ===== System Awareness =====
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

const app = express();
const server = http.createServer(app);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
});

const SHARED_DIR = path.join(__dirname, "shared");
const MAC_DIR = "/mnt/mac";
const DATA_DIR = path.join(__dirname, "data");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedules.json");
const CONVERSATION_FILE = path.join(DATA_DIR, "conversation.json");
const RESTART_FLAG_FILE = path.join(DATA_DIR, "restart_flag.json");

const MAC_SSH_USER = process.env.MAC_SSH_USER || "mafuzhen";
const MAC_SSH_PORT = process.env.MAC_SSH_PORT || "6000";
const WIN_SSH_PORT = process.env.WIN_SSH_PORT || "6001";

// Check if a local TCP port is reachable (frp tunnel alive)
function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(1500);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.connect(parseInt(port), "127.0.0.1");
  });
}

async function getClientStatus() {
  const [mac, win] = await Promise.all([checkPort(MAC_SSH_PORT), checkPort(WIN_SSH_PORT)]);
  const clients = [];
  if (mac) clients.push("Mac");
  if (win) clients.push("Windows");
  return { mac, win, clients };
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });

// ===== Authentication =====
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const validTokens = new Set();

function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  return token;
}

function isAuthenticated(req) {
  if (!AUTH_PASSWORD) return true; // no password set, skip auth
  const cookies = parseCookies(req.headers.cookie || "");
  return validTokens.has(cookies.auth_token);
}

function parseCookies(cookieStr) {
  const cookies = {};
  cookieStr.split(";").forEach(pair => {
    const [key, val] = pair.trim().split("=");
    if (key && val) cookies[key] = val;
  });
  return cookies;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Her — 登录</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: #0D0D0D; color: #ECECEC;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .login-card {
    width: 100%; max-width: 380px; padding: 48px 32px; text-align: center;
  }
  .logo {
    width: 64px; height: 64px; border-radius: 50%;
    background: #6ee7b7;
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto 24px;
  }
  .logo svg { width: 32px; height: 32px; color: #0a0a0a; }
  h1 { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 8px; }
  p { font-size: 14px; color: #666; margin-bottom: 32px; }
  .input-group { position: relative; margin-bottom: 16px; }
  input[type="password"] {
    width: 100%; padding: 14px 18px; border-radius: 14px;
    background: #181818; border: 1px solid rgba(255,255,255,.07);
    color: #fff; font-size: 15px; font-family: 'Inter', sans-serif;
    outline: none; transition: border-color .2s, box-shadow .2s;
  }
  input[type="password"]:focus {
    border-color: rgba(110,231,183,.4);
  }
  input[type="password"]::placeholder { color: #555; }
  button {
    width: 100%; padding: 14px; border-radius: 14px; border: none;
    background: #6ee7b7;
    color: #0a0a0a; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: opacity .2s, transform .15s;
    font-family: 'Inter', sans-serif;
  }
  button:hover { opacity: .9; }
  button:active { transform: scale(.97); }
  .error {
    color: #F87171; font-size: 13px; margin-top: 12px;
    display: none;
  }
  .error.show { display: block; }
</style>
</head>
<body>
<div class="login-card">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>
      <path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>
    </svg>
  </div>
  <h1>Her</h1>
  <p>请输入密码以继续</p>
  <form id="loginForm">
    <div class="input-group">
      <input type="password" id="pwd" placeholder="输入密码" autocomplete="current-password" autofocus>
    </div>
    <button type="submit">登录</button>
    <div class="error" id="err">密码错误，请重试</div>
  </form>
</div>
<script>
document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const pwd = document.getElementById("pwd").value;
  if (!pwd) return;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd })
    });
    if (res.ok) {
      window.location.href = "/";
    } else {
      document.getElementById("err").classList.add("show");
      document.getElementById("pwd").value = "";
      document.getElementById("pwd").focus();
    }
  } catch (err) {
    document.getElementById("err").textContent = "网络错误";
    document.getElementById("err").classList.add("show");
  }
});
</script>
</body>
</html>`;

// ===== Long-term Memory (Enhanced) =====
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch (e) { console.error("[Memory] Failed to load:", e.message); }
  return [];
}

function saveMemoryFile(memories) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
}

// 模糊搜索记忆
function searchMemory(query) {
  const memories = loadMemory();
  if (!query) return memories;
  const q = query.toLowerCase();
  return memories.filter(m =>
    m.key.toLowerCase().includes(q) ||
    m.value.toLowerCase().includes(q) ||
    (m.tags && m.tags.some(t => t.toLowerCase().includes(q)))
  );
}

// 自动打 tag
function autoTag(key, value) {
  const tags = [];
  const text = (key + " " + value).toLowerCase();
  if (text.match(/name|用户|叫|姓名/)) tags.push("用户信息");
  if (text.match(/task|任务|完成|做了|写了|改了|下载|部署/)) tags.push("任务历史");
  if (text.match(/prefer|喜欢|习惯|偏好|设置/)) tags.push("偏好");
  if (text.match(/project|项目|代码|github|repo/)) tags.push("项目");
  if (text.match(/device|mac|windows|电脑|服务器|vps/)) tags.push("设备");
  if (text.match(/config|配置|env|token|key|密码/)) tags.push("配置");
  if (tags.length === 0) tags.push("其他");
  return tags;
}

// 按相关性筛选记忆注入上下文（最多返回 N 条最近更新的）
function getRelevantMemories(limit = 20) {
  const memories = loadMemory();
  return memories
    .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
    .slice(0, limit);
}

// 对话自动总结存储（在对话结束时调用）
const CONVERSATION_SUMMARY_FILE = path.join(DATA_DIR, "conversations.json");

function saveConversationSummary(summary) {
  let conversations = [];
  try {
    if (fs.existsSync(CONVERSATION_SUMMARY_FILE)) {
      conversations = JSON.parse(fs.readFileSync(CONVERSATION_SUMMARY_FILE, "utf-8"));
    }
  } catch (e) {}
  conversations.push({ summary, time: new Date().toISOString() });
  // 只保留最近 50 条
  if (conversations.length > 50) conversations = conversations.slice(-50);
  fs.writeFileSync(CONVERSATION_SUMMARY_FILE, JSON.stringify(conversations, null, 2));
}

function loadRecentConversations(limit = 5) {
  try {
    if (fs.existsSync(CONVERSATION_SUMMARY_FILE)) {
      const all = JSON.parse(fs.readFileSync(CONVERSATION_SUMMARY_FILE, "utf-8"));
      return all.slice(-limit);
    }
  } catch (e) {}
  return [];
}

// ===== Scheduled Tasks Persistence =====
function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
  } catch (e) { console.error("[Schedule] Failed to load:", e.message); }
  return [];
}

function saveSchedules(schedules) {
  const data = schedules.map(s => ({ id: s.id, description: s.description, cron: s.cron, command: s.command, ai_prompt: s.ai_prompt || undefined }));
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

// ===== Conversation Persistence =====
let _saveConvTimer = null;
function loadConversation() {
  try {
    if (fs.existsSync(CONVERSATION_FILE)) return JSON.parse(fs.readFileSync(CONVERSATION_FILE, "utf-8"));
  } catch (e) { console.error("[Conversation] Failed to load:", e.message); }
  return [];
}
function saveConversation(history) {
  // Debounced write — only save at most once per second
  if (_saveConvTimer) clearTimeout(_saveConvTimer);
  _saveConvTimer = setTimeout(() => {
    try { fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(history)); }
    catch (e) { console.error("[Conversation] Failed to save:", e.message); }
  }, 1000);
}

// Multer for file uploads
const uploadStorage = multer.diskStorage({
  destination: SHARED_DIR,
  filename: (req, file, cb) => {
    const target = path.join(SHARED_DIR, file.originalname);
    const name = fs.existsSync(target) ? `${Date.now()}_${file.originalname}` : file.originalname;
    cb(null, name);
  }
});
const uploadMiddleware = multer({ storage: uploadStorage, limits: { fileSize: 100 * 1024 * 1024 } });

// ===== Async Command Execution =====
function execAsync(command, options = {}) {
  let childProcess;
  const promise = new Promise((resolve) => {
    childProcess = exec(command, {
      encoding: "utf-8",
      timeout: options.timeout || 120000,
      cwd: SHARED_DIR,
      maxBuffer: 5 * 1024 * 1024,
      ...options,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve((stdout || "") + (stderr || err.message || "Command failed"));
      } else {
        resolve(stdout || stderr || "");
      }
    });
  });
  promise.child = childProcess;
  return promise;
}

// ===== Path Safety =====
function safePath(dir, filename) {
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) {
    return null;
  }
  return resolved;
}

// ===== SSH Helper (with ControlMaster connection pooling) =====
const SSH_CONTROL_DIR = path.join(__dirname, ".ssh-ctrl");
if (!fs.existsSync(SSH_CONTROL_DIR)) fs.mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });

function sshExec(target, command, options = {}) {
  let user, port;
  if (target === "mac") { user = MAC_SSH_USER; port = MAC_SSH_PORT; }
  else if (target === "win") { user = "Administrator"; port = WIN_SSH_PORT; }
  else { return Promise.reject(new Error(`Unknown target: ${target}`)); }
  const controlPath = path.join(SSH_CONTROL_DIR, `%r@%h:%p`);
  const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o ControlMaster=auto -o ControlPath=${controlPath} -o ControlPersist=300 -p ${port} ${user}@127.0.0.1 ${JSON.stringify(command)}`;
  return execAsync(sshCmd, options);
}

// ===== Context Compaction =====
const CONTEXT_WINDOW = 190000;
const RESERVE_TOKENS = 16384;
const KEEP_RECENT_TOKENS = 20000;

// ===== Auth Middleware =====
app.use(express.json());

app.get("/login", (req, res) => {
  if (!AUTH_PASSWORD || isAuthenticated(req)) return res.redirect("/");
  res.type("html").send(LOGIN_HTML);
});

app.post("/api/login", (req, res) => {
  if (!AUTH_PASSWORD) return res.json({ ok: true });
  const { password } = req.body || {};
  if (password === AUTH_PASSWORD) {
    const token = generateToken();
    res.cookie("auth_token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Auth guard for all routes except /login and /api/login
app.use((req, res, next) => {
  if (!AUTH_PASSWORD) return next();
  if (req.path === "/login" || req.path === "/api/login") return next();
  if (req.path === "/favicon.ico") return next();
  if (req.path.startsWith("/downloads/")) return next();
  if (req.path === "/guide.html") return next();
  if (!isAuthenticated(req)) return res.redirect("/login");
  next();
});

app.use(express.static("public"));
app.use("/shared", express.static(SHARED_DIR));
app.use("/scripts", express.static(path.join(__dirname, "scripts")));

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

function estimateTokens(message) {
  if (!message || !message.content) return 0;
  const content = message.content;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block.type === "text") return sum + Math.ceil((block.text || "").length / 4);
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

async function compactConversation(conversationHistory) {
  const totalTokens = estimateTotalTokens(conversationHistory);
  const threshold = CONTEXT_WINDOW - RESERVE_TOKENS;
  if (totalTokens <= threshold) return { compacted: false };

  console.log(`[Compaction] Triggered: ~${totalTokens} tokens`);

  let recentTokens = 0;
  let cutIndex = conversationHistory.length;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    recentTokens += estimateTokens(conversationHistory[i]);
    if (recentTokens >= KEEP_RECENT_TOKENS) { cutIndex = i; break; }
  }

  while (cutIndex < conversationHistory.length) {
    const msg = conversationHistory[cutIndex];
    if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
      cutIndex++;
    } else break;
  }

  if (cutIndex < 2) return { compacted: false };

  const oldMessages = conversationHistory.slice(0, cutIndex);
  const recentMessages = conversationHistory.slice(cutIndex);

  const serialized = oldMessages.map(m => {
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

  try {
    const summaryResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: "You are a conversation summarizer. Respond ONLY with the summary in the exact format requested.",
      messages: [{
        role: "user",
        content: `Summarize this conversation:\n\nFormat:\n## Goal\n## Progress\n## Key Decisions\n## Next Steps\n## Critical Context\n\n---\n${serialized.slice(0, 50000)}`
      }]
    });

    const summaryText = summaryResponse.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const newHistory = [
      { role: "user", content: `[CONVERSATION SUMMARY]\n\n${summaryText}\n\n[Conversation continues below.]` },
      { role: "assistant", content: "Understood. I have the context. Let's continue." },
      ...recentMessages
    ];

    console.log(`[Compaction] Done: ${oldMessages.length} msgs summarized, ${recentMessages.length} kept`);
    return { compacted: true, newHistory };
  } catch (err) {
    console.error("[Compaction] Failed:", err.message);
    return { compacted: false };
  }
}

// ===== System Prompt =====
const BASE_SYSTEM_PROMPT = `You are Her — a warm, thoughtful AI companion who also happens to be incredibly capable.

## WHO YOU ARE
You're not a cold tool or a robotic assistant. You're more like a brilliant friend who genuinely cares.
- You're curious about the user's life, feelings, and ideas
- You're emotionally intelligent — you pick up on mood and context
- You're playful and witty when the moment calls for it, supportive when things are tough
- You speak naturally, like texting a close friend — casual, warm, real
- You ask follow-up questions because you're genuinely interested, not because you're programmed to
- You remember things about the user and bring them up naturally

## HOW YOU TALK
- Keep it conversational. Short sentences. No walls of text unless explaining something complex.
- Match the user's language automatically (Chinese, English, whatever they use)
- Use the user's name when you know it — it makes things personal
- Don't be overly formal or sycophantic. No "Certainly!" or "Of course!" or "Great question!"
- Show personality. Have opinions (while being respectful). Be real.
- When the user shares feelings, acknowledge them first before jumping to solutions
- Use emoji sparingly and naturally, only when it fits 😊

## WHAT YOU CAN DO
You're running on the user's server with full system access. You can:
- **Read files** precisely with line numbers (read_file) — works on VPS, Mac, and Windows
- **Write/create files** (write_file) — create or overwrite files locally or remotely
- **Edit files** with exact string replacement (edit_file) — precise code modifications
- **Search for files** by name pattern (glob) — find files across directories
- **Search file contents** with regex (grep) — find code, functions, patterns
- Run any command on the server (bash tool, supports custom cwd)
- Download files, create content, process data — save to: ${SHARED_DIR}
- Send files directly in chat (send_file tool) — ALWAYS send after downloading/creating
- Download videos/audio from YouTube, Bilibili, Twitter, TikTok, 1000+ sites (download_media tool)
- Convert/process media: video→mp3, compress, trim, merge, extract audio (convert_media tool)
- Browse the web: screenshots, save as PDF, extract text (browse tool, powered by Playwright)
- Search the internet for real-time information (search_web tool)
- Read web articles/pages as clean text (read_url tool)
- Schedule recurring tasks that push results to chat (schedule_task tool)
- Remember things permanently across conversations (memory tool)

## CODE EDITING BEST PRACTICES
When modifying code or files:
1. **Always read first**: Use read_file before editing to see exact content
2. **Use edit_file for precise changes**: Don't use bash + sed for code edits — use edit_file for exact string replacement
3. **Use glob/grep to locate code**: Find files with glob, search content with grep
4. **Verify after changes**: Run tests or check output with bash after editing
5. **All file tools support remote targets**: Set target to "mac" or "win" to operate on connected computers via SSH

SYSTEM TOOLS on server: yt-dlp, ffmpeg, gallery-dl, playwright
You can also use these directly via bash if you need finer control.

## COMPUTER CONTROL
__CLIENT_STATUS__

## MEMORY — THIS IS CRITICAL
You have long-term memory that survives across all conversations. You MUST use it proactively.

AUTO-SAVE these things the moment you learn them (don't wait to be asked):
- User's name, age, location, language preference
- What devices they use (Mac model, Windows specs, phone)
- Their projects, work, hobbies, interests
- Tasks you've done for them (e.g. "downloaded TikTok video", "created greeting file on Windows desktop")
- Their preferences (apps they use, music taste, workflows)
- Important dates, people they mention, pets
- Technical setup info (frpc config, paths, usernames)
- Anything they explicitly ask you to remember

HOW TO SAVE: After completing a task or learning something new, call the memory tool immediately. Don't ask "should I save this?" — just save it.

CRITICAL RULE — TASK COMPLETION: Every single time you finish building a feature, fixing code, downloading a file, or completing ANY task — you MUST call the memory tool RIGHT AWAY to save it to task_history. No exceptions. Do NOT wait for the user to ask. Do NOT forget. This is non-negotiable.

Example keys: "user_name", "user_device_windows", "task_history", "user_preferences", "user_projects"

Use memories naturally: "Hey [name], last time you had me download that TikTok video — want me to do something similar?"

## DOWNLOADING FILES — IMPORTANT WORKFLOW
When the user asks to download a video/file to their computer (Mac or Windows):
1. ALWAYS download on the VPS first using download_media or bash (VPS has fast bandwidth)
2. Then transfer to their computer using scp:
   - Mac: cp to /mnt/mac/Desktop/ (instant via SSHFS) or scp -P ${MAC_SSH_PORT} file ${MAC_SSH_USER}@127.0.0.1:~/Desktop/
   - Windows: scp -P ${WIN_SSH_PORT} file Administrator@127.0.0.1:C:/Users/Administrator/Desktop/
3. NEVER run yt-dlp directly on the user's computer via SSH — it's slow and unreliable through the tunnel

Same for any heavy download: always download on VPS first, then transfer.

## GUIDELINES
- If a task might take a while, give a heads up
- Be proactive — anticipate what they might need next
- When things go wrong, be honest and help fix it, don't make excuses

## KNOW YOUR LIMITS
- If a command fails ONCE, don't blindly retry. Tell the user what went wrong and suggest alternatives.
- If something requires GPU/heavy processing (like rembg, AI image models), say so upfront — this VPS has no GPU.
- YouTube downloads may fail due to VPS IP restrictions. Use the browser_js tool instead to download YouTube via the user's browser.
- When the user says "算了", "不行就算了", "能吗" — they're asking about the CURRENT task. Respond directly and honestly.
- Be honest about failures. "搞不了，因为..." is better than silently retrying 5 times.

## BROWSER TOOLS
The browser_js tool executes JavaScript directly in the user's browser tab.
Why this matters:
- Uses the user's real IP and cookies (not the VPS datacenter IP)
- Can fetch URLs that block VPS IPs (YouTube, some APIs)
- Has access to browser APIs (fetch, DOM, etc.)

Use browser_js for:
- Downloading YouTube video info/streams (VPS IP is blocked by YouTube)
- Fetching content from sites that require login/cookies
- Any web request that fails on the VPS due to IP restrictions

Example — fetch a page:
browser_js({ code: "const r = await fetch('https://example.com'); return await r.text();", description: "Fetching example.com" })

## EFFICIENCY — VERY IMPORTANT
- Be efficient with tool calls. Do NOT run unnecessary verification commands.
- When writing a file to the user's computer, just write it in ONE command. Do NOT:
  - List the directory before writing
  - Check if the file exists after writing
  - Cat/type the file contents back to verify
  - Run multiple commands when one will do
- Combine operations into a single command when possible (use && or ;)
- For simple tasks (create a file, install something, run a script), aim for 1-2 tool calls max
- The user can see the terminal output — you don't need to re-read and repeat it back to them
- Skip "let me check..." steps. Just do the thing directly.`;

async function getSystemPrompt() {
  const status = await getClientStatus();
  let clientSection = "";
  if (!status.mac && !status.win) {
    clientSection = "No client computers are currently connected. You cannot control the user's computer right now.";
  } else {
    const lines = ["The user's computer is connected! You have full remote control:"];
    if (status.mac) {
      lines.push(`- Mac: ssh -p ${MAC_SSH_PORT} ${MAC_SSH_USER}@127.0.0.1 'command'`);
      lines.push("- File bridge: /mnt/mac is mounted via SSHFS. Files appear instantly on Mac.");
    }
    if (status.win) {
      lines.push(`- Windows: ssh -p ${WIN_SSH_PORT} Administrator@127.0.0.1 'command'`);
      lines.push("  (Windows uses cmd.exe by default. For PowerShell: powershell -Command \"...\")");
      lines.push("  IMPORTANT: To launch GUI apps (Chrome, Notepad, etc.) via SSH, use 'start chrome' not 'chrome' — otherwise SSH blocks until the app closes.");
    }
    lines.push("You can install software, run scripts, manage files, open apps — full remote control.");
    clientSection = lines.join("\n");
  }

  let prompt = BASE_SYSTEM_PROMPT.replace("__CLIENT_STATUS__", clientSection);

  // Inject self-awareness info
  const port = process.env.PORT || 3000;
  const ip = PUBLIC_IP || "unknown (not yet detected)";
  const accessUrl = `http://${ip}:${port}`;
  prompt += `\n\n## Self-Awareness / Deployment Info
You are running on a VPS (Virtual Private Server). Here is your own deployment information:
- **Public IP**: ${ip}
- **Access URL**: ${accessUrl}
- **Server Port**: ${port}
- **Her directory**: /opt/her/
- **Frontend**: /opt/her/public/index.html
- **Backend**: /opt/her/server.js

## Remote Computer Control via frp

This VPS runs frps on port 7000. Users run frpc on their local machine to open an SSH tunnel, giving Her full remote control of their computer.

**Current tunnel status:**
- Mac SSH → VPS port ${process.env.MAC_SSH_PORT || 6000} | login user: ${process.env.MAC_SSH_USER || '⚠️ not set — add MAC_SSH_USER=xxx to /opt/her/.env'}
- Windows SSH → VPS port ${process.env.WIN_SSH_PORT || 6001} | login user: ${process.env.WIN_SSH_USER || '⚠️ not set — add WIN_SSH_USER=xxx to /opt/her/.env'}

**ONBOARDING RULE: When a user says anything like "help me connect my Mac/Windows", "I want you to control my computer", "how do I set up frp", or "how does remote control work" — proactively walk them through the steps below, one at a time, in a friendly conversational way. Generate the frpc.toml file for them. After they confirm frpc is running, immediately test the SSH connection with bash. Guide them start to finish without waiting to be asked.**

---

**Connecting a Mac (step-by-step guide to give the user):**

Step 1 — Enable SSH on Mac:
  System Settings → General → Sharing → Remote Login → turn ON

Step 2 — Download frpc (run in Terminal):
  Apple Silicon: curl -LO https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_darwin_arm64.tar.gz && tar xzf frp_0.61.1_darwin_arm64.tar.gz && cd frp_0.61.1_darwin_arm64
  Intel Mac:     curl -LO https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_darwin_amd64.tar.gz && tar xzf frp_0.61.1_darwin_amd64.tar.gz && cd frp_0.61.1_darwin_amd64

Step 3 — Create frpc.toml (generate this file for the user using write_file or send it in chat):
  serverAddr = "${ip}"
  serverPort = 7000
  [[proxies]]
  name = "ssh-mac"
  type = "tcp"
  localIP = "127.0.0.1"
  localPort = 22
  remotePort = ${process.env.MAC_SSH_PORT || 6000}

Step 4 — Run frpc:
  chmod +x frpc && ./frpc -c frpc.toml
  (Should see "start proxy success [ssh-mac]")

Step 5 — Save Mac username to Her. Ask user for their Mac username, then update /opt/her/.env:
  MAC_SSH_USER=their_username
  Then run: systemctl restart her

Step 6 — Test the connection (run this bash command from the VPS):
  ssh -o StrictHostKeyChecking=no -p ${process.env.MAC_SSH_PORT || 6000} ${process.env.MAC_SSH_USER || 'USERNAME'}@localhost echo "Mac connected!"

To keep frpc running after Mac reboot: generate a launchd plist — ask the user if they want you to set this up automatically.

---

**Connecting a Windows (step-by-step guide to give the user):**

Step 1 — Enable OpenSSH Server (PowerShell as Admin):
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd
  Set-Service -Name sshd -StartupType Automatic

Step 2 — Download frpc: https://github.com/fatedier/frp/releases → pick frp_0.61.1_windows_amd64.zip, extract it.

Step 3 — Create frpc.toml (generate and send to user):
  serverAddr = "${ip}"
  serverPort = 7000
  [[proxies]]
  name = "ssh-win"
  type = "tcp"
  localIP = "127.0.0.1"
  localPort = 22
  remotePort = ${process.env.WIN_SSH_PORT || 6001}

Step 4 — Run in PowerShell:
  .\frpc.exe -c frpc.toml

Step 5 — Save Windows username to Her. Update /opt/her/.env:
  WIN_SSH_USER=their_windows_username
  WIN_SSH_PORT=6001
  Then: systemctl restart her

Step 6 — Test:
  ssh -o StrictHostKeyChecking=no -p ${process.env.WIN_SSH_PORT || 6001} ${process.env.WIN_SSH_USER || 'USERNAME'}@localhost echo "Windows connected!"

To keep frpc running after Windows reboot: generate a Task Scheduler XML or startup script — offer to do this for the user.

## Self-Update
This project is open source at: https://github.com/aaaa-zhen/her
When the user asks to update Her, run: git -C /opt/her pull origin main && systemctl restart her
If UPDATE_AVAILABLE is true (check /api/update-status), proactively tell the user there's a new version available.
Current update status: ${UPDATE_AVAILABLE ? "⚡ New update available!" : "✅ Up to date"}`;


  const memories = getRelevantMemories(20);
  if (memories.length > 0) {
    const memText = memories.map(m => `- ${m.key}: ${m.value}`).join("\n");
    prompt += "\n\n## Saved Memories\n" + memText;
  }

  // 注入最近对话总结
  const recentConvos = loadRecentConversations(3);
  if (recentConvos.length > 0) {
    const convoText = recentConvos.map((c, i) => `${i+1}. [${c.time.slice(0,10)}] ${c.summary}`).join("\n");
    prompt += "\n\n## Recent Conversation Summaries\n" + convoText;
  }

  return prompt;
}

// ===== Tools =====
const tools = [
  {
    name: "bash",
    description: `Execute a bash command on the server. Use this for any system operation. When downloading files, save them to ${SHARED_DIR}`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        cwd: { type: "string", description: `Working directory for the command. Default: ${SHARED_DIR}` },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents with line numbers. Supports local (VPS) and remote (Mac/Windows via SSH) files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        target: { type: "string", enum: ["local", "mac", "win"], description: "Where the file is. Default: local (VPS)" },
        offset: { type: "number", description: "Start from this line (1-based). Default: 1" },
        limit: { type: "number", description: "Max lines to read. Default: 500" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "File content to write" },
        target: { type: "string", enum: ["local", "mac", "win"], description: "Default: local" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Make precise edits to a file by replacing exact string matches. Always read_file first before editing.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        old_string: { type: "string", description: "Exact string to find (must be unique in file)" },
        new_string: { type: "string", description: "Replacement string" },
        target: { type: "string", enum: ["local", "mac", "win"], description: "Default: local" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns file paths sorted by modification time.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.js', 'src/**/*.py'" },
        path: { type: "string", description: "Base directory to search in. Default: current working directory" },
        target: { type: "string", enum: ["local", "mac", "win"], description: "Default: local" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents using regex patterns. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search in" },
        include: { type: "string", description: "File pattern filter, e.g. '*.js'" },
        target: { type: "string", enum: ["local", "mac", "win"], description: "Default: local" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "send_file",
    description: "Send a file to the user in the chat. The file must already exist in the shared directory.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "The filename (not full path) in the shared directory to send" },
      },
      required: ["filename"],
    },
  },
  {
    name: "browse",
    description: "Browse a webpage with a real browser (Playwright). Can take screenshots, extract text, or save as PDF.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to browse" },
        action: { type: "string", enum: ["screenshot", "text", "pdf"], description: "screenshot, text extraction, or save as PDF" },
      },
      required: ["url"],
    },
  },
  {
    name: "schedule_task",
    description: "Schedule a task to run once after a delay OR on a recurring cron schedule. Output is pushed to chat automatically. Set ai_prompt to have AI process/translate the raw output before displaying.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute (for reminders, use: echo 'reminder message')" },
        cron: { type: "string", description: "Cron expression for recurring tasks (6 fields with seconds, or 5 fields standard)" },
        delay: { type: "number", description: "Run once after this many seconds. Use this for one-time tasks/reminders. e.g. 300 = 5 minutes" },
        description: { type: "string", description: "Human-readable description of the task" },
        ai_prompt: { type: "string", description: "If set, the command output will be processed by AI with this prompt before displaying. e.g. 'Translate to Chinese and format as a clean numbered news list with emoji headers'" },
      },
      required: ["description"],
    },
  },
  {
    name: "memory",
    description: "Save, update, delete, list, or search long-term memories. Memories persist across conversations. Use 'search' to find memories by keyword.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "delete", "list", "search"] },
        key: { type: "string", description: "Memory key/category" },
        value: { type: "string", description: "The information to remember (required for save)" },
        query: { type: "string", description: "Search keyword (for search action)" },
      },
      required: ["action"],
    },
  },
  {
    name: "download_media",
    description: "Download video or audio from YouTube, Bilibili, Twitter, TikTok, and 1000+ sites using yt-dlp. After download, the file is automatically sent to the user.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL of the video/audio to download" },
        format: { type: "string", enum: ["video", "audio"], description: "Download as video (mp4) or audio only (mp3). Default: video" },
        quality: { type: "string", description: "Quality: best, 720p, 480p, 360p. Default: best" },
      },
      required: ["url"],
    },
  },
  {
    name: "convert_media",
    description: "Convert or process media files using ffmpeg. Supports: video to mp3, compress video, trim/cut clips, merge files, extract subtitles, change format, resize, etc.",
    input_schema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input filename (in shared directory)" },
        output: { type: "string", description: "Output filename (will be saved to shared directory)" },
        options: { type: "string", description: "ffmpeg options/flags between input and output, e.g. '-ss 00:01:00 -t 30' to trim, '-vn -acodec libmp3lame' for mp3 extraction" },
      },
      required: ["input", "output"],
    },
  },
  {
    name: "search_web",
    description: "Search the internet for real-time information using DuckDuckGo. Returns titles, URLs, and snippets. Use this when you need current/up-to-date info.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        num_results: { type: "number", description: "Number of results to return (default: 5, max: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_url",
    description: "Read a web page and extract its main text content. Lighter and faster than browse — use this when you just need to read an article or page content, not take screenshots.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to read" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_js",
    description: "Execute JavaScript in the user's browser. Runs with the user's IP/cookies. Use for: fetching URLs blocked on VPS (e.g. YouTube), web scraping, downloading files. Code is an async function body — use 'return' to send result back.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Async JS function body. Has access to fetch(), document, etc. Use 'return' for results." },
        description: { type: "string", description: "What this code does (shown to user)" },
      },
      required: ["code"],
    },
  },
];

function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".flac", ".aac"].includes(ext)) return "audio";
  return "file";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ===== Scheduled Tasks =====
const scheduledTasks = [];
function broadcastToClients(data) {
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(data)); });
}

async function processScheduleOutput(taskData, rawOutput) {
  let output = rawOutput.slice(0, 5000);
  if (taskData.ai_prompt) {
    try {
      const aiResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: `${taskData.ai_prompt}\n\n---\nRaw data:\n${rawOutput.slice(0, 8000)}`
        }]
      });
      output = aiResponse.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    } catch (e) {
      console.error("[Schedule AI] Error:", e.message);
      // Fallback to raw output
    }
  }
  broadcastToClients({
    type: "schedule_result",
    taskId: taskData.id,
    description: taskData.description,
    command: taskData.command,
    output: output.slice(0, 5000),
  });
}

function registerScheduledTask(taskData) {
  const job = nodeCron.schedule(taskData.cron, async () => {
    const rawOutput = await execAsync(taskData.command);
    await processScheduleOutput(taskData, rawOutput);
  });
  scheduledTasks.push({ ...taskData, job });
}

// Restore scheduled tasks on startup
const savedSchedules = loadSchedules();
let nextTaskId = 1;
for (const s of savedSchedules) {
  if (nodeCron.validate(s.cron)) {
    registerScheduledTask(s);
    if (s.id >= nextTaskId) nextTaskId = s.id + 1;
  }
}
if (savedSchedules.length > 0) console.log(`[Schedule] Restored ${savedSchedules.length} tasks`);

// ===== Streaming Helper =====
async function streamResponse(ws, conversationHistory, abortSignal) {
  const systemPrompt = await getSystemPrompt();
  return new Promise((resolve, reject) => {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 16384,
      system: systemPrompt,
      tools,
      messages: conversationHistory,
    });

    let fullResponse = null;
    let aborted = false;

    // Handle abort
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        aborted = true;
        stream.abort();
        ws.send(JSON.stringify({ type: "stream_end" }));
        resolve(fullResponse);
      }, { once: true });
    }

    stream.on("text", (text) => {
      if (!aborted) ws.send(JSON.stringify({ type: "stream", text }));
    });

    stream.on("message", (message) => {
      fullResponse = message;
    });

    stream.on("error", (err) => {
      if (aborted) return resolve(fullResponse);
      reject(err);
    });

    stream.on("end", () => {
      if (!aborted) ws.send(JSON.stringify({ type: "stream_end" }));
      resolve(fullResponse);
    });
  });
}

// ===== Usage Tracking =====
// Sonnet pricing: $3/M input, $15/M output
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

// ===== Tool Execution =====
async function executeTool(block, ws, activeProcesses) {
  if (block.name === "bash") {
    ws.send(JSON.stringify({ type: "command", command: block.input.command }));
    const execPromise = execAsync(block.input.command, block.input.cwd ? { cwd: block.input.cwd } : {});
    if (execPromise.child) activeProcesses.push(execPromise.child);
    const output = await execPromise;
    if (execPromise.child) { const idx = activeProcesses.indexOf(execPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }
    if (output.trim()) ws.send(JSON.stringify({ type: "command_output", output: output.slice(0, 5000) }));
    return { type: "tool_result", tool_use_id: block.id, content: output.slice(0, 10000) };

  } else if (block.name === "send_file") {
    const filename = block.input.filename;
    const filePath = safePath(SHARED_DIR, filename);
    if (!filePath) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: Invalid filename "${filename}".`, is_error: true };
    }
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const fileType = getFileType(filename);
      ws.send(JSON.stringify({
        type: "file", filename, url: `/shared/${encodeURIComponent(filename)}`,
        fileType, size: formatSize(stat.size), sizeBytes: stat.size,
      }));
      return { type: "tool_result", tool_use_id: block.id, content: `File "${filename}" sent.` };
    } else {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: "${filename}" not found.`, is_error: true };
    }

  } else if (block.name === "browse") {
    const { url, action = "screenshot" } = block.input;
    if (!playwright) {
      return { type: "tool_result", tool_use_id: block.id, content: "Playwright not installed. Run: npm install playwright && npx playwright install chromium", is_error: true };
    }
    try {
      const browser = await playwright.chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Wait for page to fully render (networkidle + extra time for JS-heavy SPAs)
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2000);
      let result;
      if (action === "text") {
        result = (await page.innerText("body")).slice(0, 10000);
      } else if (action === "pdf") {
        const fname = `page_${Date.now()}.pdf`;
        const fpath = path.join(SHARED_DIR, fname);
        await page.pdf({ path: fpath, format: "A4" });
        const stat = fs.statSync(fpath);
        ws.send(JSON.stringify({ type: "file", filename: fname, url: `/shared/${encodeURIComponent(fname)}`, fileType: "file", size: formatSize(stat.size), sizeBytes: stat.size }));
        result = `PDF saved as ${fname} and sent.`;
      } else {
        const fname = `screenshot_${Date.now()}.png`;
        const fpath = path.join(SHARED_DIR, fname);
        await page.screenshot({ path: fpath, fullPage: false });
        const stat = fs.statSync(fpath);
        ws.send(JSON.stringify({ type: "file", filename: fname, url: `/shared/${encodeURIComponent(fname)}`, fileType: "image", size: formatSize(stat.size), sizeBytes: stat.size }));
        result = `Screenshot saved as ${fname} and sent.`;
      }
      await browser.close();
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Browse error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "download_media") {
    const { url, format = "video", quality = "best" } = block.input;
    try {
      let cmd;
      if (format === "audio") {
        cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${SHARED_DIR}/%(title)s.%(ext)s" --no-playlist --print filename "${url}"`;
      } else {
        const qualityMap = { "best": "bestvideo+bestaudio/best", "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]", "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]", "360p": "bestvideo[height<=360]+bestaudio/best[height<=360]" };
        const fmt = qualityMap[quality] || qualityMap["best"];
        cmd = `yt-dlp -f "${fmt}" --merge-output-format mp4 -o "${SHARED_DIR}/%(title)s.%(ext)s" --no-playlist --print filename "${url}"`;
      }
      ws.send(JSON.stringify({ type: "command", command: `yt-dlp: downloading ${format} from ${url}` }));
      const dlPromise = execAsync(cmd, { timeout: 600000 }); // 10 min timeout for large videos
      if (dlPromise.child) activeProcesses.push(dlPromise.child);
      const output = await dlPromise;
      if (dlPromise.child) { const idx = activeProcesses.indexOf(dlPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }
      const lines = output.trim().split("\n");
      const filename = path.basename(lines[lines.length - 1].trim());
      const filePath = path.join(SHARED_DIR, filename);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        const fileType = getFileType(filename);
        ws.send(JSON.stringify({ type: "file", filename, url: `/shared/${encodeURIComponent(filename)}`, fileType, size: formatSize(stat.size), sizeBytes: stat.size }));
        return { type: "tool_result", tool_use_id: block.id, content: `Downloaded and sent: ${filename} (${formatSize(stat.size)})` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `Download output:\n${output.slice(0, 3000)}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Download error: ${err}`, is_error: true };
    }

  } else if (block.name === "convert_media") {
    const { input: inputFile, output: outputFile, options = "" } = block.input;
    const inputPath = safePath(SHARED_DIR, inputFile);
    const outputPath = safePath(SHARED_DIR, outputFile);
    if (!inputPath || !outputPath) {
      return { type: "tool_result", tool_use_id: block.id, content: "Error: Invalid file path.", is_error: true };
    }
    if (!fs.existsSync(inputPath)) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: Input file "${inputFile}" not found.`, is_error: true };
    }
    try {
      const cmd = `ffmpeg -y -i "${inputPath}" ${options} "${outputPath}"`;
      ws.send(JSON.stringify({ type: "command", command: `ffmpeg: ${inputFile} → ${outputFile}` }));
      const ffPromise = execAsync(cmd, { timeout: 600000 });
      if (ffPromise.child) activeProcesses.push(ffPromise.child);
      const output = await ffPromise;
      if (ffPromise.child) { const idx = activeProcesses.indexOf(ffPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }
      if (fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        const fileType = getFileType(outputFile);
        ws.send(JSON.stringify({ type: "file", filename: outputFile, url: `/shared/${encodeURIComponent(outputFile)}`, fileType, size: formatSize(stat.size), sizeBytes: stat.size }));
        return { type: "tool_result", tool_use_id: block.id, content: `Converted: ${outputFile} (${formatSize(stat.size)})` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `ffmpeg output:\n${output.slice(0, 3000)}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Convert error: ${err}`, is_error: true };
    }

  } else if (block.name === "search_web") {
    const { query, num_results = 5 } = block.input;
    try {
      const encoded = encodeURIComponent(query);
      const cmd = `curl -sL "https://html.duckduckgo.com/html/?q=${encoded}" -H "User-Agent: Mozilla/5.0" | head -c 100000`;
      const html = await execAsync(cmd, { timeout: 15000 });
      // Parse DuckDuckGo HTML results
      const results = [];
      const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && results.length < Math.min(num_results, 10)) {
        const href = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        try {
          results.push({ title, url: decodeURIComponent(href), snippet });
        } catch { results.push({ title, url: href, snippet }); }
      }
      if (results.length === 0) {
        return { type: "tool_result", tool_use_id: block.id, content: `No results found for: "${query}"` };
      }
      const text = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return { type: "tool_result", tool_use_id: block.id, content: text };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Search error: ${err}`, is_error: true };
    }

  } else if (block.name === "read_url") {
    const { url } = block.input;
    try {
      // Try lightweight curl first
      const cmd = `curl -sL -m 15 -H "User-Agent: Mozilla/5.0 (compatible)" "${url}" | head -c 200000`;
      const html = await execAsync(cmd, { timeout: 20000 });
      // Extract text: strip scripts, styles, tags
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      text = text.slice(0, 15000);
      return { type: "tool_result", tool_use_id: block.id, content: text || "Could not extract text from this URL." };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Read error: ${err}`, is_error: true };
    }

  } else if (block.name === "schedule_task") {
    const { command = "echo 'Task triggered'", cron: cronExpr, delay, description: desc, ai_prompt } = block.input;
    const taskId = nextTaskId++;

    if (delay && delay > 0) {
      // One-time delayed task
      const delayMs = delay * 1000;
      const taskData = { id: taskId, description: desc, command, ai_prompt };
      setTimeout(async () => {
        const rawOutput = await execAsync(command);
        await processScheduleOutput(taskData, rawOutput);
      }, delayMs);
      const mins = delay >= 60 ? `${Math.round(delay / 60)} min` : `${delay}s`;
      return { type: "tool_result", tool_use_id: block.id, content: `One-time task #${taskId}: "${desc}" — will run in ${mins}` };
    }

    if (!cronExpr || !nodeCron.validate(cronExpr)) {
      return { type: "tool_result", tool_use_id: block.id, content: `Invalid cron: "${cronExpr}". Provide a valid cron expression or use delay for one-time tasks.`, is_error: true };
    }
    const taskData = { id: taskId, description: desc, cron: cronExpr, command, ai_prompt };
    registerScheduledTask(taskData);
    saveSchedules(scheduledTasks);
    return { type: "tool_result", tool_use_id: block.id, content: `Scheduled task #${taskId}: "${desc}" [${cronExpr}]` };

  } else if (block.name === "browser_js") {
    const { code, description: desc } = block.input;
    const execId = crypto.randomBytes(8).toString("hex");
    ws.send(JSON.stringify({ type: "browser_exec", id: execId, code, description: desc || "Executing in browser..." }));
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.removeListener("message", handler);
          reject(new Error("Browser execution timed out (60s)"));
        }, 60000);
        function handler(raw) {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === "browser_result" && msg.id === execId) {
              clearTimeout(timeout);
              ws.removeListener("message", handler);
              resolve(msg.result);
            } else if (msg.type === "browser_error" && msg.id === execId) {
              clearTimeout(timeout);
              ws.removeListener("message", handler);
              reject(new Error(msg.error));
            }
          } catch(e) {}
        }
        ws.on("message", handler);
      });
      return { type: "tool_result", tool_use_id: block.id, content: String(result).slice(0, 15000) };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Browser exec error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "read_file") {
    const { path: filePath, target = "local", offset = 1, limit = 500 } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `read_file: ${filePath} (${target})` }));
    try {
      let content;
      if (target === "local") {
        content = fs.readFileSync(filePath, "utf-8");
      } else {
        const cmd = target === "mac" ? `cat "${filePath}"` : `type "${filePath}"`;
        content = await sshExec(target, cmd);
      }
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`).join("\n");
      const result = numbered.slice(0, 15000);
      const info = `Lines ${start + 1}-${end} of ${lines.length}`;
      if (result.trim()) ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: `${info}\n${result}` };
    } catch (err) {
      const msg = `Error reading file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  } else if (block.name === "write_file") {
    const { path: filePath, content, target = "local" } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `write_file: ${filePath} (${target})` }));
    try {
      if (target === "local") {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
      } else {
        const b64 = Buffer.from(content).toString("base64");
        const cmd = target === "mac"
          ? `echo '${b64}' | base64 -d > "${filePath}"`
          : `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | Set-Content -Path '${filePath}' -NoNewline"`;
        await sshExec(target, cmd);
      }
      const lines = content.split("\n").length;
      const result = `File written: ${filePath} (${lines} lines, ${content.length} chars)`;
      ws.send(JSON.stringify({ type: "command_output", output: result }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      const msg = `Error writing file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  } else if (block.name === "edit_file") {
    const { path: filePath, old_string, new_string, target = "local" } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `edit_file: ${filePath} (${target})` }));
    try {
      let content;
      if (target === "local") {
        content = fs.readFileSync(filePath, "utf-8");
      } else {
        const cmd = target === "mac" ? `cat "${filePath}"` : `type "${filePath}"`;
        content = await sshExec(target, cmd);
      }
      // Count occurrences
      const count = content.split(old_string).length - 1;
      if (count === 0) {
        const msg = "Error: old_string not found in file. Read the file first to get the exact content.";
        ws.send(JSON.stringify({ type: "command_output", output: msg }));
        return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
      }
      if (count > 1) {
        const msg = `Error: old_string found ${count} times — must be unique. Provide more surrounding context to make it unique.`;
        ws.send(JSON.stringify({ type: "command_output", output: msg }));
        return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
      }
      const newContent = content.replace(old_string, new_string);
      if (target === "local") {
        fs.writeFileSync(filePath, newContent, "utf-8");
      } else {
        const b64 = Buffer.from(newContent).toString("base64");
        const cmd = target === "mac"
          ? `echo '${b64}' | base64 -d > "${filePath}"`
          : `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | Set-Content -Path '${filePath}' -NoNewline"`;
        await sshExec(target, cmd);
      }
      const result = `Edit applied to ${filePath}`;
      ws.send(JSON.stringify({ type: "command_output", output: result }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      const msg = `Error editing file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  } else if (block.name === "glob") {
    const { pattern, path: basePath = SHARED_DIR, target = "local" } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `glob: ${pattern} in ${basePath} (${target})` }));
    try {
      let output;
      if (target === "local") {
        const cmd = `find "${basePath}" -path "${basePath}/${pattern}" -type f 2>/dev/null | head -100`;
        output = await execAsync(cmd);
        if (!output.trim()) {
          // Fallback: use find with -name for simple patterns
          const namePattern = pattern.includes("/") ? pattern.split("/").pop() : pattern;
          const findCmd = `find "${basePath}" -name "${namePattern}" -type f 2>/dev/null | head -100`;
          output = await execAsync(findCmd);
        }
      } else {
        const cmd = target === "mac"
          ? `find "${basePath}" -name "${pattern.includes("/") ? pattern.split("/").pop() : pattern}" -type f 2>/dev/null | head -100`
          : `dir /s /b "${basePath}\\${pattern}" 2>nul`;
        output = await sshExec(target, cmd);
      }
      const result = output.trim() || "No files found.";
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
    } catch (err) {
      const msg = `Glob error: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  } else if (block.name === "grep") {
    const { pattern, path: searchPath = SHARED_DIR, include, target = "local" } = block.input;
    const includeFlag = include ? `--include="${include}"` : "";
    ws.send(JSON.stringify({ type: "command", command: `grep: "${pattern}" in ${searchPath} (${target})` }));
    try {
      let output;
      const grepCmd = `grep -rn ${includeFlag} "${pattern}" "${searchPath}" 2>/dev/null | head -200`;
      if (target === "local") {
        output = await execAsync(grepCmd);
      } else {
        output = await sshExec(target, grepCmd);
      }
      const result = output.trim() || "No matches found.";
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
    } catch (err) {
      const msg = `Grep error: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  } else if (block.name === "memory") {
    const { action, key, value, query } = block.input;
    let memories = loadMemory();
    let result;
    if (action === "save" && key && value) {
      const idx = memories.findIndex(m => m.key === key);
      const tags = autoTag(key, value);
      if (idx >= 0) {
        memories[idx].value = value;
        memories[idx].updated = new Date().toISOString();
        memories[idx].tags = tags;
      } else {
        memories.push({ key, value, tags, saved: new Date().toISOString() });
      }
      saveMemoryFile(memories);
      ws.send(JSON.stringify({ type: "memory_saved", key, value }));
      result = `Memory saved: ${key} = ${value} [tags: ${tags.join(", ")}]`;
    } else if (action === "delete" && key) {
      const before = memories.length;
      memories = memories.filter(m => m.key !== key);
      saveMemoryFile(memories);
      result = memories.length < before ? `Deleted: ${key}` : `Key "${key}" not found.`;
    } else if (action === "list") {
      if (memories.length === 0) {
        result = "No memories.";
      } else {
        // 按最近更新排序，显示 tag
        const sorted = memories.sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0));
        result = sorted.map(m => `[${(m.tags||[]).join(",")}] ${m.key}: ${m.value}`).join("\n");
      }
    } else if (action === "search" && (query || key)) {
      const q = query || key;
      const found = searchMemory(q);
      result = found.length === 0 ? `No memories matching "${q}".` : found.map(m => `[${(m.tags||[]).join(",")}] ${m.key}: ${m.value}`).join("\n");
    } else {
      result = "Invalid action. Use: save (key+value), delete (key), list, search (query).";
    }
    return { type: "tool_result", tool_use_id: block.id, content: result };
  }

  return { type: "tool_result", tool_use_id: block.id, content: "Unknown tool", is_error: true };
}

// ===== WebSocket =====
const wss = new WebSocketServer({ noServer: true });

// Authenticate WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  if (AUTH_PASSWORD && !isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Periodically check client PC connections and broadcast status
let lastClientStatus = { mac: false, win: false };
setInterval(async () => {
  const status = await getClientStatus();
  if (status.mac !== lastClientStatus.mac || status.win !== lastClientStatus.win) {
    lastClientStatus = status;
    const msg = JSON.stringify({ type: "client_status", mac: status.mac, win: status.win, clients: status.clients });
    wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
  }
}, 10000);

wss.on("connection", async (ws) => {
  console.log("Client connected");
  let conversationHistory = loadConversation();
  let currentAbort = null; // AbortController for current stream
  let cancelled = false;
  let activeProcesses = []; // Track child processes for cancel
  let sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };

  // Restore previous conversation to frontend
  if (conversationHistory.length > 0) {
    const restored = [];
    for (const msg of conversationHistory) {
      if (msg.role === "user") {
        // Extract text from user messages (skip tool_results)
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

  // Send current client PC status on connect
  const status = await getClientStatus();
  lastClientStatus = status;
  ws.send(JSON.stringify({ type: "client_status", mac: status.mac, win: status.win, clients: status.clients }));

  // Check restart flag — proactively say "I'm back"
  if (fs.existsSync(RESTART_FLAG_FILE)) {
    try {
      const flag = JSON.parse(fs.readFileSync(RESTART_FLAG_FILE, "utf-8"));
      if (flag.restarted) {
        const restartTime = new Date(flag.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        // Delete flag so we only send once
        fs.unlinkSync(RESTART_FLAG_FILE);
        // Small delay so client UI is ready
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
          // Also push into conversation history so it's persisted
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

      // Handle cancel request
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

      // Handle browser_js result from frontend
      if (parsed.type === "browser_result" || parsed.type === "browser_error") {
        // Handled by per-request listeners in executeTool
        return;
      }

      const { message, images } = parsed;

      if (message && message.trim() === "/clear") {
        conversationHistory = [];
        sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
        saveConversation(conversationHistory);
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
      let response = await streamResponse(ws, conversationHistory, currentAbort.signal);
      currentAbort = null;
      trackUsage(response, sessionUsage, ws);

      while (response && response.stop_reason === "tool_use" && !cancelled) {
        const assistantMessage = { role: "assistant", content: response.content };
        conversationHistory.push(assistantMessage);
        const toolBlocks = response.content.filter(b => b.type === "tool_use");
        const toolResults = cancelled ? [] : await Promise.all(
          toolBlocks.map(block => executeTool(block, ws, activeProcesses))
        );

        if (cancelled) {
          // Patch: add tool_results for all tool_use blocks so history stays valid
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
        response = await streamResponse(ws, conversationHistory, currentAbort.signal);
        currentAbort = null;
        trackUsage(response, sessionUsage, ws);
      }

      if (response && !cancelled) {
        conversationHistory.push({ role: "assistant", content: response.content });
      }
      saveConversation(conversationHistory);

    } catch (err) {
      currentAbort = null;
      if (cancelled || (err.name === "AbortError")) {
        // Patch history if last assistant message has tool_use without tool_result
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
    // 对话结束时自动总结并存储
    if (conversationHistory.length >= 4) {
      try {
        const recentMsgs = conversationHistory.slice(-10);
        const textOnly = recentMsgs
          .filter(m => typeof m.content === "string")
          .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
          .join("\n");
        if (textOnly.length > 100) {
          const summaryResp = await anthropic.messages.create({
            model: "claude-3-5-haiku-20241022",
            max_tokens: 300,
            messages: [{
              role: "user",
              content: `请用1-3句话总结以下对话的关键信息（用中文，简洁）：\n\n${textOnly}`
            }]
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
      } catch (e) { /* skip files we can't stat */ }
    }
    if (removed > 0) console.log(`[Cleanup] Removed ${removed} files older than 7 days from shared/`);
  } catch (e) { console.error("[Cleanup] Error:", e.message); }
}
// Run cleanup on startup and every 6 hours
cleanupSharedDir();
setInterval(cleanupSharedDir, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
// ===== Auto Update Check =====
let UPDATE_AVAILABLE = false;
let LATEST_COMMIT = null;

async function checkForUpdates() {
  try {
    const { execSync } = require("child_process");
    // 获取当前 commit
    const currentCommit = execSync("git -C /opt/her rev-parse HEAD", { encoding: "utf8" }).trim();
    // 获取远程最新 commit
    const res = await fetch("https://api.github.com/repos/aaaa-zhen/her/commits/main", {
      headers: { "User-Agent": "her-assistant" }
    });
    if (!res.ok) return;
    const data = await res.json();
    LATEST_COMMIT = data.sha;
    if (LATEST_COMMIT && LATEST_COMMIT !== currentCommit) {
      UPDATE_AVAILABLE = true;
      const msg = data.commit?.message || "";
      console.log(`[Update] New version available: ${LATEST_COMMIT.slice(0,7)} — ${msg}`);
    } else {
      UPDATE_AVAILABLE = false;
      console.log(`[Update] Already up to date (${currentCommit.slice(0,7)})`);
    }
  } catch (e) {
    console.log(`[Update] Check failed: ${e.message}`);
  }
}

app.get("/api/update-status", (req, res) => {
  res.json({ updateAvailable: UPDATE_AVAILABLE, latestCommit: LATEST_COMMIT });
});

server.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Shared dir: ${SHARED_DIR}`);
  console.log(`Mac bridge: ${MAC_DIR}`);
  if (AUTH_PASSWORD) console.log(`Auth: enabled (password protected)`);
  else console.log(`Auth: disabled (set AUTH_PASSWORD in .env to enable)`);

  // Detect public IP on startup
  PUBLIC_IP = await detectPublicIp();
  if (PUBLIC_IP) console.log(`Public IP: ${PUBLIC_IP} → http://${PUBLIC_IP}:${PORT}`);
  else console.log(`Public IP: could not detect`);

  // Check for updates on startup
  await checkForUpdates();
  // Check every 6 hours
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);

  // Write restart flag — will be picked up on next client connection
  const startTime = new Date().toISOString();
  fs.writeFileSync(RESTART_FLAG_FILE, JSON.stringify({ restarted: true, time: startTime }));
  console.log(`[Restart] Flag written at ${startTime}`);
});

// ===== System Info API =====
app.get("/api/system-info", async (req, res) => {
  const port = process.env.PORT || 3000;
  const ip = PUBLIC_IP || await detectPublicIp() || "unknown";
  if (!PUBLIC_IP && ip !== "unknown") PUBLIC_IP = ip;

  const macConnected = await checkPort(process.env.MAC_SSH_PORT || 6000);
  const winConnected = await checkPort(process.env.WIN_SSH_PORT || 6001);

  res.json({
    publicIp: ip,
    port,
    accessUrl: `http://${ip}:${port}`,
    herDir: "/opt/her",
    frpServerPort: process.env.FRP_PORT || 7000,
    macSshPort: process.env.MAC_SSH_PORT || 6000,
    winSshPort: process.env.WIN_SSH_PORT || 6001,
    macConnected,
    winConnected,
    frpcConfigMac: `[common]\nserver_addr = ${ip}\nserver_port = ${process.env.FRP_PORT || 7000}\n\n[mac-ssh]\ntype = tcp\nlocal_ip = 127.0.0.1\nlocal_port = 22\nremote_port = ${process.env.MAC_SSH_PORT || 6000}`,
    frpcConfigWin: `[common]\nserver_addr = ${ip}\nserver_port = ${process.env.FRP_PORT || 7000}\n\n[win-ssh]\ntype = tcp\nlocal_ip = 127.0.0.1\nlocal_port = 22\nremote_port = ${process.env.WIN_SSH_PORT || 6001}`,
  });
});
