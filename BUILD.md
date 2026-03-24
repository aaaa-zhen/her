# Build Guide

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Rust](https://rustup.rs) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Tauri CLI: `cargo install tauri-cli`

## Tauri Desktop App (recommended)

```bash
# Install dependencies
bun install

# 1. Compile sidecar
mkdir -p src-tauri/binaries
bun build --compile app.js \
  --external playwright --external playwright-core --external electron \
  --outfile src-tauri/binaries/her-sidecar-aarch64-apple-darwin

# 2. Build .app
cargo tauri build --bundles app
```

Output: `src-tauri/target/release/bundle/macos/Her.app`

> **Note**: `src-tauri/target/` (3G+) and `src-tauri/binaries/` (60M) are build artifacts, already gitignored. Can safely delete them; they rebuild from source.

## Standalone Binary (no Tauri)

```bash
# Mac (Apple Silicon)
bun build --compile app.js --external playwright --external playwright-core --external electron --outfile her-app

# All platforms
bun build --compile app.js --target=bun-darwin-arm64 --external playwright --external playwright-core --external electron --outfile dist/her-mac-arm64
bun build --compile app.js --target=bun-darwin-x64 --external playwright --external playwright-core --external electron --outfile dist/her-mac-x64
bun build --compile app.js --target=bun-windows-x64 --external playwright --external playwright-core --external electron --outfile dist/her-windows.exe
bun build --compile app.js --target=bun-linux-x64 --external playwright --external playwright-core --external electron --outfile dist/her-linux
```

## API Configuration

Uses [PackyAPI](https://www.packyapi.com) as multi-model proxy. One API key supports all models.

When creating a PackyAPI token, select these groups:
- **Aws-officially** — Claude (Sonnet 4.6, Opus 4.6)
- **Codex** — GPT (GPT-5)
- **Bailian** — Kimi K2.5, GLM-5, MiniMax M2.7

## GitHub Actions (CI)

Push a tag to trigger automatic builds + GitHub Release:

```bash
git tag v1.0.0
git push origin v1.0.0
```
