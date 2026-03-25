const nodeCron = require("node-cron");
const { execAsync } = require("./utils");
const { loadSchedules, saveSchedules } = require("./data");
const ai = require("./ai-client");

const scheduledTasks = [];
let nextTaskId = 1;
let broadcastFn = null;
let weixinPushFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

function setWeixinPush(fn) {
  weixinPushFn = fn;
}

async function processScheduleOutput(taskData, rawOutput) {
  let output = rawOutput.slice(0, 5000);
  if (taskData.ai_prompt) {
    try {
      const resp = await ai.chatSummary({
        messages: [{
          role: "user",
          content: `${taskData.ai_prompt}\n\n---\nRaw data:\n${rawOutput.slice(0, 8000)}`
        }],
      });
      output = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    } catch (e) {
      console.error("[Schedule AI] Error:", e.message);
    }
  }
  const msg = output.slice(0, 5000);
  if (broadcastFn) {
    broadcastFn({
      type: "schedule_result",
      taskId: taskData.id,
      description: taskData.description,
      command: taskData.command,
      output: msg,
    });
  }
  // Push to WeChat
  if (weixinPushFn) {
    const text = `⏰ ${taskData.description || "定时任务"}\n\n${msg}`;
    weixinPushFn(text).catch(e => console.log("[Schedule] WeChat push failed:", e.message));
  }
}

function registerScheduledTask(taskData) {
  const job = nodeCron.schedule(taskData.cron, async () => {
    const rawOutput = await execAsync(taskData.command);
    await processScheduleOutput(taskData, rawOutput);
  });
  scheduledTasks.push({ ...taskData, job });
}

function init() {
  const savedSchedules = loadSchedules();
  for (const s of savedSchedules) {
    if (nodeCron.validate(s.cron)) {
      registerScheduledTask(s);
      if (s.id >= nextTaskId) nextTaskId = s.id + 1;
    }
  }
  if (savedSchedules.length > 0) console.log(`[Schedule] Restored ${savedSchedules.length} tasks`);
}

function getSchedulerContext() {
  return {
    registerTask(taskData) {
      registerScheduledTask(taskData);
      saveSchedules(scheduledTasks);
    },
    getNextTaskId() {
      return nextTaskId++;
    },
    processOutput: processScheduleOutput,
  };
}

module.exports = { init, setBroadcast, setWeixinPush, getSchedulerContext };
