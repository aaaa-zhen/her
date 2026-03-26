# Build Guide

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Rust](https://rustup.rs) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Tauri CLI: `cargo install tauri-cli --locked`

## Quick Start (clone → DMG)

```bash
git clone https://github.com/aaaa-zhen/her.git
cd her
bun install

# Generate embedded HTML (required for compiled binary)
node -e "const h=require('fs').readFileSync('public/index.html','utf-8');require('fs').writeFileSync('lib/embedded-html.js','module.exports='+JSON.stringify(h)+';\n');"

# Create Tauri frontend placeholder
mkdir -p dist
echo '<!DOCTYPE html><html><head><style>body{margin:0;background:#0a0a0a;height:100vh}</style></head><body></body></html>' > dist/index.html

# Compile sidecar
mkdir -p src-tauri/binaries
bun build --compile app.js \
  --external playwright --external playwright-core --external electron \
  --outfile src-tauri/binaries/her-sidecar-aarch64-apple-darwin

# Build DMG
cargo tauri build --bundles dmg
```

Output: `src-tauri/target/release/bundle/dmg/Her_*.dmg`

> `src-tauri/target/` (3G+) and `src-tauri/binaries/` (60M) are build artifacts, gitignored. Safe to delete; they rebuild from source.

## Standalone Binary (no Tauri)

No Rust needed. Runs as a terminal app that opens in browser.

```bash
bun install
node -e "const h=require('fs').readFileSync('public/index.html','utf-8');require('fs').writeFileSync('lib/embedded-html.js','module.exports='+JSON.stringify(h)+';\n');"

# Mac (Apple Silicon)
bun build --compile app.js --external playwright --external playwright-core --external electron --outfile her-app
./her-app

# Cross-compile for other platforms
bun build --compile app.js --target=bun-darwin-x64 --external playwright --external playwright-core --external electron --outfile dist/her-mac-x64
bun build --compile app.js --target=bun-windows-x64 --external playwright --external playwright-core --external electron --outfile dist/her-windows.exe
bun build --compile app.js --target=bun-linux-x64 --external playwright --external playwright-core --external electron --outfile dist/her-linux
```

## Development (no build needed)

```bash
bun install
node server.js
# Open http://localhost:3000
```

## API Configuration

Two options:

| Provider | URL | Region | Models |
|----------|-----|--------|--------|
| [PackyAPI](https://www.packyapi.com) | `https://www.packyapi.com/v1` | China (no VPN) | Gemini 3.1 Pro |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api/v1` | Global (VPN in China) | 200+ models |

Set API Key and Base URL in the app's Settings panel (click the info button).

## GitHub Actions (CI)

Push a tag to trigger automatic builds + GitHub Release:

```bash
git tag v1.0.1
git push origin v1.0.1
```

Produces: macOS DMG (arm64), Windows installer (NSIS), standalone binaries (mac/win/linux).
