const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./utils");

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch (e) { console.error("[Settings] Failed to load:", e.message); }
  return {};
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

module.exports = { loadSettings, saveSettings };
