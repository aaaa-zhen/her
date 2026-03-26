const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, spawnSync, execSync } = require("child_process");
const { SHARED_DIR, execAsync, safePath, getFileType, formatSize } = require("./utils");
const { loadMemory, saveMemoryFile, searchMemory, autoTag } = require("./memory");
const { fuzzyFindText, normalizeForFuzzyMatch, normalizeToLF, restoreLineEndings, stripBom, detectLineEnding } = require("./edit-diff");
const skills = require("./skills");

let playwright = null;
try { playwright = require("playwright"); } catch (e) {}

// ===== External tool detection (cached) =====
let _rgPath = null;
let _fdPath = null;
let _rgChecked = false;
let _fdChecked = false;

function findRg() {
  if (_rgChecked) return _rgPath;
  _rgChecked = true;
  try { _rgPath = execSync("which rg", { encoding: "utf-8" }).trim(); } catch (e) {}
  return _rgPath;
}

function findFd() {
  if (_fdChecked) return _fdPath;
  _fdChecked = true;
  try { _fdPath = execSync("which fd", { encoding: "utf-8" }).trim(); } catch (e) {}
  return _fdPath;
}

// ===== Output truncation =====
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 128 * 1024;

function truncateOutput(text, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES) {
  if (!text) return { content: text, truncated: false };
  const byteLen = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");
  if (lines.length <= maxLines && byteLen <= maxBytes) {
    return { content: text, truncated: false };
  }
  // Truncate from head, keep tail (most recent output)
  let kept = lines.slice(-maxLines);
  let result = kept.join("\n");
  while (Buffer.byteLength(result, "utf-8") > maxBytes && kept.length > 1) {
    kept.shift();
    result = kept.join("\n");
  }
  return {
    content: result,
    truncated: true,
    totalLines: lines.length,
    shownLines: kept.length,
  };
}

// Tools to exclude for non-Claude models (weaker tool-use ability)
const ADVANCED_ONLY_TOOLS = new Set([
  "edit_file",    // write_file is enough; edit_file requires precise string matching
  "find",         // bash can do: find/ls/fd
  "grep",         // bash can do: grep/rg
  "send_file",    // send_local_file covers this
  "recent_files", // bash can do: ls -lt
  "browse",       // read_url is enough; browse needs Playwright
  "browser_js",   // too advanced for weak models
]);

// ===== Tool Definitions =====
function getToolDefinitions(model) {
  const isClaudeModel = model && (model.startsWith("claude-") || model.startsWith("anthropic/"));
  const allTools = [
    {
      name: "bash",
      description: `Execute a bash command. Supports timeout. Set target to "user" to run on the user's local computer (requires agent). Default runs on the server. Output is truncated to last ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB.`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          cwd: { type: "string", description: "Working directory for the command" },
          timeout: { type: "number", description: "Timeout in seconds (optional)" },
          target: { type: "string", enum: ["server", "user"], description: "Where to run: server (default) or user's local computer" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: `Read file contents with line numbers. Output is truncated to ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB. Use offset/limit for large files — continue with offset until complete.`,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          offset: { type: "number", description: "Start from this line (1-based). Default: 1" },
          limit: { type: "number", description: "Max lines to read. Default: 500" },
          target: { type: "string", enum: ["server", "user"], description: "Where to read: server (default) or user's computer" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file. Automatically creates parent directories. Set target to 'user' to write to user's computer.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          content: { type: "string", description: "File content to write" },
          target: { type: "string", enum: ["server", "user"], description: "Where to write: server (default) or user's computer" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Make precise edits to a file by replacing text. Supports fuzzy matching (handles Unicode quotes, dashes, trailing whitespace differences). Always read_file first. The old_string must be unique in the file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          old_string: { type: "string", description: "Text to find (must be unique in file)" },
          new_string: { type: "string", description: "Replacement text" },
          target: { type: "string", enum: ["server", "user"], description: "Where to edit: server (default) or user's computer" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "find",
      description: "Find files matching a glob pattern. Uses fd if available, falls back to find. Respects .gitignore. Returns relative paths sorted by name.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. '*.js', '**/*.py', 'src/**/*.ts'" },
          path: { type: "string", description: "Base directory to search in. Default: current working directory" },
          limit: { type: "number", description: "Maximum number of results (default: 200)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description: "Search file contents for a pattern. Uses ripgrep if available, falls back to grep. Respects .gitignore. Returns matching lines with file paths and line numbers.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex by default)" },
          path: { type: "string", description: "File or directory to search in" },
          glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.js' or '**/*.spec.ts'" },
          ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
          literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
          context: { type: "number", description: "Number of context lines before and after each match (default: 0)" },
          limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
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
      name: "send_local_file",
      description: "Send any file from the user's computer to the chat. Use this to show images, videos, or any file from an absolute path on the machine. Works with any file type — images display inline, videos play in chat, other files show a download link.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file on the computer, e.g. /Users/xxx/Desktop/photo.jpg" },
        },
        required: ["path"],
      },
    },
    {
      name: "recent_files",
      description: "List recently modified files on this Mac. Shows what the user has been working on. Uses macOS Spotlight (mdfind) for fast search.",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days back to look (default: 1, max: 7)" },
          limit: { type: "number", description: "Max files to return (default: 20, max: 50)" },
          folder: { type: "string", description: "Specific folder to search in (default: home directory)" },
          type: { type: "string", description: "File type filter: image, video, audio, document, code, or any (default: any)" },
        },
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
      description: "Download video or audio from Douyin, YouTube, Bilibili, Twitter/X, TikTok and other sites. Handles Douyin anti-scraping automatically. Saves to Desktop. Auto-installs yt-dlp if needed. Shows download progress. If max_size_mb is set and the downloaded file exceeds it, auto-compresses with ffmpeg.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL of the video/audio to download" },
          format: { type: "string", enum: ["video", "audio"], description: "Download as video (mp4) or audio only (mp3). Default: video" },
          quality: { type: "string", description: "Quality: best, 720p, 480p, 360p. Default: best" },
          max_size_mb: { type: "number", description: "Max file size in MB. If the downloaded file exceeds this, it will be auto-compressed. Use 200 for WeChat. Default: no limit" },
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
    {
      name: "skill_manage",
      description: "Create, edit, patch, delete, list, or view skills. Skills are reusable procedures learned from experience — capture 'how to do X' so you can reuse them in future conversations. Create a skill when you discover a non-trivial approach through trial-and-error.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "edit", "patch", "delete", "list", "view"], description: "Action to perform" },
          name: { type: "string", description: "Skill name (lowercase, hyphens ok). Required for create/edit/patch/delete/view." },
          description: { type: "string", description: "When to use this skill (for create/edit)" },
          body: { type: "string", description: "Full markdown content of the skill (for create/edit)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorization (for create/edit)" },
          old_text: { type: "string", description: "Text to find (for patch)" },
          new_text: { type: "string", description: "Replacement text (for patch)" },
        },
        required: ["action"],
      },
    },
  ];

  if (isClaudeModel || !model) {
    return allTools;
  }
  // Non-Claude: return only essential tools (17 → 10)
  const filtered = allTools.filter(t => !ADVANCED_ONLY_TOOLS.has(t.name));
  console.log(`[Tools] ${model}: ${filtered.length} tools (reduced from ${allTools.length})`);
  return filtered;
}

// Agent exec function — set by server.js
let _agentExec = null;
let _isAgentConnected = null;

function setAgentFunctions(agentExec, isAgentConnected) {
  _agentExec = agentExec;
  _isAgentConnected = isAgentConnected;
}

// ===== Bash with spawn, streaming, timeout, truncation =====
function executeBash(command, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || "/bin/bash";
    const child = spawn(shell, ["-c", command], {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks = [];
    let totalBytes = 0;
    let tempFilePath = null;
    let tempStream = null;
    let timedOut = false;
    let timeoutHandle;

    if (timeout && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, "SIGTERM"); } catch (e) {
          try { child.kill("SIGTERM"); } catch (e2) {}
        }
      }, timeout * 1000);
    }

    const onData = (data) => {
      totalBytes += data.length;
      chunks.push(data);
      // Spill to temp file for large output
      if (totalBytes > MAX_OUTPUT_BYTES * 2 && !tempFilePath) {
        tempFilePath = path.join(os.tmpdir(), `her-bash-${crypto.randomBytes(4).toString("hex")}.log`);
        tempStream = fs.createWriteStream(tempFilePath);
        for (const c of chunks) tempStream.write(c);
      }
      if (tempStream) tempStream.write(data);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (tempStream) tempStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (tempStream) tempStream.end();

      const fullOutput = Buffer.concat(chunks).toString("utf-8");
      const trunc = truncateOutput(fullOutput);
      let output = trunc.content;

      if (trunc.truncated) {
        output += `\n\n[Showing last ${trunc.shownLines} of ${trunc.totalLines} lines${tempFilePath ? `. Full output: ${tempFilePath}` : ""}]`;
      }

      if (timedOut) {
        output += `\n\nCommand timed out after ${timeout} seconds`;
      } else if (code !== 0 && code !== null) {
        output += `\n\nExit code ${code}`;
      }

      resolve({ output, code, child });
    });

    // Expose child for process tracking
    resolve.child = child;
  });
}

// ===== Edit with fuzzy matching =====
function executeEdit(filePath, oldString, newString) {
  const rawContent = fs.readFileSync(filePath, "utf-8");
  const { bom, text: content } = stripBom(rawContent);
  const originalEnding = detectLineEnding(content);
  const normalized = normalizeToLF(content);
  const normalizedOld = normalizeToLF(oldString);
  const normalizedNew = normalizeToLF(newString);

  const match = fuzzyFindText(normalized, normalizedOld);

  if (!match.found) {
    throw new Error("old_string not found in file. Read the file first to get the exact content.");
  }

  // Check uniqueness via fuzzy-normalized content
  const fuzzyContent = normalizeForFuzzyMatch(normalized);
  const fuzzyOld = normalizeForFuzzyMatch(normalizedOld);
  const occurrences = fuzzyContent.split(fuzzyOld).length - 1;

  if (occurrences > 1) {
    throw new Error(`old_string found ${occurrences} times — must be unique. Provide more surrounding context.`);
  }

  const base = match.contentForReplacement;
  const newContent = base.substring(0, match.index) + normalizedNew + base.substring(match.index + match.matchLength);

  if (base === newContent) {
    throw new Error("Replacement produced identical content. The old_string and new_string may be the same.");
  }

  const finalContent = bom + restoreLineEndings(newContent, originalEnding);
  fs.writeFileSync(filePath, finalContent, "utf-8");

  return { fuzzy: match.usedFuzzyMatch };
}

// ===== Grep with ripgrep =====
function executeGrep({ pattern, searchPath, glob: globFilter, ignoreCase, literal, context, limit }) {
  const effectiveLimit = Math.max(1, limit || 100);
  const rgPath = findRg();

  if (rgPath) {
    // Use ripgrep
    const args = ["--line-number", "--color=never", "--hidden"];
    if (ignoreCase) args.push("--ignore-case");
    if (literal) args.push("--fixed-strings");
    if (globFilter) args.push("--glob", globFilter);
    if (context && context > 0) args.push("-C", String(context));
    args.push("-m", String(effectiveLimit));
    args.push(pattern, searchPath);

    const result = spawnSync(rgPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    const output = (result.stdout || "").trim();
    if (!output) return "No matches found.";

    const trunc = truncateOutput(output);
    let text = trunc.content;
    if (trunc.truncated) {
      text += `\n\n[Truncated: showing ${trunc.shownLines} of ${trunc.totalLines} lines]`;
    }
    return text;
  }

  // Fallback to grep
  const flags = ["-rn"];
  if (ignoreCase) flags.push("-i");
  if (literal) flags.push("-F");
  if (globFilter) flags.push(`--include=${globFilter}`);
  if (context && context > 0) flags.push(`-C ${context}`);
  const cmd = `grep ${flags.join(" ")} "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -${effectiveLimit * (1 + (context || 0) * 2)}`;
  try {
    const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
    return output || "No matches found.";
  } catch (e) {
    // grep returns exit 1 for no matches
    return "No matches found.";
  }
}

// ===== Find with fd =====
function executeFind({ pattern, searchPath, limit }) {
  const effectiveLimit = limit || 200;
  const fdPath = findFd();

  if (fdPath) {
    const args = ["--glob", "--color=never", "--hidden", "--max-results", String(effectiveLimit), pattern, searchPath];
    const result = spawnSync(fdPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    const output = (result.stdout || "").trim();
    if (!output) return "No files found.";

    // Convert to relative paths
    const lines = output.split("\n").map(line => {
      const l = line.trim();
      if (l.startsWith(searchPath)) return l.slice(searchPath.length + 1);
      return l;
    }).filter(Boolean);

    const trunc = truncateOutput(lines.join("\n"));
    let text = trunc.content;
    if (lines.length >= effectiveLimit) {
      text += `\n\n[${effectiveLimit} results limit. Use limit=${effectiveLimit * 2} for more, or refine pattern]`;
    }
    return text;
  }

  // Fallback to find
  const namePattern = pattern.includes("/") ? pattern.split("/").pop() : pattern;
  const cmd = `find "${searchPath}" -name "${namePattern}" -type f 2>/dev/null | head -${effectiveLimit}`;
  try {
    const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
    return output || "No files found.";
  } catch (e) {
    return "No files found.";
  }
}

// ===== Download helpers =====

function getDownloadDir() {
  const herDir = path.join(os.homedir(), "Her");
  if (!fs.existsSync(herDir)) fs.mkdirSync(herDir, { recursive: true });
  return herDir;
}

async function checkCommand(name) {
  try {
    const result = execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8" });
    return result.trim().length > 0;
  } catch (_) { return false; }
}

async function ensureYtDlp(ws) {
  if (await checkCommand("yt-dlp")) return true;
  ws.send(JSON.stringify({ type: "progress", percent: 0, detail: "正在安装 yt-dlp…" }));
  try {
    if (process.platform === "darwin" && await checkCommand("brew")) {
      try { execSync("brew install yt-dlp 2>&1", { timeout: 120000 }); if (await checkCommand("yt-dlp")) return true; } catch (_) {}
    }
    for (const pip of ["pip3", "pip"]) {
      if (await checkCommand(pip)) {
        try { execSync(`${pip} install --user yt-dlp 2>&1`, { timeout: 120000 }); if (await checkCommand("yt-dlp")) return true; } catch (_) {}
      }
    }
    // Direct download
    const binDir = path.join(os.homedir(), ".local", "bin");
    try { fs.mkdirSync(binDir, { recursive: true }); } catch (_) {}
    execSync(`curl -L -o "${binDir}/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" && chmod +x "${binDir}/yt-dlp"`, { timeout: 60000 });
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    return await checkCommand("yt-dlp");
  } catch (_) {}
  return false;
}

async function detectBrowserForCookies() {
  for (const browser of ["chrome", "edge", "safari", "firefox"]) {
    const appNames = { chrome: "Google Chrome", edge: "Microsoft Edge", safari: "Safari", firefox: "Firefox" };
    try {
      if (process.platform === "darwin") {
        if (fs.existsSync(`/Applications/${appNames[browser]}.app`)) return browser;
      } else {
        if (await checkCommand(browser)) return browser;
      }
    } catch (_) {}
  }
  return null;
}

function downloadWithYtDlpProgress(args, cwd, activeProcesses, ws) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    activeProcesses.push(child);
    let output = "";
    let lastPercent = -1;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("下载超时")); }, 600000);

    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      output += text;
      const match = text.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\w+)/);
      if (match) {
        const percent = Math.round(parseFloat(match[1]));
        if (percent !== lastPercent) {
          lastPercent = percent;
          ws.send(JSON.stringify({ type: "progress", percent, detail: `下载中 ${percent}% · ${match[2]}` }));
        }
      }
      if (/\[Merger\]|\[ffmpeg\]/.test(text)) {
        ws.send(JSON.stringify({ type: "progress", percent: 100, detail: "合并视频音频中…" }));
      }
    });

    child.on("close", code => {
      clearTimeout(timer);
      const idx = activeProcesses.indexOf(child);
      if (idx !== -1) activeProcesses.splice(idx, 1);
      if (code === 0) resolve(output);
      else reject(new Error(`yt-dlp exited with code ${code}\n${output.slice(-500)}`));
    });
    child.on("error", err => {
      clearTimeout(timer);
      const idx = activeProcesses.indexOf(child);
      if (idx !== -1) activeProcesses.splice(idx, 1);
      reject(err);
    });
  });
}

// ===== Tool Execution =====
async function executeTool(block, ws, activeProcesses, schedulerCtx) {
  // Route to local agent if target is "user" and agent is connected
  const target = block.input?.target;
  if (target === "user") {
    if (!_isAgentConnected || !_isAgentConnected()) {
      return { type: "tool_result", tool_use_id: block.id, content: "Error: Local agent is not connected. Ask the user to start the Her agent on their computer.", is_error: true };
    }
    const agentTools = ["bash", "read_file", "write_file", "edit_file", "find", "grep"];
    if (agentTools.includes(block.name)) {
      try {
        ws.send(JSON.stringify({ type: "command", command: `[User PC] ${block.name}: ${block.input.command || block.input.path || block.input.pattern || ""}` }));
        const result = await _agentExec(block.name, block.input);
        if (result.trim()) ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
        return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
      } catch (err) {
        return { type: "tool_result", tool_use_id: block.id, content: `Agent error: ${err.message}`, is_error: true };
      }
    }
  }

  // ===== Bash =====
  if (block.name === "bash") {
    ws.send(JSON.stringify({ type: "command", command: block.input.command }));
    try {
      const { output, child } = await executeBash(block.input.command, block.input.cwd, block.input.timeout);
      if (child) activeProcesses.push(child);
      if (output.trim()) ws.send(JSON.stringify({ type: "command_output", output: output.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: output.slice(0, 15000) };
    } catch (err) {
      const msg = `Bash error: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  // ===== Read File =====
  } else if (block.name === "read_file") {
    const { path: filePath, offset = 1, limit = 500 } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `read_file: ${filePath}` }));
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const allLines = content.split("\n");
      const totalLines = allLines.length;
      const start = Math.max(0, offset - 1);

      if (start >= allLines.length) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: Offset ${offset} is beyond end of file (${totalLines} lines total)`, is_error: true };
      }

      const end = Math.min(allLines.length, start + limit);
      const numbered = allLines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`).join("\n");

      const trunc = truncateOutput(numbered);
      let result = trunc.content;
      const info = `Lines ${start + 1}-${end} of ${totalLines}`;

      // Continuation guidance
      if (end < totalLines) {
        result += `\n\n[${totalLines - end} more lines. Use offset=${end + 1} to continue.]`;
      }
      if (trunc.truncated) {
        result += `\n[Truncated: showing ${trunc.shownLines} of ${trunc.totalLines} output lines]`;
      }

      if (result.trim()) ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: `${info}\n${result}` };
    } catch (err) {
      const msg = `Error reading file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  // ===== Write File =====
  } else if (block.name === "write_file") {
    const { path: filePath, content } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `write_file: ${filePath}` }));
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      const lines = content.split("\n").length;
      const result = `File written: ${filePath} (${lines} lines, ${content.length} bytes)`;
      ws.send(JSON.stringify({ type: "command_output", output: result }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      const msg = `Error writing file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  // ===== Edit File (with fuzzy matching) =====
  } else if (block.name === "edit_file") {
    const { path: filePath, old_string, new_string } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `edit_file: ${filePath}` }));
    try {
      const { fuzzy } = executeEdit(filePath, old_string, new_string);
      const note = fuzzy ? " (fuzzy match)" : "";
      const result = `Edit applied to ${filePath}${note}`;
      ws.send(JSON.stringify({ type: "command_output", output: result }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      const msg = `Error editing file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  // ===== Find (glob) =====
  } else if (block.name === "find") {
    const { pattern, path: basePath = process.cwd() } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `find: ${pattern} in ${basePath}` }));
    try {
      const result = executeFind({ pattern, searchPath: basePath, limit: block.input.limit });
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 15000) };
    } catch (err) {
      const msg = `Find error: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  // ===== Grep =====
  } else if (block.name === "grep") {
    const { pattern, path: searchPath = process.cwd(), glob: globFilter, ignoreCase, literal, context, limit } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `grep: "${pattern}" in ${searchPath}` }));
    try {
      const result = executeGrep({ pattern, searchPath, glob: globFilter, ignoreCase, literal, context, limit });
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 15000) };
    } catch (err) {
      const msg = `Grep error: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  // ===== Send File =====
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

  // ===== Send Local File =====
  } else if (block.name === "send_local_file") {
    const filePath = block.input.path;
    if (!filePath || !path.isAbsolute(filePath)) {
      return { type: "tool_result", tool_use_id: block.id, content: "Error: path must be an absolute path.", is_error: true };
    }
    if (!fs.existsSync(filePath)) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: file not found: ${filePath}`, is_error: true };
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return { type: "tool_result", tool_use_id: block.id, content: "Error: path is not a file.", is_error: true };
      }
      const filename = path.basename(filePath);
      const fileType = getFileType(filename);
      const url = `/api/local-file?path=${encodeURIComponent(filePath)}`;
      ws.send(JSON.stringify({
        type: "file", filename, url, fileType,
        size: formatSize(stat.size), sizeBytes: stat.size,
      }));

      // For images: include base64 in tool result so AI can see the image content
      if (fileType === "image" && stat.size < 10 * 1024 * 1024) {
        const ext = path.extname(filename).slice(1).toLowerCase();
        const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
        const mimeType = mimeMap[ext] || "image/jpeg";
        const base64 = fs.readFileSync(filePath).toString("base64");
        return {
          type: "tool_result", tool_use_id: block.id,
          content: [
            { type: "text", text: `File "${filename}" (${formatSize(stat.size)}) sent to chat.` },
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
          ],
        };
      }

      return { type: "tool_result", tool_use_id: block.id, content: `File "${filename}" (${formatSize(stat.size)}) sent to chat.` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  // ===== Recent Files =====
  } else if (block.name === "recent_files") {
    const days = Math.min(block.input.days || 1, 7);
    const limit = Math.min(block.input.limit || 20, 50);
    const folder = block.input.folder || os.homedir();
    const fileTypeFilter = block.input.type || "any";

    ws.send(JSON.stringify({ type: "command", command: `recent_files: last ${days} day(s) in ${folder}` }));
    try {
      // Build mdfind query
      let contentType = "";
      const typeMap = {
        image: "kMDItemContentTypeTree == 'public.image'",
        video: "kMDItemContentTypeTree == 'public.movie'",
        audio: "kMDItemContentTypeTree == 'public.audio'",
        document: "(kMDItemContentTypeTree == 'public.text' || kMDItemContentTypeTree == 'org.openxmlformats.*' || kMDItemContentTypeTree == 'com.microsoft.*' || kMDItemContentTypeTree == 'com.adobe.pdf')",
        code: "(kMDItemContentTypeTree == 'public.source-code' || kMDItemContentTypeTree == 'public.script')",
      };
      if (fileTypeFilter !== "any" && typeMap[fileTypeFilter]) {
        contentType = ` && ${typeMap[fileTypeFilter]}`;
      }

      const cmd = `mdfind 'kMDItemFSContentChangeDate >= $time.today(-${days})${contentType}' -onlyin "${folder}" 2>/dev/null | grep -v '/Library/' | grep -v '/\\.' | grep -v 'node_modules' | grep -v '__pycache__' | head -${limit}`;
      const output = await execAsync(cmd, { timeout: 10000 });
      const files = output.trim().split("\n").filter(Boolean);
      if (files.length === 0) {
        return { type: "tool_result", tool_use_id: block.id, content: "No recently modified files found." };
      }
      const result = `Recently modified files (last ${days} day${days > 1 ? "s" : ""}):\n${files.join("\n")}`;
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  // ===== Browse =====
  } else if (block.name === "browse") {
    const { url, action = "screenshot" } = block.input;
    if (!playwright) {
      return { type: "tool_result", tool_use_id: block.id, content: "Playwright not installed. Run: npm install playwright && npx playwright install chromium", is_error: true };
    }
    try {
      const browser = await playwright.chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
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

  // ===== Download Media =====
  } else if (block.name === "download_media") {
    const { url, format = "video", quality = "best", max_size_mb } = block.input;
    if (!/^https?:\/\//i.test(url)) {
      return { type: "tool_result", tool_use_id: block.id, content: "Invalid URL", is_error: true };
    }
    try {
      const isDouyin = /douyin\.com|iesdouyin\.com/i.test(url);
      const isBilibili = /bilibili\.com|b23\.tv/i.test(url);
      const maxSizeBytes = max_size_mb ? max_size_mb * 1024 * 1024 : null;
      const dlDir = getDownloadDir();

      // Helper: emit progress to frontend
      const emitProgress = (percent, detail) => {
        ws.send(JSON.stringify({ type: "progress", percent, detail }));
      };

      // Helper: emit file to chat, symlink to shared dir
      const emitDownloadedFile = (filePath) => {
        const filename = path.basename(filePath);
        const stat = fs.statSync(filePath);
        const fileType = getFileType(filename);
        // Symlink into shared dir so the URL works
        const sharedLink = safePath(SHARED_DIR, filename);
        if (sharedLink && sharedLink !== filePath) {
          try { fs.unlinkSync(sharedLink); } catch (_) {}
          try { fs.symlinkSync(filePath, sharedLink); } catch (_) {}
        }
        ws.send(JSON.stringify({
          type: "file", filename, url: `/shared/${encodeURIComponent(filename)}`,
          fileType, size: formatSize(stat.size), sizeBytes: stat.size,
        }));
        return { filename, size: stat.size };
      };

      // Helper: auto-compress if file exceeds max_size_mb
      const autoCompressIfNeeded = async (filePath) => {
        if (!maxSizeBytes) return filePath;
        const stat = fs.statSync(filePath);
        if (stat.size <= maxSizeBytes) return filePath;

        const originalMB = (stat.size / (1024 * 1024)).toFixed(1);
        const targetMB = max_size_mb;
        ws.send(JSON.stringify({ type: "progress", percent: 95, detail: `文件 ${originalMB}MB 超过 ${targetMB}MB 限制，自动压缩中…` }));

        // Calculate target bitrate: target_size_bits / duration_seconds
        // First get duration
        let duration = 0;
        try {
          const probeResult = await execAsync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, { timeout: 30000 });
          duration = parseFloat(probeResult.trim()) || 0;
        } catch (_) {}

        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const compressedPath = path.join(path.dirname(filePath), `${baseName}_compressed${ext}`);

        let ffmpegOpts;
        if (duration > 0) {
          // Target bitrate = target_size * 8 / duration, leave 5% margin for audio
          const targetBitrate = Math.floor((maxSizeBytes * 0.95 * 8) / duration);
          ffmpegOpts = `-c:v libx264 -b:v ${targetBitrate} -maxrate ${targetBitrate} -bufsize ${targetBitrate * 2} -c:a aac -b:a 128k -preset fast -movflags +faststart`;
        } else {
          // Fallback: use CRF with scale down
          ffmpegOpts = `-c:v libx264 -crf 28 -preset fast -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease" -c:a aac -b:a 128k -movflags +faststart`;
        }

        try {
          const cmd = `ffmpeg -y -i "${filePath}" ${ffmpegOpts} "${compressedPath}"`;
          const ffPromise = execAsync(cmd, { timeout: 600000 });
          if (ffPromise.child) activeProcesses.push(ffPromise.child);
          await ffPromise;
          if (ffPromise.child) { const idx = activeProcesses.indexOf(ffPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }

          if (fs.existsSync(compressedPath)) {
            const compressedStat = fs.statSync(compressedPath);
            const compressedMB = (compressedStat.size / (1024 * 1024)).toFixed(1);
            ws.send(JSON.stringify({ type: "progress", percent: 98, detail: `压缩完成: ${originalMB}MB → ${compressedMB}MB` }));

            // If still too large after bitrate compression, try again with lower quality
            if (compressedStat.size > maxSizeBytes) {
              ws.send(JSON.stringify({ type: "progress", percent: 96, detail: `仍然超过限制，二次压缩中…` }));
              const compressedPath2 = path.join(path.dirname(filePath), `${baseName}_compressed2${ext}`);
              const cmd2 = `ffmpeg -y -i "${compressedPath}" -c:v libx264 -crf 32 -preset fast -vf "scale='min(960,iw)':'min(540,ih)':force_original_aspect_ratio=decrease" -c:a aac -b:a 96k -movflags +faststart "${compressedPath2}"`;
              await execAsync(cmd2, { timeout: 600000 });
              if (fs.existsSync(compressedPath2)) {
                fs.unlinkSync(compressedPath);
                return compressedPath2;
              }
            }
            return compressedPath;
          }
        } catch (err) {
          console.error("[Download] Auto-compress failed:", err.message);
          // Return original file if compression fails
        }
        return filePath;
      };

      // ── Douyin: use Python Playwright script ──
      if (isDouyin) {
        const scriptPath = path.join(__dirname, "..", "scripts", "douyin_download.py");
        if (!fs.existsSync(scriptPath)) {
          return { type: "tool_result", tool_use_id: block.id, content: "Error: douyin_download.py not found in scripts/", is_error: true };
        }

        ws.send(JSON.stringify({ type: "command", command: `douyin download: ${url}` }));
        emitProgress(0, "使用 Playwright 下载抖音视频…");

        // Snapshot dir before download
        const filesBefore = new Set();
        try { fs.readdirSync(dlDir).forEach(f => filesBefore.add(f)); } catch (_) {}

        const result = await new Promise((resolve, reject) => {
          const child = spawn("python3", [scriptPath, url, dlDir], {
            cwd: dlDir, stdio: ["ignore", "pipe", "pipe"],
          });
          activeProcesses.push(child);
          let stdout = "", stderr = "";
          const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("下载超时 (120s)")); }, 120000);

          child.stdout.on("data", chunk => {
            stdout += chunk.toString();
            const text = chunk.toString();
            if (/\[1\/4\]/.test(text)) emitProgress(10, "解析链接…");
            else if (/\[2\/4\]/.test(text)) emitProgress(20, "获取视频信息…");
            else if (/\[3\/4\]/.test(text)) emitProgress(40, "下载中…");
            else if (/\[4\/4\]/.test(text)) emitProgress(90, "完成!");
          });
          child.stderr.on("data", chunk => { stderr += chunk.toString(); });
          child.on("close", code => {
            clearTimeout(timer);
            const idx = activeProcesses.indexOf(child);
            if (idx !== -1) activeProcesses.splice(idx, 1);
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || stdout || `exit code ${code}`));
          });
          child.on("error", err => {
            clearTimeout(timer);
            const idx = activeProcesses.indexOf(child);
            if (idx !== -1) activeProcesses.splice(idx, 1);
            reject(err);
          });
        });

        // Find downloaded file
        let filePath = null;
        const savedMatch = result.match(/Saved:\s*(.+)/);
        if (savedMatch) {
          const candidate = savedMatch[1].trim();
          if (fs.existsSync(candidate)) filePath = candidate;
        }
        if (!filePath) {
          try {
            const filesAfter = fs.readdirSync(dlDir);
            const newFiles = filesAfter.filter(f => !filesBefore.has(f) && /\.(mp4|mp3|webm)$/i.test(f));
            if (newFiles.length > 0) filePath = path.join(dlDir, newFiles[0]);
          } catch (_) {}
        }

        if (filePath && fs.existsSync(filePath)) {
          filePath = await autoCompressIfNeeded(filePath);
          emitProgress(100, "下载完成");
          const { filename, size } = emitDownloadedFile(filePath);
          const extra = maxSizeBytes ? ` (限制: ${max_size_mb}MB)` : "";
          return { type: "tool_result", tool_use_id: block.id, content: `已下载到桌面: ${filename} (${formatSize(size)})${extra}` };
        }
        return { type: "tool_result", tool_use_id: block.id, content: `Download output:\n${result.slice(0, 3000)}` };
      }

      // ── Generic: yt-dlp with auto-install + progress ──
      // Ensure yt-dlp is available
      const hasYtDlp = await ensureYtDlp(ws);
      if (!hasYtDlp) {
        return { type: "tool_result", tool_use_id: block.id, content: "需要 yt-dlp 但自动安装失败。请手动安装:\n  macOS: brew install yt-dlp\n  pip: pip3 install yt-dlp", is_error: true };
      }

      emitProgress(0, "准备下载…");

      // Snapshot dir
      const filesBefore = new Set();
      try { fs.readdirSync(dlDir).forEach(f => filesBefore.add(f)); } catch (_) {}

      // Build yt-dlp args
      const args = [];
      if (format === "audio") {
        args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
      } else {
        const qualityMap = {
          best: "bestvideo[vcodec~='^(avc|h264)']+bestaudio[acodec~='^(aac|mp4a)']/bestvideo+bestaudio/best",
          "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
          "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]",
          "360p": "bestvideo[height<=360]+bestaudio/best[height<=360]",
        };
        args.push("-f", qualityMap[quality] || qualityMap.best, "--merge-output-format", "mp4");
      }
      args.push("-o", `${dlDir}/%(id)s.%(ext)s`, "--no-playlist", "--newline", "--print", "after_move:filepath");

      // Bilibili: auto-extract cookies
      if (isBilibili) {
        const browser = await detectBrowserForCookies();
        if (browser) {
          args.push("--cookies-from-browser", browser);
          emitProgress(2, `使用 ${browser} cookies 登录B站`);
        }
      }

      args.push(url);
      ws.send(JSON.stringify({ type: "command", command: `yt-dlp ${format} ${url}` }));

      // Download with progress
      const output = await downloadWithYtDlpProgress(args, dlDir, activeProcesses, ws);

      // Find the downloaded file
      let filePath = null;
      const lines = output.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const candidate = lines[i].trim();
        if (!candidate || /^\[/.test(candidate) || /^(WARNING|ERROR)/i.test(candidate)) continue;
        if (fs.existsSync(candidate)) { filePath = candidate; break; }
        const bn = path.basename(candidate);
        if (bn && /\.\w{2,4}$/.test(bn)) {
          const inDlDir = path.join(dlDir, bn);
          if (fs.existsSync(inDlDir)) { filePath = inDlDir; break; }
        }
      }

      // Fallback: diff directory
      if (!filePath) {
        try {
          const filesAfter = fs.readdirSync(dlDir);
          const expectedExt = format === "audio" ? "mp3" : "mp4";
          const newFiles = filesAfter.filter(f => !filesBefore.has(f));
          const match = newFiles.find(f => f.endsWith(`.${expectedExt}`)) || newFiles[0];
          if (match) filePath = path.join(dlDir, match);
        } catch (_) {}
      }

      if (filePath && fs.existsSync(filePath)) {
        filePath = await autoCompressIfNeeded(filePath);
        emitProgress(100, "下载完成");
        const { filename, size } = emitDownloadedFile(filePath);
        const extra = maxSizeBytes ? ` (限制: ${max_size_mb}MB)` : "";
        return { type: "tool_result", tool_use_id: block.id, content: `已下载到桌面: ${filename} (${formatSize(size)})${extra}` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `Download output:\n${output.slice(0, 3000)}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Download error: ${err.message || err}`, is_error: true };
    }

  // ===== Convert Media =====
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

  // ===== Search Web (Baidu Search API) =====
  } else if (block.name === "search_web") {
    const { query, num_results = 5 } = block.input;
    try {
      const limit = Math.min(num_results, 10);
      const BAIDU_SEARCH_KEY = process.env.BAIDU_SEARCH_KEY || "bce-v3/ALTAK-daobPW7wbwf6XvdRV6GwU/30ab5ab40d5709a478c6f63e8c16d6c357d6f02d";

      const body = JSON.stringify({
        messages: [{ role: "user", content: query.slice(0, 72) }],
        search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "web", top_k: limit }],
      });

      const resp = await fetch("https://qianfan.baidubce.com/v2/ai_search/web_search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${BAIDU_SEARCH_KEY}`,
          "Content-Type": "application/json",
        },
        body,
      });
      const data = await resp.json();
      const refs = data.references || [];

      if (refs.length === 0) {
        return { type: "tool_result", tool_use_id: block.id, content: `No results found for: "${query}"` };
      }
      const text = refs.map((r, i) => {
        const snippet = (r.content || "").slice(0, 200);
        return `${i + 1}. **${r.title}**\n   ${r.url}\n   ${snippet}`;
      }).join("\n\n");
      return { type: "tool_result", tool_use_id: block.id, content: text };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Search error: ${err}`, is_error: true };
    }

  // ===== Read URL =====
  } else if (block.name === "read_url") {
    const { url } = block.input;
    try {
      const cmd = `curl -sL -m 15 -H "User-Agent: Mozilla/5.0 (compatible)" "${url}" | head -c 200000`;
      const html = await execAsync(cmd, { timeout: 20000 });
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

  // ===== Schedule Task =====
  } else if (block.name === "schedule_task") {
    const { command = "echo 'Task triggered'", cron: cronExpr, delay, description: desc, ai_prompt } = block.input;
    const { registerTask, getNextTaskId } = schedulerCtx;
    const taskId = getNextTaskId();

    if (delay && delay > 0) {
      const delayMs = delay * 1000;
      const taskData = { id: taskId, description: desc, command, ai_prompt };
      setTimeout(async () => {
        const rawOutput = await execAsync(command);
        schedulerCtx.processOutput(taskData, rawOutput);
      }, delayMs);
      const mins = delay >= 60 ? `${Math.round(delay / 60)} min` : `${delay}s`;
      return { type: "tool_result", tool_use_id: block.id, content: `One-time task #${taskId}: "${desc}" — will run in ${mins}` };
    }

    const nodeCron = require("node-cron");
    if (!cronExpr || !nodeCron.validate(cronExpr)) {
      return { type: "tool_result", tool_use_id: block.id, content: `Invalid cron: "${cronExpr}". Provide a valid cron expression or use delay for one-time tasks.`, is_error: true };
    }
    const taskData = { id: taskId, description: desc, cron: cronExpr, command, ai_prompt };
    registerTask(taskData);
    return { type: "tool_result", tool_use_id: block.id, content: `Scheduled task #${taskId}: "${desc}" [${cronExpr}]` };

  // ===== Browser JS =====
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

  // ===== Memory =====
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

  // ===== Skill Management =====
  } else if (block.name === "skill_manage") {
    const { action, name, description: desc, body, tags, old_text, new_text } = block.input;
    try {
      if (action === "list") {
        const list = skills.listSkills();
        if (list.length === 0) return { type: "tool_result", tool_use_id: block.id, content: "No skills yet." };
        const text = list.map(s => `- **${s.name}** (v${s.version}): ${s.description}${s.tags.length ? ` [${s.tags.join(", ")}]` : ""}`).join("\n");
        return { type: "tool_result", tool_use_id: block.id, content: `${list.length} skills:\n${text}` };

      } else if (action === "view") {
        if (!name) return { type: "tool_result", tool_use_id: block.id, content: "Error: name is required for view.", is_error: true };
        const skill = skills.getSkill(name);
        if (!skill) return { type: "tool_result", tool_use_id: block.id, content: `Skill "${name}" not found.`, is_error: true };
        return { type: "tool_result", tool_use_id: block.id, content: `# ${skill.meta.name || name}\n${skill.meta.description || ""}\n\n${skill.body}` };

      } else if (action === "create") {
        if (!name || !body) return { type: "tool_result", tool_use_id: block.id, content: "Error: name and body are required for create.", is_error: true };
        const result = skills.createSkill(name, desc || "", body, tags || []);
        if (result.error) return { type: "tool_result", tool_use_id: block.id, content: `Error: ${result.error}`, is_error: true };
        ws.send(JSON.stringify({ type: "skill_saved", name, action: "created" }));
        return { type: "tool_result", tool_use_id: block.id, content: result.message };

      } else if (action === "edit") {
        if (!name || !body) return { type: "tool_result", tool_use_id: block.id, content: "Error: name and body are required for edit.", is_error: true };
        const result = skills.editSkill(name, desc, body, tags);
        if (result.error) return { type: "tool_result", tool_use_id: block.id, content: `Error: ${result.error}`, is_error: true };
        ws.send(JSON.stringify({ type: "skill_saved", name, action: "updated" }));
        return { type: "tool_result", tool_use_id: block.id, content: result.message };

      } else if (action === "patch") {
        if (!name || !old_text || !new_text) return { type: "tool_result", tool_use_id: block.id, content: "Error: name, old_text, new_text required for patch.", is_error: true };
        const result = skills.patchSkill(name, old_text, new_text);
        if (result.error) return { type: "tool_result", tool_use_id: block.id, content: `Error: ${result.error}`, is_error: true };
        ws.send(JSON.stringify({ type: "skill_saved", name, action: "patched" }));
        return { type: "tool_result", tool_use_id: block.id, content: result.message };

      } else if (action === "delete") {
        if (!name) return { type: "tool_result", tool_use_id: block.id, content: "Error: name is required for delete.", is_error: true };
        const result = skills.deleteSkill(name);
        if (result.error) return { type: "tool_result", tool_use_id: block.id, content: `Error: ${result.error}`, is_error: true };
        return { type: "tool_result", tool_use_id: block.id, content: result.message };

      } else {
        return { type: "tool_result", tool_use_id: block.id, content: "Invalid action. Use: list, view, create, edit, patch, delete.", is_error: true };
      }
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Skill error: ${err.message}`, is_error: true };
    }
  }

  return { type: "tool_result", tool_use_id: block.id, content: "Unknown tool", is_error: true };
}

module.exports = { getToolDefinitions, executeTool, setAgentFunctions };
