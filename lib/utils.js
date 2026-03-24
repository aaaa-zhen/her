const path = require("path");
const { exec } = require("child_process");

const SHARED_DIR = path.join(__dirname, "..", "shared");
const DATA_DIR = path.join(__dirname, "..", "data");

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

function safePath(dir, filename) {
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) {
    return null;
  }
  return resolved;
}

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

module.exports = { SHARED_DIR, DATA_DIR, execAsync, safePath, getFileType, formatSize };
