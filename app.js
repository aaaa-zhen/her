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
  fs.writeFileSync(envFile, `PORT=3456\nAPI_KEY=\nAPI_BASE_URL=https://openrouter.ai/api/v1\nAUTH_PASSWORD=\n`);
}

// Copy index.html (try source dir first, fall back to embedded version for compiled binary)
const destHtml = path.join(HER_HOME, "public", "index.html");
const srcHtml = path.join(__dirname, "public", "index.html");
if (fs.existsSync(srcHtml)) {
  fs.copyFileSync(srcHtml, destHtml);
} else {
  try {
    const embedded = require("./lib/embedded-html");
    fs.writeFileSync(destHtml, embedded, "utf-8");
  } catch (e) {}
}

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
          result = await execLocal(input.command, input.cwd, input.timeout);
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
        case "find":
          result = await findLocal(input.pattern, input.path || homeDir, input.limit);
          break;
        case "grep":
          result = await grepLocal(input);
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
const { fuzzyFindText, normalizeForFuzzyMatch, normalizeToLF, restoreLineEndings, stripBom, detectLineEnding } = require("./lib/edit-diff");
const { spawnSync } = require("child_process");

function execLocal(command, cwd, timeout) {
  const timeoutMs = timeout ? timeout * 1000 : 120000;
  return new Promise((resolve) => {
    exec(command, {
      encoding: "utf-8", timeout: timeoutMs,
      cwd: cwd || homeDir,
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    }, (err, stdout, stderr) => {
      let output = (stdout || "") + (stderr || "");
      if (err && !output) output = err.message || "Command failed";
      if (err && err.killed) output += "\n\nCommand timed out";
      resolve(output);
    });
  });
}

function readLocalFile(filePath, offset = 1, limit = 500) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;
    const start = Math.max(0, offset - 1);
    if (start >= totalLines) return `Error: Offset ${offset} is beyond end of file (${totalLines} lines total)`;
    const end = Math.min(totalLines, start + limit);
    const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`).join("\n");
    let result = `Lines ${start + 1}-${end} of ${totalLines}\n${numbered}`;
    if (end < totalLines) result += `\n\n[${totalLines - end} more lines. Use offset=${end + 1} to continue.]`;
    return result;
  } catch (err) { return `Error: ${err.message}`; }
}

function writeLocalFile(filePath, content) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return `File written: ${filePath} (${content.split("\n").length} lines, ${content.length} bytes)`;
  } catch (err) { return `Error: ${err.message}`; }
}

function editLocalFile(filePath, oldString, newString) {
  try {
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const { bom, text: content } = stripBom(rawContent);
    const originalEnding = detectLineEnding(content);
    const normalized = normalizeToLF(content);
    const normalizedOld = normalizeToLF(oldString);
    const normalizedNew = normalizeToLF(newString);

    const match = fuzzyFindText(normalized, normalizedOld);
    if (!match.found) return "Error: old_string not found in file. Read the file first to get the exact content.";

    const fuzzyContent = normalizeForFuzzyMatch(normalized);
    const fuzzyOld = normalizeForFuzzyMatch(normalizedOld);
    const occurrences = fuzzyContent.split(fuzzyOld).length - 1;
    if (occurrences > 1) return `Error: old_string found ${occurrences} times — must be unique.`;

    const base = match.contentForReplacement;
    const newContent = base.substring(0, match.index) + normalizedNew + base.substring(match.index + match.matchLength);
    if (base === newContent) return "Error: Replacement produced identical content.";

    const finalContent = bom + restoreLineEndings(newContent, originalEnding);
    fs.writeFileSync(filePath, finalContent, "utf-8");
    return `Edit applied to ${filePath}${match.usedFuzzyMatch ? " (fuzzy match)" : ""}`;
  } catch (err) { return `Error: ${err.message}`; }
}

function findLocal(pattern, basePath, limit) {
  const effectiveLimit = limit || 200;
  // Try fd first
  try {
    const fdPath = execSync("which fd", { encoding: "utf-8" }).trim();
    if (fdPath) {
      const result = spawnSync(fdPath, ["--glob", "--color=never", "--hidden", "--max-results", String(effectiveLimit), pattern, basePath], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      const output = (result.stdout || "").trim();
      return output || "No files found.";
    }
  } catch (e) {}
  // Fallback
  const namePattern = pattern.includes("/") ? pattern.split("/").pop() : pattern;
  const cmd = process.platform === "win32"
    ? `dir /s /b "${basePath}\\${namePattern}" 2>nul`
    : `find "${basePath}" -name "${namePattern}" -type f 2>/dev/null | head -${effectiveLimit}`;
  return execLocal(cmd);
}

function grepLocal(input) {
  const { pattern, path: searchPath = homeDir, glob: globFilter, ignoreCase, literal, context, limit } = input;
  const effectiveLimit = limit || 100;
  // Try ripgrep first
  try {
    const rgPath = execSync("which rg", { encoding: "utf-8" }).trim();
    if (rgPath) {
      const args = ["--line-number", "--color=never", "--hidden"];
      if (ignoreCase) args.push("--ignore-case");
      if (literal) args.push("--fixed-strings");
      if (globFilter) args.push("--glob", globFilter);
      if (context && context > 0) args.push("-C", String(context));
      args.push("-m", String(effectiveLimit));
      args.push(pattern, searchPath);
      const result = spawnSync(rgPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      return (result.stdout || "").trim() || "No matches found.";
    }
  } catch (e) {}
  // Fallback
  const flags = ["-rn"];
  if (ignoreCase) flags.push("-i");
  if (literal) flags.push("-F");
  if (globFilter) flags.push(`--include=${globFilter}`);
  const cmd = process.platform === "win32"
    ? `findstr /s /n "${pattern}" "${searchPath}\\*" 2>nul`
    : `grep ${flags.join(" ")} "${pattern}" "${searchPath}" 2>/dev/null | head -${effectiveLimit}`;
  return execLocal(cmd);
}
