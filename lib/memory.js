const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./utils");

const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const CONVERSATION_SUMMARY_FILE = path.join(DATA_DIR, "conversations.json");

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch (e) { console.error("[Memory] Failed to load:", e.message); }
  return [];
}

function saveMemoryFile(memories) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
}

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

function getRelevantMemories(limit = 20) {
  const memories = loadMemory();
  return memories
    .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
    .slice(0, limit);
}

function saveConversationSummary(summary) {
  let conversations = [];
  try {
    if (fs.existsSync(CONVERSATION_SUMMARY_FILE)) {
      conversations = JSON.parse(fs.readFileSync(CONVERSATION_SUMMARY_FILE, "utf-8"));
    }
  } catch (e) {}
  conversations.push({ summary, time: new Date().toISOString() });
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

module.exports = {
  loadMemory, saveMemoryFile, searchMemory, autoTag,
  getRelevantMemories, saveConversationSummary, loadRecentConversations,
};
