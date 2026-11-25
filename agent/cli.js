#!/usr/bin/env node
/**
 * CLI entry point for @yeaft/webchat-agent
 * Parses command-line arguments and starts the agent or runs subcommands
 */
import { assertNodeVersion } from './check-node-version.js';
assertNodeVersion({ component: '@yeaft/webchat-agent' });

import { execFileSync, execSync, spawn } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import {
  addOrUpdateProvider,
  formatLlmConfig,
  getDefaultYeaftConfigPath,
  readLocalLlmConfig,
  removeProvider,
  setLocalModels,
  useGitHubCopilot,
  useOpenAICompatible,
  useGemini,
  writeLocalLlmConfig,
} from './llm-config-cli.js';
import {
  discoverGitHubCopilotModels,
  discoverOpenAICompatibleModels,
  discoverGeminiModels,
  GEMINI_BASE_URL,
  GITHUB_COPILOT_PROVIDER,
} from './llm-model-discovery.js';
import {
  DEFAULT_INSTANCE_ID,
  applyAgentIdentityToEnv,
  getConfigDir,
  getPm2AppName,
  resolveServiceInstanceId,
  warnDeprecatedInstanceArg,
} from './service/config.js';
import {
  buildContainerImageUpgradeMessage,
  buildUpgradeInstallCommand,
  buildUpgradeMetadataUrl,
  buildUpgradeVersionCommand,
  CONTAINER_IMAGE_UPGRADE_REASON,
  isContainerAgentRuntime,
  createWindowsUpgradeRun,
  launchWindowsUpgradeScript,
  prepareWindowsUpgradeRunner,
  releaseWindowsUpgradeLock,
  resolveWindowsNpmCliPath,
  resolveWindowsPm2CliPath,
} from './upgrade-command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

// Service management subcommands
const SERVICE_COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];

if (command === 'doctor') {
  await handleDoctorCommand(subArgs);
} else if (command === 'browser') {
  try {
    const { handleBrowserCommand } = await import('./browser-runtime/cli.js');
    await handleBrowserCommand(subArgs);
  } catch (error) {
    console.error(`Browser Runtime command failed: ${error.code || error.message}`);
    process.exitCode = 1;
  }
} else if (command === 'llm') {
  await handleLlmCommand(subArgs);
} else if (command === 'local') {
  await handleLocalCommand(subArgs);
} else if (command === 'container') {
  let formatContainerError = error => error.code || error.message;
  try {
    const containerCli = await import('./container-cli.js');
    formatContainerError = containerCli.formatContainerError;
    await containerCli.runContainerCli(subArgs);
  } catch (error) {
    console.error(`Container Agent failed: ${formatContainerError(error)}`);
    process.exit(1);
  }
} else if (command === 'upgrade') {
  await upgrade(subArgs);
} else if (command === '--version' || command === '-v') {
  console.log(pkg.version);
} else if (command === '--help' || command === '-h') {
  printHelp();
} else if (SERVICE_COMMANDS.includes(command)) {
  await handleServiceCommand(command, subArgs);
} else {
  // Normal agent startup — parse flags and set env vars
  parseAndStart(args);
}

/** Dispatch the local foreground and managed-service command family. */
export async function handleLocalCommand(subArgs, options = {}) {
  const printHelpFn = options.printHelp || printHelp;
  const warn = options.warn || console.warn;
  const loadLocalService = options.loadLocalService || (() => import('./local-service.js'));
  const loadLocalRun = options.loadLocalRun || (() => import('./local-run.js'));
  try {
    const localCommand = subArgs[0];
    if (localCommand === '--help' || localCommand === '-h') {
      printHelpFn();
      return;
    }
    warnDeprecatedInstanceArg(subArgs, warn);
    if (SERVICE_COMMANDS.includes(localCommand)) {
      const { handleLocalServiceCommand } = await loadLocalService();
      await handleLocalServiceCommand(localCommand, subArgs.slice(1));
      return;
    }
    const { runLocal } = await loadLocalRun();
    await runLocal(subArgs);
  } catch (error) {
    const message = `Local run failed: ${error.message}`;
    if (options.onError) {
      options.onError(message, error);
      return;
    }
    console.error(message);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
  ${pkg.name} v${pkg.version}

  Usage:
    yeaft-agent [options]              Run agent in foreground
    yeaft-agent local [options]        Run local Web UI, server, and agent
    yeaft-agent local --background      Run local mode in the background
    yeaft-agent local install [options] Install local mode as a managed service
    yeaft-agent local uninstall [options] Remove the local managed service
    yeaft-agent local start|stop|restart|status|logs [options]
                                      Control the local managed service
    yeaft-agent install [options]      Install as system service
    yeaft-agent uninstall [options]    Remove system service
    yeaft-agent start [options]        Start installed service
    yeaft-agent stop [options]         Stop installed service
    yeaft-agent restart [options]      Restart installed service
    yeaft-agent status [options]       Show service status
    yeaft-agent logs [options]         View service logs (follow mode)
    yeaft-agent doctor                 Diagnose service configuration
    yeaft-agent browser install        Install the pinned Chrome for Testing build
    yeaft-agent browser probe          Validate tabCapture → offscreen → WebRTC
    yeaft-agent browser enable|disable Change the Browser Runtime feature flag
    yeaft-agent browser status         Show config and managed browser install status
    yeaft-agent llm <command>          Configure local Yeaft LLM providers/models
    yeaft-agent container <command>    Manage a Dockerized yeaft-agent
    yeaft-agent upgrade [--name <id>]  Upgrade and restart the selected service
    yeaft-agent --version              Show version

  Options:
    --instance <id>     Deprecated alias for the local service instance id
    --server <url>      WebSocket server URL (default: ws://localhost:3456)
    --name <name>       Agent name and instance id (default: computer name; invalid chars become -)
    --port <port>       Local server port (local command only; default: 6868)
    --background, -d    Detach local mode after spawning it (local command only)
    --secret <secret>   Agent secret for authentication
    --work-dir <dir>    Default working directory (default: cwd)
    --yeaft-dir <dir>   Yeaft data directory for this instance
    --auto-upgrade      Check for updates on startup

  Browser options:
    --executable <path> Explicit compatible Chrome for Testing executable
    --headful           Run the Browser Runtime probe with a visible browser
    --name <id>         Select the named Agent instance

  Environment variables (alternative to flags):
    YEAFT_AGENT_INSTANCE Deprecated local service instance id override
    SERVER_URL          WebSocket server URL
    AGENT_NAME          Agent name and instance id override
    AGENT_SECRET        Agent secret
    WORK_DIR            Working directory
    YEAFT_DIR           Yeaft data directory

  Examples:
    yeaft-agent local
    yeaft-agent local --name my-worker --port 7000
    yeaft-agent local --name my-worker --background
    yeaft-agent local install --name my-worker --port 7000
    yeaft-agent --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent install --server wss://your-server.com --name my-worker --secret xxx
    yeaft-agent install --server wss://your-server.com --name my-worker-2 --secret xxx
    yeaft-agent status --name my-worker-2
    yeaft-agent logs --name my-worker-2
`);
}

export function printLlmHelp() {
  console.log(`
  Configure local Yeaft LLM providers/models in ~/.yeaft/config.json.

  Usage:
    yeaft-agent llm show [--reveal]
    yeaft-agent llm list-models [<provider-name>]
    yeaft-agent llm setup
    yeaft-agent llm use github-copilot --model <modelId> [--fast <modelId>] [--allow-unknown-model]
    yeaft-agent llm use gemini --api-key-env GEMINI_API_KEY --model gemini-4-hydrogen [--fast gemini-4-carbon]
    yeaft-agent llm use openai-compatible --name <name> --base-url <url> --api-key-env <ENV> --model <modelId> [--fast <modelId>]
    yeaft-agent llm add-provider --name <name> --base-url <url> --models <m1,m2> \
      [--api-key <key>|--api-key-env <ENV>|--credential-provider github-copilot] \
      [--protocol anthropic|openai-responses|openai-chat-completions|gemini] [--set-primary <model>] [--set-fast <model>] [--set-decision <model>]
    yeaft-agent llm set-model [--primary <provider/model>] [--fast <provider/model>] [--decision <provider/model>]
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
        writeLocalLlmConfig(result.config, configPath, current);
        console.log(`Configured GitHub Copilot provider with ${result.discovery.models.length} ${result.discovery.source} models.`);
        if (result.discovery.warning) console.log(`Warning: ${result.discovery.warning}`);
        console.log(`Primary model: ${result.config.primaryModel}`);
        if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
        return;
      }
      if (preset === 'openai-compatible' || preset === 'gemini') {
        result = await (preset === 'gemini' ? useGemini : useOpenAICompatible)(current, options, process.env);
        writeLocalLlmConfig(result.config, configPath, current);
        console.log(`Configured ${result.provider.name} with ${result.discovery.models.length} live models.`);
        console.log(`Primary model: ${result.config.primaryModel}`);
        if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
        return;
      }
      throw new Error(`Unsupported llm use preset: ${preset || '(missing)'}`);
    }

    if (subcommand === 'add-provider') {
      result = addOrUpdateProvider(current, options, process.env);
      writeLocalLlmConfig(result.config, configPath, current);
      console.log(`${result.replaced ? 'Updated' : 'Added'} provider: ${result.provider.name}`);
      if (result.config.primaryModel) console.log(`Primary model: ${result.config.primaryModel}`);
      if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
      if (result.config.decisionModel) console.log(`Decision model: ${result.config.decisionModel}`);
      return;
    }

    if (subcommand === 'set-model') {
      result = setLocalModels(current, options);
      writeLocalLlmConfig(result.config, configPath, current);
      if (result.config.primaryModel) console.log(`Primary model: ${result.config.primaryModel}`);
      if (result.config.fastModel) console.log(`Fast model: ${result.config.fastModel}`);
      if (result.config.decisionModel) console.log(`Decision model: ${result.config.decisionModel}`);
      return;
    }

    if (subcommand === 'remove-provider') {
      result = removeProvider(current, options);
      writeLocalLlmConfig(result.config, configPath, current);
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
 *    baseUrl + apiKey for Gemini or OpenAI-compatible `/models` discovery.
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
      const gemini = target.protocol === 'gemini';
      const discover = gemini ? deps.discoverGemini || discoverGeminiModels : discoverOpenAI;
      const baseUrl = gemini ? target.baseUrl || GEMINI_BASE_URL : target.baseUrl;
      const result = await discover({ baseUrl, apiKey: target.apiKey });
      console.log(`Available models from "${providerName}" (${baseUrl}, source: ${result.source}):`);
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
      const tags = [];
      if (ref === config.primaryModel) tags.push('primary');
      if (ref === config.fastModel) tags.push('fast');
      if (ref === config.decisionModel) tags.push('decision');
      const annot = tags.length ? ` ← ${tags.join(', ')}` : '';
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
    console.log('2) Google Gemini (native API, uses GEMINI_API_KEY)');
    console.log('3) Advanced manual provider (use add-provider command)');
    const choice = (await rl.question('Choose provider [1]: ')).trim() || '1';
    if (choice === '2') {
      const model = (await rl.question('Primary model id [gemini-4-hydrogen]: ')).trim() || 'gemini-4-hydrogen';
      const result = await useGemini(current, { model, apiKeyEnv: 'GEMINI_API_KEY' });
      writeLocalLlmConfig(result.config, configPath, current);
      console.log(`Configured Google Gemini: ${result.config.primaryModel}`);
      return;
    }
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
    writeLocalLlmConfig(result.config, configPath, current);
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
  warnDeprecatedInstanceArg(args);
  const service = await import('./service.js');
  switch (command) {
    case 'install':   await service.install(args); break;
    case 'uninstall': await service.uninstall(args); break;
    case 'start':     await service.start(args); break;
    case 'stop':      await service.stop(args); break;
    case 'restart':   await service.restart(args); break;
    case 'status':    await service.status(args); break;
    case 'logs':      await service.logs(args); break;
  }
}

async function handleDoctorCommand(args) {
  warnDeprecatedInstanceArg(args);
  const { doctor } = await import('./service.js');
  doctor(args);
}

function parseAndStart(args) {
  try {
    warnDeprecatedInstanceArg(args);
    applyAgentIdentityToEnv(args);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
    return;
  }

  // Parse non-identity flags. Saved environment remains the fallback for these options.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--instance':
        if (next) i++;
        break;
      case '--server':
        if (next) { process.env.SERVER_URL = process.env.SERVER_URL || next; i++; }
        break;
      case '--name':
        if (next) i++;
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
      case '--session-turn-deletion-cutover':
        // Obsolete no-op: existing launch commands can keep this argument.
        if (next && !next.startsWith('--')) i++;
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
  if (isContainerAgentRuntime()) return;
  try {
    const res = await fetch(buildUpgradeMetadataUrl(pkg.name));
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

async function upgrade(args = []) {
  warnDeprecatedInstanceArg(args);
  const instanceId = resolveServiceInstanceId(args, process.env, { management: true });
  if (isContainerAgentRuntime()) {
    console.error(`${CONTAINER_IMAGE_UPGRADE_REASON}: ${buildContainerImageUpgradeMessage(pkg.version)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Current version: ${pkg.version}`);
  console.log('Checking for updates...');

  try {
    const latest = execSync(buildUpgradeVersionCommand(`${pkg.name}@latest`), { encoding: 'utf-8' }).trim();
    if (latest === pkg.version) {
      console.log('Already up to date.');
      return;
    }
    console.log(`Upgrading to ${latest}...`);

    if (platform() === 'win32') {
      // On Windows, the current process locks its own files. A short-lived
      // bootstrap detaches the updater before this process exits; the updater then
      // installs the exact version and restores the selected service instance.
      await upgradeWindows(latest, instanceId);
    } else {
      execSync(buildUpgradeInstallCommand(`${pkg.name}@${latest}`), { stdio: 'inherit' });
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

async function upgradeWindows(latestVersion, instanceId = DEFAULT_INSTANCE_ID) {
  const configDir = getConfigDir(instanceId);
  const upgradeDir = join(configDir, 'upgrade-runtime');
  const logDir = join(configDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const logPath = join(logDir, 'upgrade.log');
  const ecosystemPath = join(configDir, 'ecosystem.config.cjs');
  const pm2AppName = getPm2AppName(instanceId);
  const npmCliPath = resolveWindowsNpmCliPath(process.execPath);
  if (!npmCliPath) throw new Error('npm JavaScript CLI entry point could not be resolved');
  const pm2CliPath = resolveWindowsPm2CliPath(process.execPath);

  let isPm2 = false;
  if (pm2CliPath) {
    try {
      const apps = JSON.parse(execFileSync(process.execPath, [pm2CliPath, 'jlist'], { encoding: 'utf8' }));
      isPm2 = Array.isArray(apps) && apps.some(app => app.name === pm2AppName);
    } catch {}
  }

  const run = createWindowsUpgradeRun(upgradeDir);
  const {
    runId,
    lockPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    handoffPath,
    authorizePath,
    cancelPath,
  } = run;
  const payload = {
    runId,
    lockPath,
    parentPid: process.pid,
    packageSpec: `${pkg.name}@${latestVersion}`,
    globalInstall: true,
    installDir: dirname(dirname(__dirname)),
    logPath,
    handoffPath,
    authorizePath,
    cancelPath,
    bootstrapPath,
    runnerPath,
    commandPath,
    payloadPath,
    nodePath: process.execPath,
    npmCliPath,
    pm2CliPath: isPm2 ? pm2CliPath : null,
    pm2AppName: isPm2 ? pm2AppName : null,
    ecosystemPath: isPm2 ? ecosystemPath : null,
  };
  try {
    prepareWindowsUpgradeRunner({
      sourceBootstrapPath: join(__dirname, 'windows-upgrade-bootstrap.js'),
      sourceRunnerPath: join(__dirname, 'windows-upgrade-runner.js'),
      sourceCommandPath: join(__dirname, 'upgrade-command.js'),
      bootstrapPath,
      runnerPath,
      commandPath,
      payloadPath,
      payload,
    });
  } catch (err) {
    releaseWindowsUpgradeLock(lockPath, runId);
    throw err;
  }

  const launcher = await launchWindowsUpgradeScript({
    runId,
    nodePath: process.execPath,
    bootstrapPath,
    runnerPath,
    payloadPath,
    logPath,
    handoffPath,
    authorizePath,
    cancelPath,
    lockPath,
    spawnProcess: spawn,
  });
  console.log(`Upgrade runner spawned via ${launcher}.`);

  console.log('This process will exit now. The upgrade will proceed after exit.');
  console.log(`Check upgrade log: ${logPath}`);
  process.exit(0);
}
