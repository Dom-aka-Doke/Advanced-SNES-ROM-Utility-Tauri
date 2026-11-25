# Advanced SNES ROM Utility JS (Tauri) - Setup fuer Windows
# Prueft/installiert: Node.js, Rust (rustup), Visual Studio C++ Build Tools, WebView2
# und laedt die Projekt-Abhaengigkeiten (npm, Rust-Crates).
# Aufruf: setup-windows.cmd doppelklicken

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
Start-Transcript -Path (Join-Path $PSScriptRoot 'setup.log') -Force | Out-Null

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}

function Stop-Setup($text) {
    Write-Host $text -ForegroundColor Red
    Stop-Transcript | Out-Null
    exit 1
}

Write-Host '== Advanced SNES ROM Utility JS (Tauri) - Setup ==' -ForegroundColor Cyan
Update-PathFromRegistry
$winget = Get-Command winget -ErrorAction SilentlyContinue

# 1. Node.js (nur zum Bauen: Tauri-CLI und Core-Bundle)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not $winget) { Stop-Setup 'Node.js fehlt und winget ist nicht verfuegbar. Bitte Node.js LTS von https://nodejs.org installieren.' }
    Write-Host 'Installiere Node.js LTS ...' -ForegroundColor Yellow
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    Update-PathFromRegistry
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Setup 'Node.js ist noch nicht im PATH. Bitte das Setup erneut starten.' }
Write-Host ("Node.js: " + (node --version)) -ForegroundColor Green

# 2. Rust (rustup, stabile Toolchain)
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host 'Installiere Rust (rustup) ...' -ForegroundColor Yellow
    $rustup = Join-Path $env:TEMP 'rustup-init.exe'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $rustup
    & $rustup -y --profile minimal --default-toolchain stable 2>&1 | Write-Host
    Update-PathFromRegistry
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Stop-Setup 'Rust konnte nicht installiert werden.' }
cmd /c "rustup default stable 2>&1" | Write-Host
Write-Host ("Rust:    " + (rustc --version)) -ForegroundColor Green

# 3. Visual Studio C++ Build Tools (Linker/Windows SDK fuer Rust)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vc = $null
if (Test-Path $vswhere) {
    $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $vc) {
    if (-not $winget) { Stop-Setup 'C++ Build Tools fehlen. Bitte "Visual Studio Build Tools" mit "Desktopentwicklung mit C++" installieren.' }
    Write-Host 'Installiere Visual Studio C++ Build Tools (gross, dauert einige Minuten, Windows fragt nach Administratorrechten) ...' -ForegroundColor Yellow
    winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements `
        --override '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    if (Test-Path $vswhere) {
        $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    }
}
if (-not $vc) { Stop-Setup 'C++ Build Tools wurden nicht gefunden. Ggf. Neustart und Setup erneut starten.' }
Write-Host ("C++ Build Tools: " + $vc) -ForegroundColor Green

# 4. WebView2 (bei Windows 10/11 normalerweise vorhanden)
$wv = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($wv) { Write-Host ("WebView2: " + (Get-ItemProperty $wv).pv) -ForegroundColor Green }
else { Write-Host 'WebView2 nicht gefunden - der Installer der App laedt es bei Bedarf nach.' -ForegroundColor Yellow }

# 5. Projekt-Abhaengigkeiten
Write-Host 'npm install ...' -ForegroundColor Cyan
cmd /c "npm install 2>&1" | Write-Host
if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm install ist fehlgeschlagen.' }

Write-Host 'Lade Rust-Crates (cargo fetch) ...' -ForegroundColor Cyan
cmd /c "cargo fetch --manifest-path src-tauri\Cargo.toml 2>&1" | Write-Host

Write-Host 'Tests ...' -ForegroundColor Cyan
cmd /c "npm test 2>&1" | Write-Host

Write-Host ''
Write-Host 'Fertig! Jetzt build-windows.cmd starten (erster Build dauert 5-15 Minuten).' -ForegroundColor Green
Stop-Transcript | Out-Null
