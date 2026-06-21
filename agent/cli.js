#!/usr/bin/env node
/**
 * CLI entry point for @yeaft/webchat-agent
 * Parses command-line arguments and starts the agent or runs subcommands
 */
import { assertNodeVersion } from './check-node-version.js';
assertNodeVersion({ component: '@yeaft/webchat-agent' });

import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';
import {
  addOrUpdateProvider,
  formatLlmConfig,
  getDefaultYeaftConfigPath,
  readLocalLlmConfig,
  removeProvider,
  setLocalModels,
  useGitHubCopilot,
  useOpenAICompatible,
  writeLocalLlmConfig,
} from './llm-config-cli.js';
import {
  discoverGitHubCopilotModels,
  discoverOpenAICompatibleModels,
  GITHUB_COPILOT_PROVIDER,
} from './llm-model-discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

// Service management subcommands
const SERVICE_COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];

if (command === 'doctor') {
  handleDoctorCommand();
} else if (command === 'llm') {
  await handleLlmCommand(subArgs);
} else if (command === 'upgrade') {
  upgrade();
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === '--help' || command === '-h') {
  printHelp();
} else if (SERVICE_COMMANDS.includes(command)) {
  handleServiceCommand(command, subArgs);
} else {
  // Normal agent startup — parse flags and set env vars
  parseAndStart(args);
}

function printHelp() {
  console.log(`
  ${pkg.name} v${pkg.version}

  Usage:
    yeaft-agent [options]              Run agent in foreground
    yeaft-agent install [options]      Install as system service
    yeaft-agent uninstall [options]    Remove system service
    yeaft-agent start [options]        Start installed service
    yeaft-agent stop [options]         Stop installed service
    yeaft-agent restart [options]      Restart installed service
    yeaft-agent status [options]       Show service status
    yeaft-agent logs [options]         View service logs (follow mode)
    yeaft-agent doctor                 Diagnose service configuration
    yeaft-agent llm <command>          Configure local Yeaft LLM providers/models
    yeaft-agent upgrade                Upgrade to latest version
    yeaft-agent --version              Show version

  Options:
    --instance <id>     Local service instance id (default: default)
    --server <url>      WebSocket server URL (default: ws://localhost:3456)
    --name <name>       Agent display name (default: Worker-{platform}-{pid})
    --secret <secret>   Agent secret for authentication
    --work-dir <dir>    Default working directory (default: cwd)
    --yeaft-dir <dir>   Yeaft data directory for this instance
    --auto-upgrade      Check for updates on startup

  Environment variables (alternative to flags):
    YEAFT_AGENT_INSTANCE Local service instance id
    SERVER_URL          WebSocket server URL
    AGENT_NAME          Agent display name
    AGENT_SECRET        Agent secret
    WORK_DIR            Working directory
    YEAFT_DIR           Yeaft data directory

  Examples:
    yeaft-agent --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent install --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent install --instance second --server wss://your-server.com --name my-worker-2 --secret xxx
    yeaft-agent status --instance second
    yeaft-agent logs --instance second
`);
}

function printLlmHelp() {
  console.log(`
  Configure local Yeaft LLM providers/models in ~/.yeaft/config.json.

  Usage:
    yeaft-agent llm show [--reveal]
    yeaft-agent llm list-models [<provider-name>]
    yeaft-agent llm setup
    yeaft-agent llm use github-copilot --model <modelId> [--fast <modelId>] [--allow-unknown-model]
    yeaft-agent llm use openai-compatible --name <name> --base-url <url> --api-key-env <ENV> --model <modelId> [--fast <modelId>]
    yeaft-agent llm add-provider --name <name> --base-url <url> --models <m1,m2> \
      [--api-key <key>|--api-key-env <ENV>|--credential-provider github-copilot] \
      [--protocol anthropic|openai-responses] [--set-primary <model>] [--set-fast <model>]
    yeaft-agent llm set-model [--primary <provider/model>] [--fast <provider/model>]
    yeaft-agent llm remove-provider --name <name>

  Behavior:
    setup/use are the recommended low-config path; add-provider is the advanced manual path.
    GitHub Copilot uses the local credential provider and never writes a token to config.
    add-provider updates/replaces an existing provider with the same --name.
    --api-key-env reads the environment variable value and writes it as apiKey.
    set-model requires full provider/model references.
    list-models with no provider lists the local config offline; with 'github-copilot'
      or a configured provider name, it queries the live '/models' catalog.
    --config <path> can target a config file for tests or scripted setup.

  Examples:
    yeaft-agent llm setup
    yeaft-agent llm use github-copilot --model claude-sonnet-4.5 --fast gpt-4.1
    OPENAI_KEY=sk-... yeaft-agent llm add-provider --name openai --base-url https://api.openai.com/v1 --models gpt-5,gpt-4.1 --api-key-env OPENAI_KEY --protocol openai-responses --set-primary gpt-5
    yeaft-agent llm set-model --primary openai/gpt-5 --fast openai/gpt-4.1
    yeaft-agent llm show --reveal
`);
}

async function handleLlmCommand(args) {
  const subcommand = args[0];

  try {
    // `use <preset>` and `list-models <provider-name>` both put a positional
    // arg right after the subcommand; trim it off before flag parsing so
    // parseLlmArgs sees only flags.
    const positionalAfterSub =
      subcommand === 'use' ? 2
      : (subcommand === 'list-models' && args[1] && !args[1].startsWith('--')) ? 2
      : 1;
    const options = parseLlmArgs(args.slice(positionalAfterSub));
    const configPath = options.config || getDefaultYeaftConfigPath();
    if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
      printLlmHelp();
      return;
    }

    if (subcommand === 'show') {
      const config = readLocalLlmConfig(configPath);
      console.log(formatLlmConfig({ ...config, __configPath: configPath }, { reveal: Boolean(options.reveal) }));
      return;
    }

    if (subcommand === 'list-models') {
      // `yeaft-agent llm list-models` (no provider) — list models declared in
      //   the local config (offline; no network call).
      // `yeaft-agent llm list-models <provider-name>` — live-discover models:
      //   - "github-copilot" uses the local Copilot credential
      //   - any other name must already exist in config.json (uses its
      //     baseUrl + apiKey for OpenAI-compatible /models discovery)
      const providerName = (args[1] && !args[1].startsWith('--')) ? args[1] : null;
      const config = readLocalLlmConfig(configPath);
      await handleListModels(config, { providerName });
      return;
    }

    const current = readLocalLlmConfig(configPath);
    let result;
    if (subcommand === 'setup') {
      await runLlmSetup(current, configPath);
      return;
    }

    if (subcommand === 'use') {
      const preset = args[1];
      if (preset === 'github-copilot') {
        result = await useGitHubCopilot(current, options);
        writeLocalLlmConfig(result.config, configPath);
        console.log(`Configured GitHub Copilot provider with ${result.discovery.models.length} ${result.discovery.source} models.`);
        if (result.discovery.warning) console.log(`Warning: ${result.discovery.warning}`);
        console.log(`Primary model: ${result.config.primaryModel}`);
        if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
        return;
      }
      if (preset === 'openai-compatible') {
        result = await useOpenAICompatible(current, options, process.env);
        writeLocalLlmConfig(result.config, configPath);
        console.log(`Configured ${result.provider.name} with ${result.discovery.models.length} live models.`);
        console.log(`Primary model: ${result.config.primaryModel}`);
        if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
        return;
      }
      throw new Error(`Unsupported llm use preset: ${preset || '(missing)'}`);
    }

    if (subcommand === 'add-provider') {
      result = addOrUpdateProvider(current, options, process.env);
      writeLocalLlmConfig(result.config, configPath);
      console.log(`${result.replaced ? 'Updated' : 'Added'} provider: ${result.provider.name}`);
      if (result.config.primaryModel) console.log(`Primary model: ${result.config.primaryModel}`);
      if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
      return;
    }

    if (subcommand === 'set-model') {
      result = setLocalModels(current, options);
      writeLocalLlmConfig(result.config, configPath);
      if (result.config.primaryModel) console.log(`Primary model: ${result.config.primaryModel}`);
      if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
      return;
    }

    if (subcommand === 'remove-provider') {
      result = removeProvider(current, options);
      writeLocalLlmConfig(result.config, configPath);
      console.log(result.removed ? `Removed provider: ${options.name}` : `Provider not found: ${options.name}`);
      if (result.cleared.length) {
        console.log(`Cleared ${result.cleared.join(', ')} because it referenced ${options.name}`);
      }
      return;
    }

    throw new Error(`Unknown llm command: ${subcommand}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('Run `yeaft-agent llm --help` for usage.');
    process.exit(1);
  }
}

/**
 * `yeaft-agent llm list-models [<provider-name>]` handler.
 *
 * Three modes:
 *  - No provider — list all models declared in the local config (offline,
 *    no network call). Annotates `← primary` / `← fast` for clarity.
 *  - "github-copilot" — live-discover Copilot's model catalog using the
 *    local device credential. Missing/invalid credential prints an
 *    actionable hint ("Run `gh auth login` ...") and exits non-zero so
 *    scripts can detect the failure.
 *  - Any other name — must already exist in config.json; uses its
 *    baseUrl + apiKey for OpenAI-compatible `/models` discovery.
 */
export async function handleListModels(
  config,
  { providerName = null, deps = {} } = {}
) {
  const discoverCopilot = deps.discoverCopilot || discoverGitHubCopilotModels;
  const discoverOpenAI = deps.discoverOpenAI || discoverOpenAICompatibleModels;

  if (providerName === GITHUB_COPILOT_PROVIDER.name) {
    try {
      const result = await discoverCopilot();
      console.log(`Available models from GitHub Copilot (source: ${result.source}):`);
      for (const id of result.models) console.log(`  ${id}`);
      if (result.warning) console.log(`\nNote: ${result.warning}`);
      return;
    } catch (err) {
      console.error(`GitHub Copilot model discovery failed: ${err.message}`);
      if (err.code === 'COPILOT_CREDENTIAL_MISSING' || err.code === 'COPILOT_AUTH_INVALID') {
        console.error('Tip: run `gh auth login` (or complete the Copilot device login) and re-run this command.');
      }
      process.exitCode = 1;
      return;
    }
  }

  if (providerName) {
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const target = providers.find(p => p && p.name === providerName);
    if (!target) {
      console.error(`Provider "${providerName}" not found in config.json.`);
      if (providers.length === 0) {
        console.error('No providers are configured. Run `yeaft-agent llm setup` or `yeaft-agent llm use github-copilot ...`.');
      } else {
        console.error('Configured providers:');
        for (const p of providers) console.error(`  ${p.name}`);
      }
      process.exitCode = 1;
      return;
    }
    try {
      const result = await discoverOpenAI({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
      });
      console.log(`Available models from "${providerName}" (${target.baseUrl}, source: ${result.source}):`);
      for (const id of result.models) console.log(`  ${providerName}/${id}`);
      return;
    } catch (err) {
      console.error(`Model discovery for "${providerName}" failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // Default: list configured providers' declared models (no network call).
  const providers = Array.isArray(config.providers) ? config.providers : [];
  if (providers.length === 0) {
    console.log('No providers configured in config.json.');
    console.log('Run `yeaft-agent llm setup`, or `yeaft-agent llm list-models github-copilot` to discover the Copilot catalog.');
    return;
  }
  console.log('Configured models:');
  for (const provider of providers) {
    const tag = provider.managed || provider.credentialProvider ? ' (managed)' : '';
    console.log(`  [${provider.name}]${tag} ${provider.baseUrl || ''}`.trimEnd());
    if (!Array.isArray(provider.models)) continue;
    for (const m of provider.models) {
      const id = typeof m === 'string' ? m : m?.id;
      if (!id) continue;
      const ref = `${provider.name}/${id}`;
      const annot = ref === config.primaryModel ? ' ← primary'
        : ref === config.fastModel ? ' ← fast'
        : '';
      console.log(`    ${ref}${annot}`);
    }
  }
}

async function runLlmSetup(current, configPath) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive setup requires a TTY. Use `yeaft-agent llm use github-copilot --model <modelId>` in scripts.');
  }

  const rl = createInterface({ input, output });
  try {
    console.log('Yeaft LLM setup');
    console.log('1) GitHub Copilot (uses local device token / gh auth, no API key in config)');
    console.log('2) Advanced manual provider (use add-provider command)');
    const choice = (await rl.question('Choose provider [1]: ')).trim() || '1';
    if (choice !== '1') {
      console.log('Use `yeaft-agent llm add-provider --help` for advanced endpoints.');
      return;
    }

    const discovery = await useGitHubCopilot(current, { model: '__placeholder__', allowUnknownModel: true });
    const ids = discovery.discovery.models;
    console.log('\nAvailable GitHub Copilot models:');
    ids.forEach((id, idx) => console.log(`  ${idx + 1}) ${id}`));
    const answer = (await rl.question('Primary model number or id: ')).trim();
    const primary = ids[Number(answer) - 1] || answer;
    if (!primary) throw new Error('A primary model is required.');
    const fastAnswer = (await rl.question('Fast model number or id (optional): ')).trim();
    const fast = fastAnswer ? (ids[Number(fastAnswer) - 1] || fastAnswer) : null;
    const result = await useGitHubCopilot(current, { model: primary, fast, allowUnknownModel: false });
    writeLocalLlmConfig(result.config, configPath);
    console.log(`Configured GitHub Copilot with ${result.discovery.models.length} ${result.discovery.source} models.`);
    if (result.discovery.warning) console.log(`Warning: ${result.discovery.warning}`);
    console.log(`Primary model: ${result.config.primaryModel}`);
    if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
  } finally {
    rl.close();
  }
}

function parseLlmArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reveal' || arg === '--allow-unknown-model') {
      const key = arg === '--reveal' ? 'reveal' : 'allowUnknownModel';
      options[key] = true;
      continue;
    }
    const key = arg.startsWith('--') ? arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
    if (!key) throw new Error(`Unexpected argument: ${arg}`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[key] = value;
    i += 1;
  }
  return options;
}

async function handleServiceCommand(command, args) {
  const service = await import('./service.js');
  switch (command) {
    case 'install':   service.install(args); break;
    case 'uninstall': service.uninstall(args); break;
    case 'start':     service.start(args); break;
    case 'stop':      service.stop(args); break;
    case 'restart':   service.restart(args); break;
    case 'status':    service.status(args); break;
    case 'logs':      service.logs(args); break;
  }
}

async function handleDoctorCommand() {
  const { doctor } = await import('./service.js');
  doctor();
}

function parseAndStart(args) {
  // Parse CLI flags → set environment variables (env vars take precedence over flags)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--instance':
        if (next) { process.env.YEAFT_AGENT_INSTANCE = process.env.YEAFT_AGENT_INSTANCE || next; i++; }
        break;
      case '--server':
        if (next) { process.env.SERVER_URL = process.env.SERVER_URL || next; i++; }
        break;
      case '--name':
        if (next) { process.env.AGENT_NAME = process.env.AGENT_NAME || next; i++; }
        break;
      case '--secret':
        if (next) { process.env.AGENT_SECRET = process.env.AGENT_SECRET || next; i++; }
        break;
      case '--work-dir':
        if (next) { process.env.WORK_DIR = process.env.WORK_DIR || next; i++; }
        break;
      case '--yeaft-dir':
        if (next) { process.env.YEAFT_DIR = process.env.YEAFT_DIR || next; i++; }
        break;
      case '--auto-upgrade':
        checkForUpdates();
        break;
      default:
        if (arg.startsWith('-')) {
          console.warn(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  // Import and start the agent
  import('./index.js');
}

async function checkForUpdates() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (latest && latest !== pkg.version) {
      console.log(`\n  Update available: ${pkg.version} → ${latest}`);
      console.log(`  Run "yeaft-agent upgrade" to update\n`);
    }
  } catch {
    // Silently ignore — network may be unavailable
  }
}

function upgrade() {
  console.log(`Current version: ${pkg.version}`);
  console.log('Checking for updates...');

  try {
    const latest = execSync(`npm view ${pkg.name} version`, { encoding: 'utf-8' }).trim();
    if (latest === pkg.version) {
      console.log('Already up to date.');
      return;
    }
    console.log(`Upgrading to ${latest}...`);

    if (platform() === 'win32') {
      // On Windows, the current process locks its own files. npm cannot overwrite
      // them while this process is running. Spawn a detached bat script that waits
      // for us to exit, then runs npm install, then optionally restarts the service.
      upgradeWindows(latest);
    } else {
      execSync(`npm install -g ${pkg.name}@latest`, { stdio: 'inherit' });
      console.log(`Successfully upgraded to ${latest}`);

      // If PM2 is managing yeaft-agent, restart it so the new version takes effect
      try {
        const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const apps = JSON.parse(pm2List);
        if (Array.isArray(apps) && apps.some(app => app.name === 'yeaft-agent')) {
          console.log('Restarting yeaft-agent via PM2...');
          execSync('pm2 restart yeaft-agent', { stdio: 'inherit' });
          console.log('PM2 service restarted.');
        }
      } catch {
        // PM2 not installed or not managing yeaft-agent — nothing to do
      }
    }
  } catch (e) {
    console.error('Upgrade failed:', e.message);
    process.exit(1);
  }
}

function upgradeWindows(latestVersion) {
  const configDir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'yeaft-agent');
  mkdirSync(configDir, { recursive: true });
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const batPath = join(configDir, 'upgrade-cli.bat');
  const vbsPath = join(configDir, 'upgrade-cli.vbs');
  const logPath = join(logDir, 'upgrade.log');
  const pid = process.pid;
  const pkgSpec = `${pkg.name}@${latestVersion}`;

  // --- PM2 handling: delete app before exit to prevent auto-restart ---
  let isPm2 = false;
  const ecoPath = join(configDir, 'ecosystem.config.cjs');
  try {
    const pm2List = execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const apps = JSON.parse(pm2List);
    isPm2 = Array.isArray(apps) && apps.some(app => app.name === 'yeaft-agent');
    if (isPm2) {
      execSync('pm2 delete yeaft-agent', { stdio: 'pipe' });
      console.log('PM2 app deleted to prevent auto-restart during upgrade.');
    }
  } catch {
    // PM2 not installed or not managing yeaft-agent — continue
  }

  const batLines = [
    '@echo off',
    'setlocal',
    `set PID=${pid}`,
    `set PKG=${pkgSpec}`,
    `set LOGFILE=${logPath}`,
    `set MAX_WAIT=30`,
    `set COUNT=0`,
    '',
    ':: Change to temp dir to avoid EBUSY on cwd',
    'cd /d "%TEMP%"',
    '',
    'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
    `echo [Upgrade] Version: ${pkg.version} -> ${latestVersion} >> "%LOGFILE%"`,
    `echo [Upgrade] PM2 managed: ${isPm2 ? 'yes (deleted pre-exit)' : 'no'} >> "%LOGFILE%"`,
    'echo [Upgrade] Waiting for CLI process (PID %PID%) to exit... >> "%LOGFILE%"',
    '',
    ':WAIT_LOOP',
    'tasklist /FI "PID eq %PID%" /NH 2>NUL | findstr /C:"%PID%" >NUL',
    'if errorlevel 1 goto PID_EXITED',
    'set /A COUNT+=1',
    'if %COUNT% GEQ %MAX_WAIT% (',
    '  echo [Upgrade] Timeout waiting for PID %PID% to exit after %MAX_WAIT%s >> "%LOGFILE%"',
    '  goto PID_EXITED',
    ')',
    'ping -n 3 127.0.0.1 >NUL',
    'goto WAIT_LOOP',
    ':PID_EXITED',
    '',
    ':: Extra wait for file locks to release',
    'echo [Upgrade] Process exited at %time%, waiting for file locks... >> "%LOGFILE%"',
    'ping -n 5 127.0.0.1 >NUL',
    '',
    'echo [Upgrade] Running npm install -g %PKG%... >> "%LOGFILE%"',
    'call npm install -g %PKG% >> "%LOGFILE%" 2>&1',
    'if not "%errorlevel%"=="0" (',
    '  echo [Upgrade] npm install failed with exit code %errorlevel% at %time% >> "%LOGFILE%"',
    '  goto PM2_RESTART',
    ')',
    'echo [Upgrade] npm install succeeded at %time% >> "%LOGFILE%"',
  ];

  // PM2 re-registration after successful upgrade
  batLines.push(
    '',
    ':PM2_RESTART',
  );
  if (isPm2) {
    batLines.push(
      'echo [Upgrade] Re-registering agent via PM2... >> "%LOGFILE%"',
      `if exist "${ecoPath}" (`,
      `  call pm2 start "${ecoPath}" >> "%LOGFILE%" 2>&1`,
      '  call pm2 save >> "%LOGFILE%" 2>&1',
      '  echo [Upgrade] PM2 app re-registered at %time% >> "%LOGFILE%"',
      ') else (',
      '  echo [Upgrade] WARNING: ecosystem.config.cjs not found, PM2 not restarted >> "%LOGFILE%"',
      ')',
    );
  }

  batLines.push(
    '',
    'echo [Upgrade] Finished at %time% >> "%LOGFILE%"',
    ':CLEANUP',
    `del /F /Q "${vbsPath}" 2>NUL`,
    `del /F /Q "${batPath}" 2>NUL`,
  );

  writeFileSync(batPath, batLines.join('\r\n'));

  // Use VBScript wrapper to fully detach the bat process from the parent.
  // WshShell.Run with 0 (hidden window) and False (don't wait) ensures the bat
  // runs completely independently — survives parent exit, no console window flash.
  const vbsLines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${batPath}""", 0, False`,
  ];
  writeFileSync(vbsPath, vbsLines.join('\r\n'));

  spawn('wscript.exe', [vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();

  console.log(`Upgrade script spawned via VBScript wrapper.`);
  console.log(`This process will exit now. The upgrade will proceed after exit.`);
  console.log(`Check upgrade log: ${logPath}`);
  process.exit(0);
}
