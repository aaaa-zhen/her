#!/bin/bash
# ============================================================
# Her — VPS 一键部署脚本
# 用法: bash scripts/deploy.sh  （在项目根目录下运行）
# 支持: CentOS / OpenCloudOS / Ubuntu / Debian
# ============================================================

set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
title() { echo -e "\n${CYAN}──── $1 ────${NC}"; }

# ============================================================
# 0. 定位项目根目录（兼容从任意位置调用）
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="/opt/her"
FRP_VER="0.61.0"

echo ""
echo "================================================"
echo "  Her — 自动部署脚本"
echo "================================================"
echo ""

# ============================================================
# 1. 读取配置
# ============================================================
read -p "Anthropic API Key: " API_KEY
[ -z "$API_KEY" ] && error "API Key 不能为空"

read -p "API Base URL（留空使用官方）: " BASE_URL
[ -z "$BASE_URL" ] && BASE_URL="https://api.anthropic.com"

read -p "登录密码（留空则不需要密码）: " AUTH_PWD

read -p "服务端口（默认 3000）: " PORT
[ -z "$PORT" ] && PORT=3000

# ============================================================
# 2. 检测包管理器
# ============================================================
title "环境检测"
if command -v yum &>/dev/null; then   PKG="yum"
elif command -v apt-get &>/dev/null;  then PKG="apt"
else error "不支持的系统，需要 yum 或 apt"; fi
info "包管理器: $PKG"

# ============================================================
# 3. 安装 Node.js
# ============================================================
title "安装 Node.js"
if ! command -v node &>/dev/null; then
  warn "未检测到 Node.js，开始安装..."
  if [ "$PKG" = "yum" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
fi
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
info "Node.js $(node -v) → $NODE_BIN"

# ============================================================
# 4. 安装 sshfs
# ============================================================
title "安装 sshfs"
if [ "$PKG" = "yum" ]; then
  yum install -y fuse-sshfs 2>/dev/null && info "sshfs 已安装" || warn "sshfs 安装跳过（可选）"
else
  apt-get install -y sshfs 2>/dev/null && info "sshfs 已安装" || warn "sshfs 安装跳过（可选）"
fi

# ============================================================
# 5. 安装 frp
# ============================================================
title "安装 frp"
if ! command -v frps &>/dev/null; then
  warn "安装 frp v${FRP_VER}..."
  cd /tmp
  wget -q "https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_amd64.tar.gz"
  tar -xzf "frp_${FRP_VER}_linux_amd64.tar.gz"
  cp "frp_${FRP_VER}_linux_amd64/frps" /usr/local/bin/
  cp "frp_${FRP_VER}_linux_amd64/frpc" /usr/local/bin/
  rm -rf "frp_${FRP_VER}_linux_amd64"*
  cd -
fi
info "frp $(frps --version)"

mkdir -p /etc/frp
cat > /etc/frp/frps.toml << 'FRPSEOF'
bindPort = 7000
FRPSEOF

cat > /etc/systemd/system/frps.service << 'FRPSSVC'
[Unit]
Description=frp server
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
FRPSSVC

systemctl daemon-reload && systemctl enable frps && systemctl restart frps
info "frps 已启动（端口 7000）"

# ============================================================
# 6. 生成 SSH 密钥
# ============================================================
title "SSH 密钥"
[ ! -f ~/.ssh/id_rsa ] && ssh-keygen -t rsa -N '' -f ~/.ssh/id_rsa -q
VPS_PUBKEY="$(cat ~/.ssh/id_rsa.pub)"
VPS_HOSTNAME="$(hostname)"
info "密钥就绪，主机名: $VPS_HOSTNAME"

# ============================================================
# 7. 开放防火墙端口
# ============================================================
title "防火墙"
for p in "$PORT" 7000 6000 6001; do
  iptables -I INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || true
done
info "已放行端口: $PORT, 7000, 6000, 6001"

# ============================================================
# 8. 部署项目文件
# ============================================================
title "部署项目"
mkdir -p "$INSTALL_DIR"
cp -r "$PROJECT_DIR"/. "$INSTALL_DIR/"
info "文件已复制到 $INSTALL_DIR"

cat > "$INSTALL_DIR/.env" << EOF
ANTHROPIC_API_KEY=$API_KEY
ANTHROPIC_BASE_URL=$BASE_URL
PORT=$PORT
AUTH_PASSWORD=$AUTH_PWD
MAC_SSH_PORT=6000
WIN_SSH_PORT=6001
EOF
info ".env 已写入"

cd "$INSTALL_DIR"
warn "安装 npm 依赖..."
"$NPM_BIN" install 2>/dev/null || "$NPM_BIN" install
info "npm 依赖安装完成"

# ============================================================
# 8.5 安装媒体工具 & 浏览器
# ============================================================
title "安装媒体工具"

# yt-dlp (视频下载)
if ! command -v yt-dlp &>/dev/null; then
  warn "安装 yt-dlp..."
  curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod +x /usr/local/bin/yt-dlp
fi
info "yt-dlp $(yt-dlp --version 2>/dev/null || echo 'installed')"

# ffmpeg (媒体处理)
if ! command -v ffmpeg &>/dev/null; then
  warn "安装 ffmpeg..."
  if [ "$PKG" = "yum" ]; then
    yum install -y epel-release 2>/dev/null || true
    yum install -y ffmpeg 2>/dev/null || warn "ffmpeg 需要手动安装（yum 源可能没有）"
  else
    apt-get install -y ffmpeg 2>/dev/null || warn "ffmpeg 安装失败"
  fi
fi
command -v ffmpeg &>/dev/null && info "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')" || warn "ffmpeg 未安装，convert_media 工具不可用"

# gallery-dl (图片批量下载)
if command -v pip3 &>/dev/null; then
  pip3 install -q gallery-dl 2>/dev/null && info "gallery-dl 已安装" || warn "gallery-dl 安装跳过"
else
  warn "pip3 不可用，跳过 gallery-dl"
fi

# Playwright 浏览器
warn "安装 Playwright Chromium（约 150MB）..."
cd "$INSTALL_DIR" && npx playwright install --with-deps chromium 2>/dev/null && info "Playwright Chromium 已安装" || warn "Playwright 浏览器安装跳过"

mkdir -p /mnt/mac /mnt/win

# ============================================================
# 9. 启动服务
# ============================================================
title "启动 her"
cat > /etc/systemd/system/her.service << EOF
[Unit]
Description=Her Web Server
After=network.target
[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable her
systemctl stop her 2>/dev/null || true
sleep 1
systemctl start her
sleep 2

if systemctl is-active --quiet her; then
  info "服务已启动 ✓"
else
  error "服务启动失败！请运行: journalctl -u her -n 30"
fi

# ============================================================
# 10. 获取公网 IP
# ============================================================
title "获取公网 IP"
VPS_IP="$(curl -s --max-time 5 ifconfig.me \
  || curl -s --max-time 5 ip.sb \
  || hostname -I | awk '{print $1}')"
info "公网 IP: $VPS_IP"

# ============================================================
# 11. 生成 mac-setup.sh
# ============================================================
title "生成客户端脚本"
mkdir -p "$INSTALL_DIR/scripts"
MAC_SCRIPT="$INSTALL_DIR/scripts/mac-setup.sh"
MARKER="her-${VPS_HOSTNAME}"

cat > "$MAC_SCRIPT" << MACEOF
#!/bin/bash
# Her — Mac 一键配置脚本（自动生成）
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "\${GREEN}[✓]\${NC} \$1"; }
warn()  { echo -e "\${YELLOW}[!]\${NC} \$1"; }
error() { echo -e "\${RED}[✗]\${NC} \$1"; exit 1; }

echo "" && echo "========================================" && echo "  Her — Mac 配置向导" && echo "========================================" && echo ""

if ! nc -z 127.0.0.1 22 2>/dev/null; then
  echo -e "\${RED}[✗] SSH 未开启！\${NC}"
  echo "请打开：系统设置 → 通用 → 共享 → 远程登录 → 打开"
  read -p "开启后按回车继续..."
  nc -z 127.0.0.1 22 2>/dev/null || error "SSH 仍未开启，请检查后重试"
fi
info "SSH 已开启"

mkdir -p ~/Desktop/mac-bridge && info "mac-bridge 文件夹已创建"

mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
if ! grep -q "${MARKER}" ~/.ssh/authorized_keys 2>/dev/null; then
  echo "${VPS_PUBKEY} ${MARKER}" >> ~/.ssh/authorized_keys
  info "服务器公钥已添加"
else
  info "服务器公钥已存在，跳过"
fi

ARCH=\$(uname -m); FRP_VER="0.61.0"
FRP_PKG=\$([ "\$ARCH" = "arm64" ] && echo "frp_\${FRP_VER}_darwin_arm64" || echo "frp_\${FRP_VER}_darwin_amd64")
if [ ! -f ~/Desktop/frpc ]; then
  warn "下载 frpc (\$ARCH)..."
  curl -sL "https://github.com/fatedier/frp/releases/download/v\${FRP_VER}/\${FRP_PKG}.tar.gz" -o /tmp/frp_mac.tar.gz
  tar -xzf /tmp/frp_mac.tar.gz -C /tmp
  cp "/tmp/\${FRP_PKG}/frpc" ~/Desktop/frpc && chmod +x ~/Desktop/frpc
  rm -rf /tmp/frp_mac.tar.gz "/tmp/\${FRP_PKG}"
fi
info "frpc 已就绪"

cat > ~/Desktop/frpc.toml << 'FRPCEOF'
serverAddr = "${VPS_IP}"
serverPort = 7000
[[proxies]]
name = "mac-ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6000
FRPCEOF
info "frpc.toml 已配置"

pkill -f "frpc -c" 2>/dev/null; sleep 1
cd ~/Desktop && ./frpc -c frpc.toml > /tmp/frpc.log 2>&1 &
sleep 4

if grep -q "start proxy success" /tmp/frpc.log 2>/dev/null; then
  info "隧道连接成功！"
else
  warn "frpc 日志：" && cat /tmp/frpc.log
  warn "失败？请确认服务器安全组已放行端口 7000"
fi

echo "" && echo "========================================" && echo "  配置完成！打开浏览器访问：" && echo "  http://${VPS_IP}:${PORT}" && echo "  以后每次开机重新运行此脚本即可" && echo "========================================"
MACEOF

chmod +x "$MAC_SCRIPT"
info "mac-setup.sh 已生成"

# ============================================================
# 12. 生成 windows-setup.ps1（用 Python 写，避免 shell 转义）
# ============================================================
WIN_SCRIPT="$INSTALL_DIR/scripts/windows-setup.ps1"

python3 << PYEOF
vps_ip     = "${VPS_IP}"
vps_port   = "${PORT}"
vps_pubkey = "${VPS_PUBKEY}"
marker     = "${MARKER}"

ps1 = """# Her — Windows 一键配置脚本（自动生成）
# 右键 → 用 PowerShell 以管理员身份运行

function Write-OK   { param(\$m) Write-Host "[OK] \$m" -ForegroundColor Green }
function Write-Warn { param(\$m) Write-Host "[!!] \$m" -ForegroundColor Yellow }
function Write-Err  { param(\$m) Write-Host "[XX] \$m" -ForegroundColor Red; exit 1 }

Write-Host "" ; Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Her - Windows 配置向导" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan ; Write-Host ""

if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Err "请右键此脚本，选择「用 PowerShell 以管理员身份运行」"
}
Write-OK "管理员权限确认"

\$ssh = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if (\$ssh.State -ne 'Installed') {
    Write-Warn "安装 OpenSSH Server..."
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    Write-OK "OpenSSH Server 已安装"
} else { Write-OK "OpenSSH Server 已存在" }

Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType 'Automatic'
Write-OK "SSH 服务已启动（开机自动运行）"

if (-not (Get-NetFirewallRule -Name "sshd" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Write-OK "防火墙端口 22 已放行"

\$Desktop = [Environment]::GetFolderPath("Desktop")
New-Item -ItemType Directory -Force -Path (Join-Path \$Desktop "mac-bridge") | Out-Null
Write-OK "mac-bridge 文件夹已创建（桌面）"

\$AuthDir  = "C:\\ProgramData\\ssh"
\$AuthFile = "\$AuthDir\\administrators_authorized_keys"
if (-not (Test-Path \$AuthDir)) { New-Item -ItemType Directory -Force -Path \$AuthDir | Out-Null }
\$marker   = \""""  + marker + """\"
\$pubkey   = \""""  + vps_pubkey + " " + marker + """\"
\$existing = if (Test-Path \$AuthFile) { Get-Content \$AuthFile -Raw } else { "" }
if (\$existing -notmatch [regex]::Escape(\$marker)) {
    Add-Content -Path \$AuthFile -Value \$pubkey
    icacls \$AuthFile /inheritance:r /grant "SYSTEM:(F)" /grant "Administrators:(F)" | Out-Null
    Write-OK "服务器公钥已添加"
} else { Write-OK "服务器公钥已存在，跳过" }

\$FrpcPath = Join-Path \$Desktop "frpc.exe"
if (-not (Test-Path \$FrpcPath)) {
    Write-Warn "下载 frpc.exe..."
    \$z = "\$env:TEMP\\frp_win.zip"
    Invoke-WebRequest -Uri "https://github.com/fatedier/frp/releases/download/v0.61.0/frp_0.61.0_windows_amd64.zip" -OutFile \$z -UseBasicParsing
    Expand-Archive -Path \$z -DestinationPath "\$env:TEMP\\frp_win" -Force
    Copy-Item "\$env:TEMP\\frp_win\\frp_0.61.0_windows_amd64\\frpc.exe" -Destination \$FrpcPath
    Remove-Item \$z, "\$env:TEMP\\frp_win" -Recurse -Force
    Write-OK "frpc.exe 已下载到桌面"
} else { Write-OK "frpc.exe 已存在" }

\$toml = Join-Path \$Desktop "frpc.toml"
\$tomlContent = @"
serverAddr = \""""  + vps_ip + """\"
serverPort = 7000

[[proxies]]
name = "win-ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6001
"@
Set-Content -Path \$toml -Value \$tomlContent -Encoding UTF8
Write-OK "frpc.toml 已配置"

Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process -FilePath \$FrpcPath -ArgumentList "-c \`"\$toml\`"" -WindowStyle Hidden
Start-Sleep -Seconds 4

if (Get-Process frpc -ErrorAction SilentlyContinue) {
    Write-OK "frpc 隧道已启动"
} else {
    Write-Warn "frpc 启动异常，请确认服务器安全组已放行端口 7000"
}

Write-Host "" ; Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  配置完成！" -ForegroundColor Green
Write-Host "  打开浏览器: http://""" + vps_ip + ":" + vps_port + """" -ForegroundColor Yellow
Write-Host "  以后开机后重新运行此脚本即可"
Write-Host "========================================" -ForegroundColor Cyan ; Write-Host ""
"""

with open("${WIN_SCRIPT}", "w", encoding="utf-8") as f:
    f.write(ps1)
print("windows-setup.ps1 generated ok")
PYEOF

info "windows-setup.ps1 已生成"

# ============================================================
# 完成摘要
# ============================================================
echo ""
echo "================================================"
echo "  🎉  部署完成！"
echo "================================================"
echo ""
echo "【⚠️  记得在云服务商控制台安全组放行端口】"
echo "  TCP $PORT  — 前端访问"
echo "  TCP 7000  — frp 控制"
echo "  TCP 6000  — Mac 隧道"
echo "  TCP 6001  — Windows 隧道"
echo ""
echo "【访问地址】"
echo "  主界面:   http://$VPS_IP:$PORT"
echo "  配置指南: http://$VPS_IP:$PORT/guide.html"
echo ""
echo "================================================"
