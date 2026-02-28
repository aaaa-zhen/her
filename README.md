# Her Assistant

一个自托管的 AI 伙伴，部署在 VPS 上，可以通过浏览器（手机/电脑）随时聊天，并远程控制你的 Mac 或 Windows 电脑。

## 它是什么

Her 是一个基于 Claude API 的 AI 聊天助手，跑在你自己的服务器上。它不只是聊天 — 它能：

- 在服务器上执行命令、管理文件
- 通过 SSH 隧道远程控制你的 Mac / Windows（装软件、跑脚本、读写文件）
- 下载视频/音频（YouTube、B站、Twitter 等 1000+ 网站）
- 转换媒体格式（视频转 MP3、压缩、剪辑）
- 网页截图、搜索互联网、读取网页内容
- 定时任务、长期记忆

## 架构

```
手机/电脑浏览器
    │
    ▼
┌──────────┐      SSH 隧道 (frp)      ┌──────────────┐
│  VPS     │◄────────────────────────►│ 你的电脑      │
│  Her     │   端口 6000 (Mac)         │ Mac / Windows │
│  :3000   │   端口 6001 (Windows)     │               │
└──────────┘                           └──────────────┘
```

VPS 作为中转站，通过 frp 反向隧道连接你的本地电脑。浏览器访问 VPS 上的 Her，Her 可以通过隧道 SSH 到你的电脑执行操作。

## 项目结构

```
her-assistant/
├── server.js              # 后端：Express + WebSocket + Claude API + 9 个工具
├── public/
│   ├── index.html         # 聊天界面（深色/浅色主题）
│   └── guide.html         # 客户端配置指南页
├── scripts/
│   ├── deploy.sh          # VPS 一键部署脚本
│   ├── mac-setup.sh       # Mac 客户端配置脚本（部署时自动生成）
│   └── windows-setup.ps1  # Windows 客户端配置脚本
├── package.json
└── .env.example
```

运行后自动创建：
```
├── shared/                # AI 下载/生成的文件
├── data/
│   ├── memory.json        # AI 长期记忆
│   └── schedules.json     # 定时任务持久化
└── .env                   # 配置文件
```

## 部署到 VPS

### 方式一：一键部署脚本

把项目上传到 VPS，然后运行：

```bash
bash scripts/deploy.sh
```

脚本会自动完成：安装 Node.js、frp、yt-dlp、ffmpeg、配置 systemd 服务、设置防火墙等。按提示输入 API Key 和密码即可。

### 方式二：手动部署

**1. 上传项目到 VPS**

```bash
scp -r . root@你的VPS_IP:/opt/her
```

**2. 安装依赖**

```bash
cd /opt/her
yum install -y nodejs fuse-sshfs   # CentOS/OpenCloudOS
# apt install -y nodejs sshfs      # Ubuntu/Debian
npm install
```

**3. 配置环境变量**

```bash
cp .env.example .env
nano .env
```

```env
ANTHROPIC_API_KEY=sk-xxx        # Claude API Key
ANTHROPIC_BASE_URL=              # 留空用官方，或填代理地址
PORT=3000
AUTH_PASSWORD=your_password      # 登录密码
MAC_SSH_USER=your_mac_username   # Mac 用户名
```

**4. 安装 frp 服务端**

```bash
wget https://github.com/fatedier/frp/releases/download/v0.61.0/frp_0.61.0_linux_amd64.tar.gz
tar -xzf frp_0.61.0_linux_amd64.tar.gz
cp frp_0.61.0_linux_amd64/frps /usr/local/bin/

mkdir -p /etc/frp
echo 'bindPort = 7000' > /etc/frp/frps.toml
```

创建 systemd 服务 `/etc/systemd/system/frps.service`：
```ini
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
```

```bash
systemctl daemon-reload && systemctl enable frps && systemctl start frps
```

**5. 启动 Her 服务**

创建 `/etc/systemd/system/her.service`：
```ini
[Unit]
Description=Her AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/her
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable her && systemctl start her
```

**6. 云服务商安全组放行端口**

| 端口 | 用途 |
|------|------|
| 3000 | Her 网页访问 |
| 7000 | frp 通信端口 |
| 6000 | Mac SSH 隧道 |
| 6001 | Windows SSH 隧道 |

## 连接本地电脑

部署完成后，浏览器打开 `http://你的VPS_IP:3000/guide.html`，按指引操作。

### Mac

打开终端，复制运行：

```bash
curl -sL http://你的VPS_IP:3000/downloads/mac-setup.sh | bash
```

脚本自动完成：安装 frpc、配置 SSH 隧道、添加公钥。

### Windows

打开管理员 PowerShell，复制运行：

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; irm http://你的VPS_IP:3000/downloads/windows-setup.ps1 -OutFile $env:TEMP\her-setup.ps1; & $env:TEMP\her-setup.ps1
```

脚本自动完成：安装 OpenSSH Server、下载 frpc、配置隧道、添加公钥。

> 注意：运行时请关闭全局 VPN，否则隧道可能连不上。

### 验证连接

连接成功后，Her 聊天页面的顶部会显示 **"Windows connected"** 或 **"Mac connected"**。

## 工具列表

| 工具 | 用途 |
|------|------|
| bash | 执行任意服务器命令 |
| send_file | 发送文件到聊天 |
| browse | 网页截图 / PDF / 文本提取 (Playwright) |
| download_media | 下载视频/音频 (yt-dlp) |
| convert_media | 媒体转换 (ffmpeg) |
| search_web | 搜索互联网 |
| read_url | 读取网页正文 |
| schedule_task | 定时任务 |
| memory | 长期记忆 |

## 常见问题

**frpc 连不上 VPS？**
检查云服务商安全组是否放行了 7000 端口。关闭全局 VPN 再试。

**重启电脑后隧道断了？**
重新运行配置脚本即可。

**端口 3000 被占用？**
```bash
fuser -k 3000/tcp
systemctl restart her
```
