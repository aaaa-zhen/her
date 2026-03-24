/**
 * Unified AI client — single API key, auto-detect Anthropic vs OpenAI endpoint by model name.
 * Designed for PackyAPI (or any multi-model proxy).
 * Settings can be changed at runtime via updateSettings().
 */

const EventEmitter = require("events");
const { loadSettings } = require("./settings");

// Runtime config
let config = {
  apiKey: process.env.API_KEY || process.env.ANTHROPIC_API_KEY || "",
  baseUrl: process.env.API_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://www.packyapi.com",
  model: process.env.AI_MODEL || "claude-sonnet-4-6",
  summaryModel: process.env.AI_SUMMARY_MODEL || "claude-3-5-haiku-20241022",
};

// Load saved settings on startup
try {
  const saved = loadSettings();
  if (saved.apiKey) config.apiKey = saved.apiKey;
  if (saved.baseUrl) config.baseUrl = saved.baseUrl;
  if (saved.model) config.model = saved.model;
  if (saved.summaryModel) config.summaryModel = saved.summaryModel;
} catch (e) {}

/** Determine if a model uses Anthropic endpoint (vs OpenAI) */
function isAnthropicModel(model) {
  return model.startsWith("claude-");
}

function getDefaultModel() {
  return config.model || "claude-sonnet-4-6";
}

function getSummaryModel() {
  return config.summaryModel || "claude-3-5-haiku-20241022";
}

let anthropicClient = null;
let openaiClient = null;

function getAnthropicClient() {
  if (!anthropicClient) {
    const Anthropic = require("@anthropic-ai/sdk").default;
    anthropicClient = new Anthropic({
      apiKey: config.apiKey || undefined,
      baseURL: config.baseUrl || "https://api.anthropic.com",
    });
  }
  return anthropicClient;
}

function getOpenAIClient() {
  if (!openaiClient) {
    const OpenAI = require("openai").default;
    openaiClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: (config.baseUrl || "https://api.openai.com") + "/v1",
    });
  }
  return openaiClient;
}

function updateSettings(newConfig) {
  const { saveSettings } = require("./settings");
  if (newConfig.apiKey !== undefined) config.apiKey = newConfig.apiKey;
  if (newConfig.baseUrl !== undefined) config.baseUrl = newConfig.baseUrl;
  if (newConfig.model !== undefined) config.model = newConfig.model;
  if (newConfig.summaryModel !== undefined) config.summaryModel = newConfig.summaryModel;
  // Reset clients so they get recreated with new config
  anthropicClient = null;
  openaiClient = null;
  saveSettings(config);
  console.log(`[AI Client] Settings updated: model=${getDefaultModel()}, base=${config.baseUrl}`);
}

function getConfig() {
  return {
    apiKey: config.apiKey ? "sk-..." + config.apiKey.slice(-6) : "",
    baseUrl: config.baseUrl,
    model: config.model,
    summaryModel: config.summaryModel,
  };
}

// For backward compat with server.js
function getProvider() {
  return isAnthropicModel(getDefaultModel()) ? "anthropic" : "openai";
}

// ===== Format Converters: Anthropic <-> OpenAI =====

function anthropicToolsToOpenAI(tools) {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function anthropicMessagesToOpenAI(messages, system) {
  const result = [];
  if (system) {
    result.push({ role: "system", content: system });
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(b => b.type === "tool_result");
        if (hasToolResult) {
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              result.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: typeof block.content === "string" ? block.content : JSON.stringify(block.content || ""),
              });
            }
          }
        } else {
          const parts = msg.content.map(block => {
            if (block.type === "text") {
              return { type: "text", text: block.text };
            } else if (block.type === "image") {
              return {
                type: "image_url",
                image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
              };
            }
            return null;
          }).filter(Boolean);
          result.push({ role: "user", content: parts });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
        const toolCalls = msg.content.filter(b => b.type === "tool_use").map(b => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
        const assistantMsg = { role: "assistant" };
        if (textParts) assistantMsg.content = textParts;
        else assistantMsg.content = null;
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        result.push(assistantMsg);
      }
    }
  }
  return result;
}

function openaiResponseToAnthropic(choice, usage) {
  const msg = choice.message;
  const content = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch (e) {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    content,
    stop_reason: msg.tool_calls && msg.tool_calls.length > 0 ? "tool_use" : "end_turn",
    usage: usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    } : undefined,
  };
}

// ===== Unified API =====

async function chat({ messages, system, model, max_tokens = 2048, tools: toolDefs }) {
  const m = model || getDefaultModel();
  if (isAnthropicModel(m)) {
    const client = getAnthropicClient();
    const params = { model: m, max_tokens, messages };
    if (system) params.system = system;
    if (toolDefs && toolDefs.length > 0) params.tools = toolDefs;
    return await client.messages.create(params);
  } else {
    const client = getOpenAIClient();
    const openaiMessages = anthropicMessagesToOpenAI(messages, system);
    const params = { model: m, messages: openaiMessages, max_tokens };
    if (toolDefs && toolDefs.length > 0) {
      params.tools = anthropicToolsToOpenAI(toolDefs);
    }
    const response = await client.chat.completions.create(params);
    return openaiResponseToAnthropic(response.choices[0], response.usage);
  }
}

async function chatSummary({ messages, system, max_tokens = 2048 }) {
  return chat({ messages, system, model: getSummaryModel(), max_tokens });
}

function stream({ messages, system, model, max_tokens = 16384, tools: toolDefs }) {
  const emitter = new EventEmitter();
  const m = model || getDefaultModel();

  if (isAnthropicModel(m)) {
    _streamAnthropic(emitter, { messages, system, model: m, max_tokens, tools: toolDefs });
  } else {
    _streamOpenAI(emitter, { messages, system, model: m, max_tokens, tools: toolDefs });
  }

  return emitter;
}

async function _streamAnthropic(emitter, { messages, system, model, max_tokens, tools: toolDefs }) {
  try {
    const client = getAnthropicClient();
    const params = { model, max_tokens, messages };
    if (system) params.system = system;
    if (toolDefs && toolDefs.length > 0) params.tools = toolDefs;

    const s = client.messages.stream(params);

    emitter.abort = () => { s.abort(); };

    s.on("text", (text) => { emitter.emit("text", text); });
    s.on("message", (message) => { emitter.emit("message", message); });
    s.on("error", (err) => { emitter.emit("error", err); });
    s.on("end", () => { emitter.emit("end"); });
  } catch (err) {
    emitter.emit("error", err);
  }
}

async function _streamOpenAI(emitter, { messages, system, model, max_tokens, tools: toolDefs }) {
  try {
    const client = getOpenAIClient();
    const openaiMessages = anthropicMessagesToOpenAI(messages, system);
    const params = { model, messages: openaiMessages, max_tokens, stream: true };
    if (toolDefs && toolDefs.length > 0) {
      params.tools = anthropicToolsToOpenAI(toolDefs);
    }

    const s = await client.chat.completions.create(params);

    let contentText = "";
    const toolCalls = {};
    let finishReason = null;

    emitter.abort = () => {
      if (s.controller) s.controller.abort();
    };

    for await (const chunk of s) {
      const delta = chunk.choices[0]?.delta;
      finishReason = chunk.choices[0]?.finish_reason || finishReason;

      if (delta?.content) {
        contentText += delta.content;
        emitter.emit("text", delta.content);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCalls[tc.index]) {
            toolCalls[tc.index] = { id: tc.id || "", name: "", arguments: "" };
          }
          if (tc.id) toolCalls[tc.index].id = tc.id;
          if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
        }
      }
    }

    const content = [];
    if (contentText) {
      content.push({ type: "text", text: contentText });
    }

    const toolCallList = Object.values(toolCalls);
    for (const tc of toolCallList) {
      let input = {};
      try { input = JSON.parse(tc.arguments); } catch (e) {}
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    const stopReason = toolCallList.length > 0 ? "tool_use" : "end_turn";
    const fullResponse = { content, stop_reason: stopReason, usage: { input_tokens: 0, output_tokens: 0 } };

    emitter.emit("message", fullResponse);
    emitter.emit("end");
  } catch (err) {
    emitter.emit("error", err);
  }
}

module.exports = { chat, chatSummary, stream, getDefaultModel, getSummaryModel, getProvider, getConfig, updateSettings };
