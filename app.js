#!/usr/bin/env node
/**
 * Her Desktop App
 *
 * Wraps the server with:
 * - Auto directory setup in ~/.her
 * - Auto browser open
 * - Embedded index.html (no external files needed)
 *
 * Build: bun build --compile app.js --outfile her-app
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// ===== Setup home directory =====
const HER_HOME = path.join(os.homedir(), ".her");
const dirs = ["data", "shared", "public"].map(d => path.join(HER_HOME, d));
dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Create default .env
const envFile = path.join(HER_HOME, ".env");
if (!fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, `PORT=3456\nAI_PROVIDER=anthropic\nANTHROPIC_API_KEY=\nAUTH_PASSWORD=\n`);
  console.log(`Config created at ${envFile} — edit to add your API key.`);
}

// Copy index.html from source
const srcHtml = path.join(__dirname, "public", "index.html");
const destHtml = path.join(HER_HOME, "public", "index.html");
if (fs.existsSync(srcHtml)) {
  fs.copyFileSync(srcHtml, destHtml);
}

// Point process to HER_HOME so express.static("public") works
process.chdir(HER_HOME);

// Load env
require("dotenv").config({ path: envFile });
if (!process.env.PORT) process.env.PORT = "3456";

// Patch utils to use ~/.her paths
const utils = require("./lib/utils");
Object.defineProperty(utils, "DATA_DIR", { get: () => path.join(HER_HOME, "data") });
Object.defineProperty(utils, "SHARED_DIR", { get: () => path.join(HER_HOME, "shared") });

// Start server
require("./server");

// Open browser
setTimeout(() => {
  const port = process.env.PORT || 3456;
  const url = `http://localhost:${port}`;
  console.log(`\n  Opening ${url} ...\n`);
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}, 2000);
