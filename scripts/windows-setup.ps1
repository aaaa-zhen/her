# Her - Windows Setup Script
# Run in PowerShell as Administrator

Set-ExecutionPolicy Bypass -Scope Process -Force
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  Her - Windows Setup' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '[XX] Please run as Administrator' -ForegroundColor Red
    Read-Host 'Press Enter to exit'
    exit 1
}
Write-Host '[OK] Admin confirmed' -ForegroundColor Green

# Install OpenSSH Server
$ssh = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($ssh.State -ne 'Installed') {
    Write-Host '[!!] Installing OpenSSH Server...' -ForegroundColor Yellow
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    Write-Host '[OK] OpenSSH Server installed' -ForegroundColor Green
} else {
    Write-Host '[OK] OpenSSH Server exists' -ForegroundColor Green
}

# Start SSH service
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic
Write-Host '[OK] SSH service started (auto-start enabled)' -ForegroundColor Green

# Firewall rule
$rule = Get-NetFirewallRule -Name 'sshd' -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Write-Host '[OK] Firewall port 22 open' -ForegroundColor Green

# Create shared folder
$Desktop = [Environment]::GetFolderPath('Desktop')
New-Item -ItemType Directory -Force -Path (Join-Path $Desktop 'mac-bridge') | Out-Null
Write-Host '[OK] mac-bridge folder created on Desktop' -ForegroundColor Green

# Add server SSH public key
$AuthDir = 'C:\ProgramData\ssh'
$AuthFile = Join-Path $AuthDir 'administrators_authorized_keys'
if (-not (Test-Path $AuthDir)) {
    New-Item -ItemType Directory -Force -Path $AuthDir | Out-Null
}
$marker = 'her-VM-8-16-opencloudos'
$pubkey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQChoVwU5s/aP4SCPYivb6s85eTevmFiKoVucaeScG8Q5HankkjG6WBx3vmbnibSX+rVSoW40e2vPCpOs6o/26Xa4YVXRlaSW+Qef97D40FWN9NUxygPmHtzIwpjDck2SsAS/+SLcDNMTBaU3MkOWC0L0q+nlkMNv6ZdRvbI58XzYmnIN/rUXhgfm4N0DEIDFc5AHzjcp4oiUXWq5/unyZ9ymLVHv1wXkx2A6y04qcXLFwU93LSQim1wNDosHF9hkvZgqEbF+IPQo5OPwo1y3XyiDN5lNpRbVKnJSmM0p5WngeWOlt/g+mYGPPc+AuF+26IpYY6dLbIQph5n0t8MYc1O2gXAJ9+ShTOFZXlGpxHj7FbCNnon1vuL45VwC4SiPdy2NPkUUBMCUYXHfRui884EzQ8YO9oQT3RcBx90FL4GDTXEnX+eumK/JQWZptgD4n74K+U7vd87G5IUvGXEo/GKnmnQ17+omb1HHS42K4VkMKE9uLeshrFz8Le9eXIGKp0= root@VM-8-16-opencloudos her-VM-8-16-opencloudos'
$existing = ''
if (Test-Path $AuthFile) { $existing = Get-Content $AuthFile -Raw }
if ($existing -notmatch [regex]::Escape($marker)) {
    Add-Content -Path $AuthFile -Value $pubkey
    icacls $AuthFile /inheritance:r /grant 'SYSTEM:(F)' /grant 'Administrators:(F)' | Out-Null
    Write-Host '[OK] Server public key added' -ForegroundColor Green
} else {
    Write-Host '[OK] Server public key exists, skipped' -ForegroundColor Green
}

# Download frpc
$FrpcPath = Join-Path $Desktop 'frpc.exe'
if (-not (Test-Path $FrpcPath)) {
    Write-Host '[!!] Downloading frpc.exe...' -ForegroundColor Yellow
    $z = Join-Path $env:TEMP 'frp_win.zip'
    $frpDir = Join-Path $env:TEMP 'frp_win'
    Invoke-WebRequest -Uri 'https://github.com/fatedier/frp/releases/download/v0.61.0/frp_0.61.0_windows_amd64.zip' -OutFile $z -UseBasicParsing
    Expand-Archive -Path $z -DestinationPath $frpDir -Force
    Copy-Item (Join-Path $frpDir 'frp_0.61.0_windows_amd64\frpc.exe') -Destination $FrpcPath
    Remove-Item $z, $frpDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '[OK] frpc.exe downloaded to Desktop' -ForegroundColor Green
} else {
    Write-Host '[OK] frpc.exe exists' -ForegroundColor Green
}

# Write frpc.toml
$toml = Join-Path $Desktop 'frpc.toml'
$lines = @(
    'serverAddr = "43.160.213.39"',
    'serverPort = 7000',
    '',
    '[[proxies]]',
    'name = "win-ssh"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 22',
    'remotePort = 6001'
)
[System.IO.File]::WriteAllLines($toml, $lines)
Write-Host '[OK] frpc.toml configured' -ForegroundColor Green

# Start frpc
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process -FilePath $FrpcPath -ArgumentList ('-c ' + $toml) -WindowStyle Hidden
Start-Sleep -Seconds 4

if (Get-Process frpc -ErrorAction SilentlyContinue) {
    Write-Host '[OK] frpc tunnel started' -ForegroundColor Green
} else {
    Write-Host '[!!] frpc failed to start - check firewall port 7000' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  Setup complete!' -ForegroundColor Green
Write-Host '  Open browser: http://43.160.213.39:3000' -ForegroundColor Yellow
Write-Host '  Re-run this script after each reboot' -ForegroundColor White
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''
Read-Host 'Press Enter to exit'
