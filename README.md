# Her

A self-hosted AI companion with a beautiful chat UI, multi-provider support, and WeChat integration.

## Features

- **Multi-Provider AI** — Switch between Anthropic (Claude) and any OpenAI-compatible API (Kimi, DeepSeek, etc.) from the settings panel
- **Tool Calling** — File operations, web browsing, media download, scheduled tasks, web search, and more
- **WeChat Bridge** — Scan QR code to connect WeChat, AI auto-replies to messages
- **Long-term Memory** — Remembers user info, preferences, and task history across conversations
- **DAG Context Compaction** — Hierarchical conversation summarization that preserves context efficiently
- **Streaming** — Real-time streaming responses with cancel support
- **File Sharing** — Upload/download files, send media in chat
- **Scheduled Tasks** — Cron-based recurring tasks with AI-processed output

## Quick Start

```bash
npm install
cp .env.example .env   # edit with your API keys
npm start
```

Open `http://localhost:3000` in your browser.

## Configuration

Edit `.env` or use the in-app **Settings panel** (gear icon):

```env
# AI Provider: "anthropic" or "openai"
AI_PROVIDER=anthropic

# Anthropic
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=

# OpenAI-compatible (Kimi, DeepSeek, etc.)
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://api.moonshot.cn/v1
OPENAI_MODEL=kimi-k2.5

PORT=3000
AUTH_PASSWORD=          # leave empty to disable auth
```

Settings can be changed at runtime via the Settings panel — no restart needed.

## Project Structure

```
server.js              Main server entry point
lib/
  ai-client.js         Unified AI client (Anthropic + OpenAI)
  tools.js             Tool definitions & execution
  memory.js            Long-term memory system
  data.js              Data persistence
  auth.js              Authentication
  prompt.js            System prompt
  scheduler.js         Scheduled task management
  settings.js          Runtime settings persistence
  summary-dag.js       DAG-based context compaction
  weixin.js            WeChat bridge service
  utils.js             Utility functions
public/
  index.html           Frontend UI
data/                  Persisted data (auto-created)
```

## Supported Providers

| Provider | Base URL | Example Model |
|----------|----------|---------------|
| Anthropic | `https://api.anthropic.com` | claude-sonnet-4-6 |
| Kimi | `https://api.moonshot.cn/v1` | kimi-k2.5 |
| DeepSeek | `https://api.deepseek.com/v1` | deepseek-chat |
| Any OpenAI-compatible | custom | custom |

## Tools

| Tool | Description |
|------|-------------|
| bash | Execute server commands |
| read_file / write_file / edit_file | File operations with line numbers |
| glob / grep | File search by pattern / content |
| send_file | Send files to chat |
| browse | Web screenshots, PDF, text extraction (Playwright) |
| download_media | Download video/audio from 1000+ sites (yt-dlp) |
| convert_media | Media conversion (ffmpeg) |
| search_web | Internet search (DuckDuckGo) |
| read_url | Extract web page text |
| schedule_task | Cron or one-time scheduled tasks |
| memory | Persistent long-term memory |
| browser_js | Execute JS in user's browser |

## WeChat Integration

1. Open Settings (gear icon)
2. Click "Scan QR to login WeChat"
3. Scan with WeChat on your phone
4. AI will auto-reply to incoming messages

Each WeChat user gets isolated conversation history.

## License

ISC
