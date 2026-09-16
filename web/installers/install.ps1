# Safe user-level installer for the Yeaft Agent.
[CmdletBinding()]
param(
  [Parameter()][string]$Server,
  [Parameter()][string]$Secret,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$NodeChannel = 24
$Registry = 'https://pkg.yeaft.com/'
$Package = '@yeaft/webchat-agent@latest'
$Prefix = $null
$NpmCli = $null
$OwnedPrefix = $false
$ServiceInstallAttempted = $false
$InstallFailed = $false
$OriginalPath = $env:PATH
$OriginalTls = [Net.ServicePointManager]::SecurityProtocol
$SavedEnvironment = @{}
foreach ($Key in @('AGENT_SECRET', 'SERVER_URL', 'AGENT_NAME', 'YEAFT_AGENT_INSTANCE', 'WORK_DIR', 'YEAFT_DIR', 'PM2_HOME')) {
  $Item = Get-Item -LiteralPath "Env:$Key" -ErrorAction SilentlyContinue
  $SavedEnvironment[$Key] = @{ Present = $null -ne $Item; Value = if ($Item) { $Item.Value } else { $null } }
}

function Show-Help {
@'
Usage: install.ps1 -Server <ws:// or wss:// URL> -Secret <agent secret>

Installs a new, independently named Yeaft Agent in
$HOME\.yeaft\installations\<hostname>-NNNN. It never elevates privileges,
changes global PATH or npm configuration, or modifies an existing Agent. Node
24 is downloaded from nodejs.org only when installed Node/npm cannot satisfy
Node >=22.5.0.
'@
}
function Stop-Install([string]$Message) { throw $Message }
function Test-Node([string]$NodePath) {
  # No embedded double quotes: Windows PowerShell 5.1 strips them in native argv.
  & $NodePath --no-warnings -e 'const v=process.versions.node.split(String.fromCharCode(46)).map(Number);if(v[0]<22||(v[0]===22&&v[1]<5))process.exit(1);require(String.fromCharCode(110,111,100,101,58,115,113,108,105,116,101))' *> $null
  return $LASTEXITCODE -eq 0
}
function Quote-PowerShellLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

try {
  if ($Help) { Show-Help; return }

  $ParsedServer = $null
  $ServerValid = -not [string]::IsNullOrWhiteSpace($Server) -and
    -not ($Server -match "[\r\n]") -and
    [Uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$ParsedServer) -and
    ($ParsedServer.Scheme -eq 'ws' -or $ParsedServer.Scheme -eq 'wss') -and
    -not [string]::IsNullOrWhiteSpace($ParsedServer.Host) -and
    [string]::IsNullOrEmpty($ParsedServer.UserInfo)
  if (-not $ServerValid) { Stop-Install '-Server must be a valid ws:// or wss:// URL with a host' }
  if ([string]::IsNullOrWhiteSpace($Secret)) { Stop-Install '-Secret must not be empty' }
  if ($Secret -match "[\r\n]") { Stop-Install 'arguments must not contain line breaks' }
  if (-not $env:APPDATA) { Stop-Install 'APPDATA is required to install the Windows user service' }
  $UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { $HOME }
  if (-not $UserHome) { Stop-Install 'HOME is required to allocate the Agent installation' }
  if ($UserHome -match "[\r\n]" -or $env:APPDATA -match "[\r\n]") { Stop-Install 'arguments must not contain line breaks' }

  $Node = $null
  $Npm = $null
  $DownloadedRuntime = $false
  $NodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $NodeCommand) { $NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue }
  if ($NodeCommand -and (Test-Node $NodeCommand.Source)) {
    # A PATH npm.cmd may use a different adjacent node.exe (nvm/Volta/shims).
    # Resolve Node's actual executable and require its own npm JS entry point.
    $CandidateNode = (& $NodeCommand.Source --no-warnings -p 'process.execPath' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and [IO.Path]::IsPathRooted($CandidateNode)) {
      $NpmCandidate = Join-Path (Split-Path -Parent $CandidateNode) 'node_modules\npm\bin\npm-cli.js'
      if ((Test-Path -LiteralPath $NpmCandidate) -and (Test-Node $CandidateNode)) {
        & $CandidateNode $NpmCandidate --version *> $null
        if ($LASTEXITCODE -eq 0) { $Node = $CandidateNode; $NpmCli = $NpmCandidate }
      }
    }
  }

  $Root = Join-Path $UserHome '.yeaft\installations'
  $InstancesRoot = Join-Path $UserHome '.yeaft\instances'
  $HostPart = ([Environment]::MachineName.ToLowerInvariant() -replace '[^a-z0-9._-]', '-').Trim('-')
  if (-not $HostPart) { $HostPart = 'agent' }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  New-Item -ItemType Directory -Force -Path $InstancesRoot | Out-Null

  $Name = $null
  for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
    $Digits = '{0:D4}' -f (Get-Random -Minimum 0 -Maximum 10000)
    $Candidate = "$HostPart-$Digits"
    $CandidatePrefix = Join-Path $Root $Candidate
    $CandidateData = Join-Path $InstancesRoot $Candidate
    $CandidateConfig = Join-Path $env:APPDATA "yeaft-agent\instances\$Candidate"
    $CandidateStartup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\yeaft-agent-$Candidate.bat"
    if ((Test-Path -LiteralPath $CandidatePrefix) -or (Test-Path -LiteralPath $CandidateData) -or
        (Test-Path -LiteralPath $CandidateConfig) -or (Test-Path -LiteralPath $CandidateStartup)) { continue }
    try {
      New-Item -ItemType Directory -Path $CandidatePrefix -ErrorAction Stop | Out-Null
      $Prefix = $CandidatePrefix
      $OwnedPrefix = $true
      Set-Content -LiteralPath (Join-Path $Prefix '.installer-owned') -Value $PID -NoNewline
      $Name = $Candidate
      break
    } catch {
      if (Test-Path -LiteralPath $CandidatePrefix) { continue }
      throw
    }
  }
  if (-not $Name) { Stop-Install 'could not allocate a unique Agent name' }

  # The directory was atomically created by this process. Do not alter ACLs on
  # pre-existing directories. Disable inheritance and grant only the current
  # user, SYSTEM, and Administrators full control.
  $CurrentUserAcl = $null
  try { $CurrentUserAcl = '*' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
  if (-not $CurrentUserAcl) { $CurrentUserAcl = $env:USERNAME }
  if (-not $CurrentUserAcl) { Stop-Install 'could not identify the current Windows user' }
  & icacls.exe $Prefix '/inheritance:r' '/grant:r' "${CurrentUserAcl}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'could not restrict installation directory permissions' }

  if (-not $Node) {
    $Architecture = $null
    try { $Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch {}
    if ([string]::IsNullOrWhiteSpace($Architecture)) {
      $Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($Architecture) {
      '^(X64|AMD64|x86_64)$' { $NodeArch = 'x64'; break }
      '^(Arm64|ARM64|aarch64)$' { $NodeArch = 'arm64'; break }
      default { Stop-Install 'unsupported CPU architecture' }
    }
    $DownloadDir = Join-Path $Prefix '.download'
    New-Item -ItemType Directory -Path $DownloadDir | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $SumsPath = Join-Path $DownloadDir 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri "https://nodejs.org/dist/latest-v$NodeChannel.x/SHASUMS256.txt" -OutFile $SumsPath
    $Match = Get-Content -LiteralPath $SumsPath | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+node-v24\.[0-9.]+-win-$NodeArch\.zip$" } | Select-Object -First 1
    if (-not $Match) { Stop-Install 'no supported Node.js archive was listed by nodejs.org' }
    $Parts = $Match -split '\s+', 2
    $Expected = $Parts[0].ToLowerInvariant()
    $File = $Parts[1].Trim()
    $Archive = Join-Path $DownloadDir $File
    $VersionMatch = [regex]::Match($File, '^node-v([0-9.]+)-')
    if (-not $VersionMatch.Success) { Stop-Install 'no supported Node.js archive was listed by nodejs.org' }
    $NodeVersion = $VersionMatch.Groups[1].Value
    Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri "https://nodejs.org/dist/v$NodeVersion/$File" -OutFile $Archive
    $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { Stop-Install 'Node.js checksum verification failed' }
    $Extracted = Join-Path $DownloadDir 'extracted'
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted
    $NodeFolder = Get-ChildItem -LiteralPath $Extracted -Directory | Select-Object -First 1
    if (-not $NodeFolder) { Stop-Install 'could not unpack Node.js' }
    $Runtime = Join-Path $Prefix 'runtime'
    Move-Item -LiteralPath $NodeFolder.FullName -Destination $Runtime
    Remove-Item -LiteralPath $DownloadDir -Recurse -Force
    $Node = Join-Path $Runtime 'node.exe'
    $Npm = Join-Path $Runtime 'npm.cmd'
    $NpmCli = Join-Path $Runtime 'node_modules\npm\bin\npm-cli.js'
    $DownloadedRuntime = $true
    if (-not (Test-Node $Node)) { Stop-Install 'downloaded Node.js does not meet the minimum version' }
  }

  $NodeDir = Split-Path -Parent $Node
  $LocalBin = Join-Path $Prefix 'node_modules\.bin'
  $env:PATH = "$NodeDir;$Prefix;$LocalBin;$OriginalPath"
  & $Node $NpmCli --version *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'the selected Node.js does not provide a working npm' }
  & $Node $NpmCli --prefix $Prefix --global=false install $Package pm2 --registry=$Registry --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Stop-Install 'npm could not install the Yeaft Agent' }

  $Cli = Join-Path $Prefix 'node_modules\@yeaft\webchat-agent\cli.js'
  $Pm2 = Join-Path $Prefix 'node_modules\pm2\bin\pm2'
  if (-not (Test-Path -LiteralPath $Cli) -or -not (Test-Path -LiteralPath $Pm2)) {
    Stop-Install 'the installed package did not provide the required CLI and PM2 runtime'
  }

  $WorkDir = Join-Path $Prefix 'workspace'
  $YeaftDir = Join-Path $Prefix 'data'
  New-Item -ItemType Directory -Path $WorkDir | Out-Null
  $Pm2Home = Join-Path $Prefix 'pm2'
  $env:PM2_HOME = $Pm2Home
  $env:SERVER_URL = $Server
  $env:AGENT_SECRET = $Secret
  $env:AGENT_NAME = $Name
  $env:YEAFT_AGENT_INSTANCE = $Name
  $env:WORK_DIR = $WorkDir
  $env:YEAFT_DIR = $YeaftDir
  $ServiceInstallAttempted = $true
  & $Node $Cli install --name $Name --yeaft-dir $YeaftDir --work-dir $WorkDir *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Install 'the Agent service could not be installed' }

  # The published Windows service writes a bare "pm2 resurrect" line. Repair
  # only this newly allocated instance startup file, retaining its tray line.
  $StartupPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\yeaft-agent-$Name.bat"
  if (-not (Test-Path -LiteralPath $StartupPath)) { Stop-Install 'the Agent startup file was not created' }
  $StartupLines = @(Get-Content -LiteralPath $StartupPath)
  $TrayLines = @($StartupLines | Where-Object { $_ -match '^\s*start\s+.*agent-tray\.ps1' })
  $BatchNode = $Node.Replace('%', '%%')
  $BatchPm2 = $Pm2.Replace('%', '%%')
  $BatchPath = "$NodeDir;$Prefix;$LocalBin".Replace('%', '%%')
  $BatchHome = $Pm2Home.Replace('%', '%%')
  $StartupContent = @('@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul', "set `"PATH=$BatchPath;%PATH%`"", "set `"PM2_HOME=$BatchHome`"", "`"$BatchNode`" `"$BatchPm2`" resurrect") + $TrayLines
  [IO.File]::WriteAllText($StartupPath, ($StartupContent -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($false)))

  $Manager = Join-Path $Prefix 'yeaft-agent.ps1'
  $NodeLiteral = Quote-PowerShellLiteral $Node
  $CliLiteral = Quote-PowerShellLiteral $Cli
  $NameLiteral = Quote-PowerShellLiteral $Name
  $YeaftLiteral = Quote-PowerShellLiteral $YeaftDir
  $WorkLiteral = Quote-PowerShellLiteral $WorkDir
  $PathLiteral = Quote-PowerShellLiteral "$NodeDir;$Prefix;$LocalBin"
  $Pm2HomeLiteral = Quote-PowerShellLiteral $Pm2Home
  Set-Content -LiteralPath $Manager -Encoding UTF8 -Value @"
# Run this file in a child PowerShell, preserving the caller's environment.
if (`$args -contains 'upgrade') { Write-Error 'Use this Agent instance in the Web UI to upgrade safely.'; exit 1 }
`$oldPath = `$env:PATH
`$oldPm2Home = `$env:PM2_HOME
try {
  `$env:PATH = $PathLiteral + ';' + `$oldPath
  `$env:PM2_HOME = $Pm2HomeLiteral
  & $NodeLiteral $CliLiteral @args --name $NameLiteral --yeaft-dir $YeaftLiteral --work-dir $WorkLiteral
  `$code = `$LASTEXITCODE
} finally {
  `$env:PATH = `$oldPath
  `$env:PM2_HOME = `$oldPm2Home
}
exit `$code
"@
  Set-Content -LiteralPath (Join-Path $Prefix 'node-path') -Value $Node
  Remove-Item -LiteralPath (Join-Path $Prefix '.installer-owned') -Force
  New-Item -ItemType File -Path (Join-Path $Prefix '.complete') | Out-Null
  Write-Host "`nYeaft Agent $Name was installed."
  Set-Content -LiteralPath (Join-Path $Prefix 'management-command') -Value $Manager
  Write-Host "Manage it with:`n  powershell -NoProfile -ExecutionPolicy Bypass -File $(Quote-PowerShellLiteral $Manager) status"
} catch {
  $InstallFailed = $true
  if ($OwnedPrefix -and -not $ServiceInstallAttempted -and $Prefix -and
      (Test-Path -LiteralPath (Join-Path $Prefix '.installer-owned'))) {
    Remove-Item -LiteralPath $Prefix -Recurse -Force -ErrorAction SilentlyContinue
  }
  $SafeMessages = @(
    '-Server must be a valid ws:// or wss:// URL with a host','-Secret must not be empty',
    'arguments must not contain line breaks','APPDATA is required to install the Windows user service',
    'HOME is required to allocate the Agent installation','unsupported CPU architecture',
    'could not allocate a unique Agent name','could not identify the current Windows user',
    'could not restrict installation directory permissions',
    'no supported Node.js archive was listed by nodejs.org','Node.js checksum verification failed',
    'could not unpack Node.js','downloaded Node.js does not meet the minimum version',
    'npm could not install the Yeaft Agent','the selected Node.js does not provide a working npm',
    'the installed package did not provide the required CLI and PM2 runtime',
    'the Agent service could not be installed','the Agent startup file was not created'
  )
  $Message = if ($SafeMessages -contains $_.Exception.Message) { $_.Exception.Message } else { 'an unexpected operation failed; no existing Agent was changed' }
  [Console]::Error.WriteLine("Yeaft Agent installation failed: $Message")
} finally {
  $env:PATH = $OriginalPath
  [Net.ServicePointManager]::SecurityProtocol = $OriginalTls
  foreach ($Key in $SavedEnvironment.Keys) {
    if ($SavedEnvironment[$Key].Present) { Set-Item -LiteralPath "Env:$Key" -Value $SavedEnvironment[$Key].Value }
    else { Remove-Item -LiteralPath "Env:$Key" -ErrorAction SilentlyContinue }
  }
}
if ($InstallFailed) { exit 1 }
