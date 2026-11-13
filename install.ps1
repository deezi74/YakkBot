# YakkBot installer for Windows (PowerShell 5.1+). Needs Node.js 22.13+ and Git on PATH.
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Builds the app, writes %USERPROFILE%\.yakkbot\.env with a fresh passphrase, and adds yakkbot.cmd
# (start | stop | status | logs | open) to %USERPROFILE%\.yakkbot\bin.
$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "==> $m" -ForegroundColor DarkYellow }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Install Node.js 22.13 or newer from https://nodejs.org, then run this again.' }
$ok = & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if ($LASTEXITCODE -ne 0) { throw "Node $(node -v) is too old; YakkBot needs 22.13 or newer." }

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$YakkHome = if ($env:YAKK_HOME) { $env:YAKK_HOME } else { Join-Path $env:USERPROFILE '.yakkbot' }
New-Item -ItemType Directory -Force -Path $YakkHome, (Join-Path $YakkHome 'bin') | Out-Null

Set-Location $Dir
Say 'Installing dependencies'
npm ci --no-audit --no-fund --loglevel=error; if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund --loglevel=error }
Say 'Building'
npm run build --silent
if ($LASTEXITCODE -ne 0) { throw 'The build failed.' }

$EnvFile = Join-Path $YakkHome '.env'
$Pass = $null
if (-not (Test-Path $EnvFile)) {
  $bytes = New-Object byte[] 12; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Pass = ([Convert]::ToBase64String($bytes) -replace '[/+=]', '').Substring(0, 14)
  @"
# YakkBot settings. Edit, then: yakkbot restart
PORT=8787
HOST=127.0.0.1
YAKK_OWNER=$env:USERNAME
YAKK_PASSWORD=$Pass
YAKK_SHELL_APPROVAL=risky
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
# OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
# XAI_API_KEY=
# COMPOSIO_API_KEY=
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_ALLOWED_CHATS=
"@ | Set-Content -Encoding UTF8 $EnvFile
  icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

$Cmd = Join-Path $YakkHome 'bin\yakkbot.cmd'
@"
@echo off
set YAKK_HOME=$YakkHome
set LOG=%YAKK_HOME%\yakkbot.log
if "%1"=="start" goto start
if "%1"=="stop" goto stop
if "%1"=="restart" ( call "%~f0" stop & goto start )
if "%1"=="status" ( curl -s http://127.0.0.1:8787/api/health || echo stopped & goto :eof )
if "%1"=="logs" ( powershell -NoProfile -Command "Get-Content -Wait -Tail 80 '%LOG%'" & goto :eof )
if "%1"=="open" ( start "" http://localhost:8787 & goto :eof )
echo usage: yakkbot start ^| stop ^| restart ^| status ^| logs ^| open
goto :eof
:start
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath node -ArgumentList '--disable-warning=ExperimentalWarning','server/dist/index.js' -WorkingDirectory '$Dir' -RedirectStandardOutput '%LOG%' -RedirectStandardError '%LOG%.err'"
echo YakkBot starting: http://localhost:8787
goto :eof
:stop
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { `$_.CommandLine -like '*server/dist/index.js*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId }"
echo Stopped.
"@ | Set-Content -Encoding ASCII $Cmd

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$BinDir = Join-Path $YakkHome 'bin'
if ($UserPath -notlike "*$BinDir*") { [Environment]::SetEnvironmentVariable('Path', "$UserPath;$BinDir", 'User'); Say "Added $BinDir to your PATH (open a new terminal to use 'yakkbot')." }

& $Cmd start
Write-Host ''
Say 'YakkBot is installed. Open http://localhost:8787'
if ($Pass) { Write-Host "    Passphrase: $Pass   (saved in $EnvFile)" }
Write-Host '    Add a model: open your bot > details > Engine, pick a provider, paste a key.'
Write-Host '    The bots shell commands run in PowerShell on Windows. For bash, use WSL2 and install.sh.'
