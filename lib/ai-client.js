/**
 * Unified AI client — supports both Anthropic and OpenAI-compatible APIs.
 * Settings can be changed at runtime via updateSettings().
 */

const EventEmitter = require("events");
const { loadSettings } = require("./settings");

// Runtime config — initialized from env, can be updated via settings panel
let config = {
  provider: process.env.AI_PROVIDER || "anthropic",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
  openaiModel: process.env.OPENAI_MODEL || "",
  openaiExtraBody: {},
};

// Load saved settings on startup
try {
  const saved = loadSettings();
  if (saved.provider) config.provider = saved.provider;
  if (saved.anthropicApiKey) config.anthropicApiKey = saved.anthropicApiKey;
  if (saved.anthropicBaseUrl) config.anthropicBaseUrl = saved.anthropicBaseUrl;
  if (saved.openaiApiKey) config.openaiApiKey = saved.openaiApiKey;
  if (saved.openaiBaseUrl) config.openaiBaseUrl = saved.openaiBaseUrl;
  if (saved.openaiModel) config.openaiModel = saved.openaiModel;
  if (saved.openaiExtraBody) config.openaiExtraBody = saved.openaiExtraBody;
} catch (e) {}

// Parse env extra body as fallback
try {
  if (process.env.config.openaiExtraBody && Object.keys(config.openaiExtraBody).length === 0) {
    config.openaiExtraBody = JSON.parse(process.env.config.openaiExtraBody);
  }
} catch (e) {}

function getDefaultModel() {
  if (config.provider === "openai") return config.openaiModel || "gpt-4o";
  return "claude-sonnet-4-6";
}

function getSummaryModel() {
  if (config.provider === "openai") return config.openaiModel || "gpt-4o-mini";
  return "claude-3-5-haiku-20241022";
}

let anthropicClient = null;
let openaiClient = null;

function getAnthropicClient() {
  if (!anthropicClient) {
    const Anthropic = require("@anthropic-ai/sdk").default;
    anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey || undefined,
      baseURL: config.anthropicBaseUrl || "https://api.anthropic.com",
      defaultHeaders: { "user-agent": "claude-cli/2.1.44 (external, sdk-cli)" },
    });
  }
  return anthropicClient;
}

function getOpenAIClient() {
  if (!openaiClient) {
    const OpenAI = require("openai").default;
    openaiClient = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl || "https://api.openai.com/v1",
    });
  }
  return openaiClient;
}

function updateSettings(newConfig) {
  const { saveSettings } = require("./settings");
  if (newConfig.provider) config.provider = newConfig.provider;
  if (newConfig.anthropicApiKey !== undefined) config.anthropicApiKey = newConfig.anthropicApiKey;
  if (newConfig.anthropicBaseUrl !== undefined) config.anthropicBaseUrl = newConfig.anthropicBaseUrl;
  if (newConfig.openaiApiKey !== undefined) config.openaiApiKey = newConfig.openaiApiKey;
  if (newConfig.openaiBaseUrl !== undefined) config.openaiBaseUrl = newConfig.openaiBaseUrl;
  if (newConfig.openaiModel !== undefined) config.openaiModel = newConfig.openaiModel;
  if (newConfig.openaiExtraBody !== undefined) config.openaiExtraBody = newConfig.openaiExtraBody;
  // Reset clients so they get recreated with new config
  anthropicClient = null;
  openaiClient = null;
  saveSettings(config);
  console.log(`[AI Client] Settings updated: provider=${config.provider}, model=${getDefaultModel()}`);
}

function getConfig() {
  return {
    provider: config.provider,
    anthropicApiKey: config.anthropicApiKey ? "sk-..." + config.anthropicApiKey.slice(-6) : "",
    anthropicBaseUrl: config.anthropicBaseUrl,
    openaiApiKey: config.openaiApiKey ? "sk-..." + config.openaiApiKey.slice(-6) : "",
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    openaiExtraBody: config.openaiExtraBody,
  };
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
        // Check if it's tool_results
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
          // Mixed content (text + images)
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

/**
 * Non-streaming chat completion.
 * Returns Anthropic-format response: { content: [...], stop_reason, usage }
 */
async function chat({ messages, system, model, max_tokens = 2048, tools: toolDefs }) {
  if (config.provider === "openai") {
    const client = getOpenAIClient();
    const openaiMessages = anthropicMessagesToOpenAI(messages, system);
    const params = {
      model: model || getDefaultModel(),
      messages: openaiMessages,
      max_tokens,
      ...config.openaiExtraBody,
    };
    if (toolDefs && toolDefs.length > 0) {
      params.tools = anthropicToolsToOpenAI(toolDefs);
    }
    const response = await client.chat.completions.create(params);
    return openaiResponseToAnthropic(response.choices[0], response.usage);
  } else {
    const client = getAnthropicClient();
    const params = {
      model: model || getDefaultModel(),
      max_tokens,
      messages,
    };
    if (system) params.system = system;
    if (toolDefs && toolDefs.length > 0) params.tools = toolDefs;
    const response = await client.messages.create(params);
    return response;
  }
}

/**
 * Summary-specific chat (uses cheaper model).
 */
async function chatSummary({ messages, system, max_tokens = 2048 }) {
  return chat({ messages, system, model: getSummaryModel(), max_tokens });
}

/**
 * Streaming chat. Returns an EventEmitter with events:
 *   "text"    (text)     — incremental text
 *   "message" (response) — full Anthropic-format response
 *   "error"   (err)
 *   "end"     ()
 * Also has .abort() method.
 */
function stream({ messages, system, model, max_tokens = 16384, tools: toolDefs }) {
  const emitter = new EventEmitter();
  let aborted = false;

  emitter.abort = () => { aborted = true; };

  if (config.provider === "openai") {
    _streamOpenAI(emitter, { messages, system, model, max_tokens, tools: toolDefs }, () => aborted);
  } else {
    _streamAnthropic(emitter, { messages, system, model, max_tokens, tools: toolDefs }, () => aborted);
  }

  return emitter;
}

async function _streamAnthropic(emitter, { messages, system, model, max_tokens, tools: toolDefs }, isAborted) {
  try {
    const client = getAnthropicClient();
    const params = {
      model: model || getDefaultModel(),
      max_tokens,
      messages,
    };
    if (system) params.system = system;
    if (toolDefs && toolDefs.length > 0) params.tools = toolDefs;

    const s = client.messages.stream(params);
    let fullResponse = null;

    emitter.abort = () => {
      s.abort();
    };

    s.on("text", (text) => {
      if (!isAborted()) emitter.emit("text", text);
    });
    s.on("message", (message) => {
      fullResponse = message;
      emitter.emit("message", message);
    });
    s.on("error", (err) => {
      if (!isAborted()) emitter.emit("error", err);
      else emitter.emit("end");
    });
    s.on("end", () => {
      emitter.emit("end");
    });
  } catch (err) {
    emitter.emit("error", err);
  }
}

async function _streamOpenAI(emitter, { messages, system, model, max_tokens, tools: toolDefs }, isAborted) {
  try {
    const client = getOpenAIClient();
    const openaiMessages = anthropicMessagesToOpenAI(messages, system);
    const params = {
      model: model || getDefaultModel(),
      messages: openaiMessages,
      max_tokens,
      stream: true,
      ...config.openaiExtraBody,
    };
    if (toolDefs && toolDefs.length > 0) {
      params.tools = anthropicToolsToOpenAI(toolDefs);
    }

    const s = await client.chat.completions.create(params);

    let contentText = "";
    const toolCalls = {}; // index -> { id, name, arguments }
    let finishReason = null;
    let abortController = null;

    emitter.abort = () => {
      if (s.controller) s.controller.abort();
    };

    for await (const chunk of s) {
      if (isAborted()) break;

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

    // Build Anthropic-format response
    const content = [];
    if (contentText) {
      content.push({ type: "text", text: contentText });
    }

    const toolCallList = Object.values(toolCalls);
    for (const tc of toolCallList) {
      let input = {};
      try { input = JSON.parse(tc.arguments); } catch (e) {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input,
      });
    }

    const stopReason = toolCallList.length > 0 ? "tool_use" : "end_turn";
    const fullResponse = { content, stop_reason: stopReason, usage: { input_tokens: 0, output_tokens: 0 } };

    emitter.emit("message", fullResponse);
    emitter.emit("end");
  } catch (err) {
    emitter.emit("error", err);
  }
}

function getProvider() {
  return config.provider;
}

module.exports = { chat, chatSummary, stream, getDefaultModel, getSummaryModel, getProvider, getConfig, updateSettings };
