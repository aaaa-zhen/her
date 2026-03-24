const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SHARED_DIR, execAsync, safePath, getFileType, formatSize } = require("./utils");
const { loadMemory, saveMemoryFile, searchMemory, autoTag } = require("./memory");

let playwright = null;
try { playwright = require("playwright"); } catch (e) {}

function getToolDefinitions() {
  return [
    {
      name: "bash",
      description: `Execute a bash command. Set target to "user" to run on the user's local computer (requires agent). Default runs on the server.`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          cwd: { type: "string", description: `Working directory for the command.` },
          target: { type: "string", enum: ["server", "user"], description: "Where to run: server (default) or user's local computer" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read file contents with line numbers. Set target to 'user' to read from user's local computer.",
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
      description: "Create or overwrite a file with the given content. Set target to 'user' to write to user's computer.",
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
      description: "Make precise edits to a file by replacing exact string matches. Always read_file first before editing. Set target to 'user' for user's computer.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          old_string: { type: "string", description: "Exact string to find (must be unique in file)" },
          new_string: { type: "string", description: "Replacement string" },
          target: { type: "string", enum: ["server", "user"], description: "Where to edit: server (default) or user's computer" },
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
}

// Agent exec function — set by server.js
let _agentExec = null;
let _isAgentConnected = null;

function setAgentFunctions(agentExec, isAgentConnected) {
  _agentExec = agentExec;
  _isAgentConnected = isAgentConnected;
}

// ===== Tool Execution =====
async function executeTool(block, ws, activeProcesses, schedulerCtx) {
  // Route to local agent if target is "user" and agent is connected
  const target = block.input?.target;
  if (target === "user") {
    if (!_isAgentConnected || !_isAgentConnected()) {
      return { type: "tool_result", tool_use_id: block.id, content: "Error: Local agent is not connected. Ask the user to start the Her agent on their computer.", is_error: true };
    }
    const agentTools = ["bash", "read_file", "write_file", "edit_file", "glob", "grep"];
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
      const dlPromise = execAsync(cmd, { timeout: 600000 });
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
    const { path: filePath, offset = 1, limit = 500 } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `read_file: ${filePath}` }));
    try {
      const content = fs.readFileSync(filePath, "utf-8");
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
    const { path: filePath, content } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `write_file: ${filePath}` }));
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
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
    const { path: filePath, old_string, new_string } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `edit_file: ${filePath}` }));
    try {
      const content = fs.readFileSync(filePath, "utf-8");
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
      fs.writeFileSync(filePath, newContent, "utf-8");
      const result = `Edit applied to ${filePath}`;
      ws.send(JSON.stringify({ type: "command_output", output: result }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      const msg = `Error editing file: ${err.message || err}`;
      ws.send(JSON.stringify({ type: "command_output", output: msg }));
      return { type: "tool_result", tool_use_id: block.id, content: msg, is_error: true };
    }

  } else if (block.name === "glob") {
    const { pattern, path: basePath = SHARED_DIR } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `glob: ${pattern} in ${basePath}` }));
    try {
      const cmd = `find "${basePath}" -path "${basePath}/${pattern}" -type f 2>/dev/null | head -100`;
      let output = await execAsync(cmd);
      if (!output.trim()) {
        const namePattern = pattern.includes("/") ? pattern.split("/").pop() : pattern;
        const findCmd = `find "${basePath}" -name "${namePattern}" -type f 2>/dev/null | head -100`;
        output = await execAsync(findCmd);
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
    const { pattern, path: searchPath = SHARED_DIR, include } = block.input;
    const includeFlag = include ? `--include="${include}"` : "";
    ws.send(JSON.stringify({ type: "command", command: `grep: "${pattern}" in ${searchPath}` }));
    try {
      const grepCmd = `grep -rn ${includeFlag} "${pattern}" "${searchPath}" 2>/dev/null | head -200`;
      const output = await execAsync(grepCmd);
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

module.exports = { getToolDefinitions, executeTool, setAgentFunctions };
