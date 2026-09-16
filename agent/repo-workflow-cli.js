import {
  formatRepoWorkflowError,
  prepareRepoReview,
  prepareRepoWorkflow,
} from './repo-workflow.js';

const COMMANDS = new Set(['prepare', 'review-prep']);

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

export function parseRepoWorkflowArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') {
    return { help: true, command: null, options: {} };
  }
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true, command, options };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const value = requireValue(args, index, arg);
    index += 1;
    switch (arg) {
      case '--cwd': options.cwd = value; break;
      case '--remote': options.remote = value; break;
      case '--base': options.baseBranch = value; break;
      case '--name': options.name = value; break;
      case '--worktree': options.worktreePath = value; break;
      case '--pr': options.pr = parseInteger(value, arg); break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { help: false, command, options };
}

export function repoWorkflowHelp(command = null) {
  const common = `Common options:
  --cwd <path>          Repository or worktree path (default: current directory)
  --remote <name>       Git remote (default: origin)`;
  if (command === 'prepare') {
    return `Usage: yeaft-repo prepare --name <name> [options]

Fetch the default branch and create or reuse an exact-base development worktree.

Options:
  --name <name>         Worktree and yeaft-wt/<name> branch name
  --base <branch>       Base branch (default: repository default)
  --worktree <path>     Worktree path
${common}`;
  }
  if (command === 'review-prep') {
    return `Usage: yeaft-repo review-prep --pr <number> [options]

Freeze GitHub PR head/base/merge refs and create or reuse a clean detached review worktree.

Options:
  --pr <number>         Pull request number
  --name <name>         Review worktree name
  --worktree <path>     Review worktree path
${common}`;
  }
  return `yeaft-repo — deterministic GitHub worktree preparation

Usage:
  yeaft-repo prepare --name <name> [options]
  yeaft-repo review-prep --pr <number> [options]

Each command emits one JSON result. GitHub repositories require authenticated git and gh CLIs.
Run yeaft-repo <command> --help for command options.`;
}

export async function runRepoWorkflowCli(argv, dependencies = {}) {
  const writeOut = dependencies.writeOut || (text => process.stdout.write(`${text}\n`));
  const writeErr = dependencies.writeErr || (text => process.stderr.write(`${text}\n`));
  try {
    const parsed = parseRepoWorkflowArgs(argv);
    if (parsed.help) {
      writeOut(repoWorkflowHelp(parsed.command));
      return 0;
    }
    const result = parsed.command === 'prepare'
      ? await prepareRepoWorkflow(parsed.options, dependencies)
      : await prepareRepoReview(parsed.options, dependencies);
    writeOut(JSON.stringify(result));
    return 0;
  } catch (error) {
    writeErr(JSON.stringify(formatRepoWorkflowError(error)));
    return 1;
  }
}
