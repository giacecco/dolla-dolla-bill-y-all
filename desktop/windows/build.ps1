# Build and package ddbya Desktop for Windows.
# Run from anywhere inside the repo (PowerShell):
#   powershell -ExecutionPolicy Bypass -File desktop\windows\build.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Split-Path -Parent $ScriptDir

Write-Host "==> ddbya Desktop - Windows build"
Write-Host "    Desktop root: $DesktopDir"

# Prerequisites
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node not found. Install from https://nodejs.org"; exit 1
}

# Kill any running instance
Write-Host "==> Stopping any running ddbya Desktop instance..."
Get-Process "ddbya Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# Install dependencies
Set-Location $DesktopDir
Write-Host "==> Installing npm dependencies..."
npm install

# Generate icons (ImageMagick required; if unavailable, supply icon.png/ico manually)
Write-Host "==> Generating icons..."
node macos\generate-icons.js

# Build
Write-Host "==> Building Windows installer..."
npx electron-builder --win --config windows\electron-builder.yml

$InstallerDir = Join-Path $DesktopDir "windows\dist"
Write-Host ""
Write-Host "Done. Installer is in: $InstallerDir"
Write-Host "Note: the build is not Authenticode-signed."
Write-Host "      Add a certificateFile to windows\electron-builder.yml to enable signing."
