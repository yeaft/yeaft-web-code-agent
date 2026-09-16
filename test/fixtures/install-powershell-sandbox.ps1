param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Sandbox,
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Secret,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [string]$Mode = 'existing'
)
$ErrorActionPreference = 'Stop'
$env:HOME = Join-Path $Sandbox 'home'
$env:USERPROFILE = $env:HOME
$env:APPDATA = Join-Path $Sandbox 'appdata'
$env:USERNAME = 'sandbox-user'
$env:PATH = 'sandbox-original-path'
$env:WORK_DIR = 'inherited-work-dir'
$env:YEAFT_DIR = 'inherited-yeaft-dir'
$env:SERVER_URL = 'inherited-server'
$env:AGENT_SECRET = 'inherited-secret'
$env:PM2_HOME = 'existing-pm2-home'
New-Item -ItemType Directory -Force -Path $env:HOME, $env:APPDATA | Out-Null
$script:AclCalled = $false
$script:DownloadCalled = $false
$env:FIXTURE_CLI_TEMPLATE = Join-Path $Sandbox 'cli-template.js'
Set-Content -LiteralPath $env:FIXTURE_CLI_TEMPLATE -Encoding UTF8 -Value @'
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `yeaft-agent-${value('--name')}.bat`);
fs.mkdirSync(path.dirname(startup), { recursive: true });
fs.writeFileSync(startup, '@echo off\r\npm2 resurrect\r\nstart "" powershell -File "C:\\mock\\agent-tray.ps1"\r\n');
fs.writeFileSync(path.join(process.env.APPDATA, 'cli-capture.json'), JSON.stringify({
  args, secret:process.env.AGENT_SECRET, server:process.env.SERVER_URL,
  workDir:process.env.WORK_DIR, yeaftDir:process.env.YEAFT_DIR, runtimePath:process.env.PATH,
}));
'@
function Install-FixtureRuntime([string]$Directory, [bool]$WithNpm) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  # A copy (not symlink) exercises process.execPath real runtime selection.
  Copy-Item -LiteralPath $NodePath -Destination (Join-Path $Directory 'node.exe')
  if (-not $WithNpm) { return }
  $NpmFile = Join-Path $Directory 'node_modules/npm/bin/npm-cli.js'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NpmFile) | Out-Null
  Set-Content -LiteralPath $NpmFile -Encoding UTF8 -Value @'
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
if(args.includes('--version')) { console.log('11.0.0'); process.exit(0); }
const prefix=args[args.indexOf('--prefix')+1];
if(!prefix || !args.includes('--global=false')) process.exit(3);
const cli=path.join(prefix,'node_modules/@yeaft/webchat-agent/cli.js'),pm2=path.join(prefix,'node_modules/pm2/bin/pm2');
fs.mkdirSync(path.dirname(cli),{recursive:true});fs.mkdirSync(path.dirname(pm2),{recursive:true});
fs.copyFileSync(process.env.FIXTURE_CLI_TEMPLATE,cli);fs.writeFileSync(pm2,'// mock pm2');
'@
}
$script:FixtureNodeDir = Join-Path $Sandbox 'existing-node'
if ($Mode -eq 'existing' -or $Mode -eq 'mismatched-npm') {
  Install-FixtureRuntime $script:FixtureNodeDir ($Mode -eq 'existing')
}
function Get-Command {
  param([string]$Name, [Parameter(ValueFromRemainingArguments = $true)]$Rest)
  if ($Name -eq 'node.exe' -or $Name -eq 'node') {
    if ($Mode -ne 'existing' -and $Mode -ne 'mismatched-npm') { return $null }
    return [pscustomobject]@{ Source = (Join-Path $script:FixtureNodeDir 'node.exe') }
  }
  if ($Name -eq 'npm.cmd' -or $Name -eq 'npm') { throw 'A foreign npm shim must never be discovered or invoked' }
  Microsoft.PowerShell.Core\Get-Command $Name @Rest
}
function icacls.exe { $script:AclCalled = $true; $global:LASTEXITCODE = 0 }
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $MaximumRedirection, [string]$Uri, [string]$OutFile)
  $script:DownloadCalled = $true
  if ($Uri -match 'SHASUMS256.txt$') {
    $Hash = if ($Mode -eq 'bad-checksum') { '0' * 64 } else { 'a' * 64 }
    Set-Content -LiteralPath $OutFile -Value "$Hash  node-v24.9.0-win-x64.zip"
  } else { Set-Content -LiteralPath $OutFile -Value 'mock-zip' }
}
function Get-FileHash { param($Algorithm, $LiteralPath) return @{ Hash = 'a' * 64 } }
function Expand-Archive {
  param($LiteralPath, $DestinationPath)
  Install-FixtureRuntime (Join-Path $DestinationPath 'node-v24.9.0-win-x64') $true
}
. $Installer -Server $Server -Secret $Secret
$Capture = Get-Content -LiteralPath (Join-Path $env:APPDATA 'cli-capture.json') -Raw | ConvertFrom-Json
$Installation = Get-ChildItem -LiteralPath (Join-Path $env:HOME '.yeaft/installations') -Directory | Select-Object -First 1
$Startup = Get-ChildItem -LiteralPath $env:APPDATA -Recurse -File | Where-Object Name -like 'yeaft-agent-*.bat' | Select-Object -First 1
$StartupText = Get-Content -LiteralPath $Startup.FullName -Raw
[pscustomobject]@{
  aclCalled = $script:AclCalled
  downloaded = $script:DownloadCalled
  complete = Test-Path -LiteralPath (Join-Path $Installation.FullName '.complete')
  manager = Test-Path -LiteralPath (Join-Path $Installation.FullName 'yeaft-agent.ps1')
  secretMatched = $Capture.secret -ceq $Secret
  secretInArgs = @($Capture.args) -contains $Secret
  serverMatched = $Capture.server -ceq $Server
  explicitWorkDir = $Capture.workDir -ceq (Join-Path $Installation.FullName 'workspace')
  explicitYeaftDir = $Capture.yeaftDir -ceq (Join-Path $Installation.FullName 'data')
  pm2Restored = $env:PM2_HOME -ceq 'existing-pm2-home'
  startupPrivatePm2 = $StartupText -match 'PM2_HOME='
  managerPrivatePath = (Get-Content -LiteralPath (Join-Path $Installation.FullName 'yeaft-agent.ps1') -Raw) -match 'PM2_HOME'
  upgradeResolvesPm2 = @($Capture.runtimePath -split ';') -contains $Installation.FullName
  startupAbsoluteNode = $StartupText -match [regex]::Escape($Sandbox)
  startupAbsolutePm2 = $StartupText -match 'node_modules[\\/]pm2[\\/]bin[\\/]pm2'
  startupTrayPreserved = $StartupText -match 'agent-tray\.ps1'
  pathRestored = $env:PATH -ceq 'sandbox-original-path'
  workDirRestored = $env:WORK_DIR -ceq 'inherited-work-dir'
  yeaftDirRestored = $env:YEAFT_DIR -ceq 'inherited-yeaft-dir'
  serverRestored = $env:SERVER_URL -ceq 'inherited-server'
  secretRestored = $env:AGENT_SECRET -ceq 'inherited-secret'
} | ConvertTo-Json -Compress
