const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./utils");

const CONVERSATION_FILE = path.join(DATA_DIR, "conversation.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedules.json");
const RESTART_FLAG_FILE = path.join(DATA_DIR, "restart_flag.json");

let _saveConvTimer = null;

function loadConversation() {
  try {
    if (fs.existsSync(CONVERSATION_FILE)) return JSON.parse(fs.readFileSync(CONVERSATION_FILE, "utf-8"));
  } catch (e) { console.error("[Conversation] Failed to load:", e.message); }
  return [];
}

function saveConversation(history) {
  if (_saveConvTimer) clearTimeout(_saveConvTimer);
  _saveConvTimer = setTimeout(() => {
    try { fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(history)); }
    catch (e) { console.error("[Conversation] Failed to save:", e.message); }
  }, 1000);
}

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

module.exports = {
  RESTART_FLAG_FILE,
  loadConversation, saveConversation,
  loadSchedules, saveSchedules,
};
