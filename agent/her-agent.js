#!/usr/bin/env node
/**
 * Her Local Agent
 *
 * Connects to Her server via WebSocket, executes commands locally.
 * Compile to single binary: bun build --compile her-agent.js --outfile her-agent
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { WebSocket } = require("ws");

// ===== Config =====
const CONFIG_FILE = path.join(os.homedir(), ".her-agent.json");

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ===== CLI Args =====
const args = process.argv.slice(2);
let serverUrl = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server" || args[i] === "-s") serverUrl = args[i + 1];
  if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Her Local Agent - Let Her control your computer

Usage:
  her-agent --server http://your-server:3000
  her-agent                                    (uses saved server)

Options:
  -s, --server URL   Her server URL
  -h, --help         Show this help
`);
    process.exit(0);
  }
}

const config = loadConfig();
if (serverUrl) {
  config.serverUrl = serverUrl;
  saveConfig(config);
} else {
  serverUrl = config.serverUrl;
}

if (!serverUrl) {
  // Interactive prompt
  process.stdout.write("Her server URL (e.g. http://localhost:3000): ");
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("", (answer) => {
    rl.close();
    serverUrl = answer.trim();
    if (!serverUrl) { console.log("No URL provided, exiting."); process.exit(1); }
    config.serverUrl = serverUrl;
    saveConfig(config);
    startAgent(serverUrl);
  });
} else {
  startAgent(serverUrl);
}

// ===== Agent =====
function execLocal(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      encoding: "utf-8",
      timeout: 120000,
      cwd: cwd || os.homedir(),
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    }, (err, stdout, stderr) => {
      if (err) resolve((stdout || "") + (stderr || err.message || "Command failed"));
      else resolve(stdout || stderr || "");
    });
  });
}

function readFile(filePath, offset = 1, limit = 500) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, offset - 1);
    const end = Math.min(lines.length, start + limit);
    const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`).join("\n");
    return `Lines ${start + 1}-${end} of ${lines.length}\n${numbered}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function writeFile(filePath, content) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    const lines = content.split("\n").length;
    return `File written: ${filePath} (${lines} lines, ${content.length} chars)`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function editFile(filePath, oldString, newString) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) return "Error: old_string not found in file.";
    if (count > 1) return `Error: old_string found ${count} times — must be unique.`;
    const newContent = content.replace(oldString, newString);
    fs.writeFileSync(filePath, newContent, "utf-8");
    return `Edit applied to ${filePath}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function globFiles(pattern, basePath) {
  // Simple glob using find/dir
  const cmd = process.platform === "win32"
    ? `dir /s /b "${basePath}\\${pattern}" 2>nul`
    : `find "${basePath}" -name "${pattern}" -type f 2>/dev/null | head -100`;
  return execLocal(cmd);
}

function grepFiles(pattern, searchPath, include) {
  const includeFlag = include ? `--include="${include}"` : "";
  const cmd = process.platform === "win32"
    ? `findstr /s /n "${pattern}" "${searchPath}\\*" 2>nul`
    : `grep -rn ${includeFlag} "${pattern}" "${searchPath}" 2>/dev/null | head -200`;
  return execLocal(cmd);
}

function startAgent(url) {
  const platform = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Linux";
  const username = os.userInfo().username;
  const homeDir = os.homedir();

  console.log(`
  ╔══════════════════════════════════════╗
  ║          Her Local Agent             ║
  ╠══════════════════════════════════════╣
  ║  Platform: ${(platform + "                     ").slice(0, 25)}║
  ║  User:     ${(username + "                     ").slice(0, 25)}║
  ║  Home:     ${(homeDir + "                     ").slice(0, 25)}║
  ║  Server:   ${(url + "                     ").slice(0, 25)}║
  ╚══════════════════════════════════════╝
  `);

  connect(url, platform, username, homeDir);
}

function connect(serverUrl, platform, username, homeDir) {
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/agent";

  console.log(`[Agent] Connecting to ${wsUrl}...`);

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error(`[Agent] Connection failed: ${err.message}`);
    scheduleReconnect(serverUrl, platform, username, homeDir);
    return;
  }

  ws.on("open", () => {
    console.log("[Agent] Connected!");
    // Register with server
    ws.send(JSON.stringify({
      type: "agent_register",
      platform,
      username,
      homeDir,
      hostname: os.hostname(),
    }));
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type !== "agent_exec") return;

      const { id, tool, input } = msg;
      let result = "";

      console.log(`[Agent] Executing: ${tool} ${tool === "bash" ? input.command?.slice(0, 60) : (input.path || "")}`);

      switch (tool) {
        case "bash":
          result = await execLocal(input.command, input.cwd);
          break;
        case "read_file":
          result = readFile(input.path, input.offset, input.limit);
          break;
        case "write_file":
          result = writeFile(input.path, input.content);
          break;
        case "edit_file":
          result = editFile(input.path, input.old_string, input.new_string);
          break;
        case "glob":
          result = await globFiles(input.pattern, input.path || homeDir);
          break;
        case "grep":
          result = await grepFiles(input.pattern, input.path || homeDir, input.include);
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
    console.log("[Agent] Disconnected");
    scheduleReconnect(serverUrl, platform, username, homeDir);
  });

  ws.on("error", (err) => {
    console.error(`[Agent] Error: ${err.message}`);
  });
}

function scheduleReconnect(serverUrl, platform, username, homeDir) {
  console.log("[Agent] Reconnecting in 5s...");
  setTimeout(() => connect(serverUrl, platform, username, homeDir), 5000);
}
