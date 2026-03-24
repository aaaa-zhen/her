#!/usr/bin/env node
/**
 * Her Desktop App
 *
 * Single binary that runs:
 * 1. Her server (API + WebSocket + Web UI)
 * 2. Local Agent (executes commands on user's computer)
 * 3. Opens browser automatically
 *
 * Build: bun build --compile app.js --external playwright --external playwright-core --external electron --outfile her
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { exec, execSync } = require("child_process");
const { WebSocket } = require("ws");

// ===== Setup ~/.her directory =====
const HER_HOME = path.join(os.homedir(), ".her");
["data", "shared", "public"].forEach(d => {
  const dir = path.join(HER_HOME, d);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Create default .env
const envFile = path.join(HER_HOME, ".env");
if (!fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, `PORT=3456\nAPI_KEY=sk-9NKHcNWacvBIfukWZ2QRCCmFBfTz2K74vt3uXXUU8rqLojd9\nAPI_BASE_URL=https://www.packyapi.com\nAUTH_PASSWORD=\n`);
}

// Copy index.html
const srcHtml = path.join(__dirname, "public", "index.html");
const destHtml = path.join(HER_HOME, "public", "index.html");
if (fs.existsSync(srcHtml)) fs.copyFileSync(srcHtml, destHtml);

// Set working dir and load env
if (!process.env.PORT) process.env.PORT = "3456";
process.chdir(HER_HOME);
require("dotenv").config({ path: envFile, override: false });

// Patch paths
const utils = require("./lib/utils");
Object.defineProperty(utils, "DATA_DIR", { get: () => path.join(HER_HOME, "data") });
Object.defineProperty(utils, "SHARED_DIR", { get: () => path.join(HER_HOME, "shared") });

// ===== Start Server =====
require("./server");

const port = process.env.PORT || 3456;
const platform = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Linux";
const username = os.userInfo().username;
const homeDir = os.homedir();

console.log(`
  ╔══════════════════════════════════════╗
  ║              Her                     ║
  ╠══════════════════════════════════════╣
  ║  ${(platform + "                               ").slice(0, 35)}║
  ║  ${(username + " @ " + os.hostname()).slice(0, 35).padEnd(35)}║
  ║  http://localhost:${(port + "                ").slice(0, 16)}   ║
  ╚══════════════════════════════════════╝
`);

// ===== Start Built-in Agent =====
function connectAgent() {
  const wsUrl = `ws://localhost:${port}/agent`;
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    setTimeout(connectAgent, 3000);
    return;
  }

  ws.on("open", () => {
    console.log("[Agent] Local agent connected");
    ws.send(JSON.stringify({
      type: "agent_register",
      platform, username, homeDir,
      hostname: os.hostname(),
    }));
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (msg.type !== "agent_exec") return;

      const { id, tool, input } = msg;
      let result = "";

      switch (tool) {
        case "bash":
          result = await execLocal(input.command, input.cwd);
          break;
        case "read_file":
          result = readLocalFile(input.path, input.offset, input.limit);
          break;
        case "write_file":
          result = writeLocalFile(input.path, input.content);
          break;
        case "edit_file":
          result = editLocalFile(input.path, input.old_string, input.new_string);
          break;
        case "glob":
          result = await globLocal(input.pattern, input.path || homeDir);
          break;
        case "grep":
          result = await grepLocal(input.pattern, input.path || homeDir, input.include);
          break;
        default:
          result = `Unknown tool: ${tool}`;
      }

      ws.send(JSON.stringify({ type: "agent_result", id, result: result.slice(0, 50000) }));
    } catch (err) {
      console.error("[Agent] Error:", err.message);
    }
  });

  ws.on("close", () => {
    setTimeout(connectAgent, 3000);
  });

  ws.on("error", () => {});
}

// Start agent after server is ready
setTimeout(connectAgent, 2000);

// Open browser (skip when running as Tauri sidecar)
if (!process.env.TAURI_ENV) {
  setTimeout(() => {
    const url = `http://localhost:${port}`;
    console.log(`  Opening ${url} ...\n`);
    const cmd = process.platform === "darwin" ? `open "${url}"`
      : process.platform === "win32" ? `start "" "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }, 3000);
}

// ===== Agent Tool Functions =====
function execLocal(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      encoding: "utf-8", timeout: 120000,
      cwd: cwd || homeDir,
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    }, (err, stdout, stderr) => {
      if (err) resolve((stdout || "") + (stderr || err.message || "Command failed"));
      else resolve(stdout || stderr || "");
    });
  });
}

function readLocalFile(filePath, offset = 1, limit = 500) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`).join("\n");
    return `Lines ${start + 1}-${end} of ${lines.length}\n${numbered}`;
  } catch (err) { return `Error: ${err.message}`; }
}

function writeLocalFile(filePath, content) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return `File written: ${filePath} (${content.split("\n").length} lines)`;
  } catch (err) { return `Error: ${err.message}`; }
}

function editLocalFile(filePath, oldString, newString) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) return "Error: old_string not found in file.";
    if (count > 1) return `Error: old_string found ${count} times — must be unique.`;
    fs.writeFileSync(filePath, content.replace(oldString, newString), "utf-8");
    return `Edit applied to ${filePath}`;
  } catch (err) { return `Error: ${err.message}`; }
}

function globLocal(pattern, basePath) {
  const cmd = process.platform === "win32"
    ? `dir /s /b "${basePath}\\${pattern}" 2>nul`
    : `find "${basePath}" -name "${pattern}" -type f 2>/dev/null | head -100`;
  return execLocal(cmd);
}

function grepLocal(pattern, searchPath, include) {
  const includeFlag = include ? `--include="${include}"` : "";
  const cmd = process.platform === "win32"
    ? `findstr /s /n "${pattern}" "${searchPath}\\*" 2>nul`
    : `grep -rn ${includeFlag} "${pattern}" "${searchPath}" 2>/dev/null | head -200`;
  return execLocal(cmd);
}
