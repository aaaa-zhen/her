# Build Guide

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

## Local Build

```bash
# Install dependencies
bun install

# Build Her App (all platforms)
bun build --compile app.js --target=bun-darwin-arm64 --external playwright --external playwright-core --external electron --outfile dist/her-mac-arm64
bun build --compile app.js --target=bun-darwin-x64 --external playwright --external playwright-core --external electron --outfile dist/her-mac-x64
bun build --compile app.js --target=bun-windows-x64 --external playwright --external playwright-core --external electron --outfile dist/her-windows.exe
bun build --compile app.js --target=bun-linux-x64 --external playwright --external playwright-core --external electron --outfile dist/her-linux

# Build Her Agent (all platforms)
bun build --compile agent/her-agent.js --target=bun-darwin-arm64 --outfile dist/her-agent-mac-arm64
bun build --compile agent/her-agent.js --target=bun-darwin-x64 --outfile dist/her-agent-mac-x64
bun build --compile agent/her-agent.js --target=bun-windows-x64 --outfile dist/her-agent-windows.exe
bun build --compile agent/her-agent.js --target=bun-linux-x64 --outfile dist/her-agent-linux
```

## Build Current Platform Only

```bash
# Mac (Apple Silicon)
bun build --compile app.js --external playwright --external playwright-core --external electron --outfile her-app
bun build --compile agent/her-agent.js --outfile her-agent
```

## GitHub Actions (CI)

Push a tag to trigger automatic builds + GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Or manually trigger via GitHub Actions > Build Her App > Run workflow.

Build artifacts (all platforms) are uploaded automatically. Tagged builds also create a GitHub Release with download links.

## Output

| File | Platform | Description |
|------|----------|-------------|
| `her-mac-arm64` | macOS Apple Silicon | Her App |
| `her-mac-x64` | macOS Intel | Her App |
| `her-windows.exe` | Windows | Her App |
| `her-linux` | Linux x64 | Her App |
| `her-agent-mac-arm64` | macOS Apple Silicon | Local Agent |
| `her-agent-mac-x64` | macOS Intel | Local Agent |
| `her-agent-windows.exe` | Windows | Local Agent |
| `her-agent-linux` | Linux x64 | Local Agent |

## How Users Use It

1. Download `her-app` for their platform
2. Double-click to run — browser opens automatically
3. Open Settings (gear icon) to configure API key
4. (Optional) Download `her-agent` to let Her control their local computer
