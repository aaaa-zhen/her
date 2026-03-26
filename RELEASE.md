# Her Release Guide

## Repository

- GitHub: https://github.com/aaaa-zhen/her
- Build: GitHub Actions (triggered by tag push)

## Release Steps

### 1. Commit and push code

```bash
git add <files>
git commit -m "description"
git push origin main
```

### 2. Tag and trigger build

```bash
git tag v1.0.2
git push origin v1.0.2
```

GitHub Actions builds automatically:
- `her-mac-arm64` / `her-mac-x64` / `her-windows.exe` / `her-linux` (standalone)
- `Her_*.dmg` (macOS Tauri app)
- `Her_*-setup.exe` (Windows Tauri installer)

### 3. Check build status

Go to [Actions](https://github.com/aaaa-zhen/her/actions) or:

```bash
gh run list --repo aaaa-zhen/her --limit 1
```

### 4. Download release

Built artifacts are published to [GitHub Releases](https://github.com/aaaa-zhen/her/releases).

### 5. Deploy to download server (optional)

```bash
ssh root@<SERVER_IP>
cd /var/www/her

# Download from GitHub Release
curl -L -o "Her_v1.0.2_aarch64.dmg" "https://github.com/aaaa-zhen/her/releases/download/v1.0.2/Her_1.0.1_aarch64.dmg"

# Update index.html version
sed -i 's/OLD_VERSION/1.0.2/g' index.html
```

## CLIProxyAPI (Claude Max → OpenAI API)

A reverse proxy that exposes Claude Max subscription as an OpenAI-compatible API.

### User Setup

1. Open Her → Settings
2. Base URL: `http://<SERVER_IP>:8317/v1`
3. API Key: (ask admin)
4. Model: `claude-opus-4-6`
5. Save

### Server Management

```bash
# Status
ps aux | grep cli-proxy-api

# Restart
pkill -f cli-proxy-api
nohup /opt/cliproxyapi/cli-proxy-api --config ~/.cli-proxy-api/config.yaml > /var/log/cliproxyapi.log 2>&1 &

# Logs
tail -f /var/log/cliproxyapi.log

# Re-login OAuth (when token expires)
/opt/cliproxyapi/cli-proxy-api --claude-login --config ~/.cli-proxy-api/config.yaml
```

### Notes

- OAuth token auto-refreshes every 15 min
- Long idle periods may require re-login
- Edit `~/.cli-proxy-api/config.yaml` for API keys, restart after changes

## API Providers

| Provider | Base URL | Region | Notes |
|----------|----------|--------|-------|
| PackyAPI | `https://www.packyapi.com/v1` | China | Gemini 3.1 Pro, no VPN |
| OpenRouter | `https://openrouter.ai/api/v1` | Global | 200+ models, VPN in China |
| CLIProxyAPI | `http://<SERVER>:8317/v1` | Self-hosted | Claude Max proxy |
