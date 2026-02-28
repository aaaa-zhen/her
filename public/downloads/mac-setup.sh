#!/bin/bash
# Her — Mac 一键配置脚本
GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo "" && echo "========================================" && echo "  Her — Mac 配置向导" && echo "========================================" && echo ""

if ! nc -z 127.0.0.1 22 2>/dev/null; then
  echo -e "${RED}[✗] SSH 未开启！${NC}"
  echo "请打开：系统设置 → 通用 → 共享 → 远程登录 → 打开"
  read -p "开启后按回车继续..."
  nc -z 127.0.0.1 22 2>/dev/null || error "SSH 仍未开启"
fi
info "SSH 已开启"

mkdir -p ~/Desktop/mac-bridge && info "mac-bridge 文件夹已创建"

mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
if ! grep -q "her-VM-8-16-opencloudos" ~/.ssh/authorized_keys 2>/dev/null; then
  echo "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQChoVwU5s/aP4SCPYivb6s85eTevmFiKoVucaeScG8Q5HankkjG6WBx3vmbnibSX+rVSoW40e2vPCpOs6o/26Xa4YVXRlaSW+Qef97D40FWN9NUxygPmHtzIwpjDck2SsAS/+SLcDNMTBaU3MkOWC0L0q+nlkMNv6ZdRvbI58XzYmnIN/rUXhgfm4N0DEIDFc5AHzjcp4oiUXWq5/unyZ9ymLVHv1wXkx2A6y04qcXLFwU93LSQim1wNDosHF9hkvZgqEbF+IPQo5OPwo1y3XyiDN5lNpRbVKnJSmM0p5WngeWOlt/g+mYGPPc+AuF+26IpYY6dLbIQph5n0t8MYc1O2gXAJ9+ShTOFZXlGpxHj7FbCNnon1vuL45VwC4SiPdy2NPkUUBMCUYXHfRui884EzQ8YO9oQT3RcBx90FL4GDTXEnX+eumK/JQWZptgD4n74K+U7vd87G5IUvGXEo/GKnmnQ17+omb1HHS42K4VkMKE9uLeshrFz8Le9eXIGKp0= root@VM-8-16-opencloudos her-VM-8-16-opencloudos" >> ~/.ssh/authorized_keys
  info "服务器公钥已添加"
else
  info "服务器公钥已存在，跳过"
fi

ARCH=$(uname -m); FRP_VER="0.61.0"
FRP_PKG=$([ "$ARCH" = "arm64" ] && echo "frp_${FRP_VER}_darwin_arm64" || echo "frp_${FRP_VER}_darwin_amd64")
if [ ! -f ~/Desktop/frpc ]; then
  warn "下载 frpc ($ARCH)..."
  curl -sL "https://github.com/fatedier/frp/releases/download/v${FRP_VER}/${FRP_PKG}.tar.gz" -o /tmp/frp_mac.tar.gz
  tar -xzf /tmp/frp_mac.tar.gz -C /tmp
  cp "/tmp/${FRP_PKG}/frpc" ~/Desktop/frpc && chmod +x ~/Desktop/frpc
  rm -rf /tmp/frp_mac.tar.gz "/tmp/${FRP_PKG}"
fi
info "frpc 已就绪"

cat > ~/Desktop/frpc.toml << FRPCEOF
serverAddr = "43.160.213.39"
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

echo "" && echo "========================================" && echo "  配置完成！打开浏览器访问：" && echo "  http://43.160.213.39:3000" && echo "  以后每次开机重新运行此脚本即可" && echo "========================================"
