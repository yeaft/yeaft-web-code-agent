import {
  formatRepoWorkflowError,
  landRepoWorkflow,
  prepareRepoReview,
  prepareRepoWorkflow,
} from './repo-workflow.js';

const COMMANDS = new Set(['prepare', 'review-prep', 'land']);

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

  const options = { worktreePaths: [] };
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
      case '--reviewed-head': options.reviewedHead = value; break;
      case '--reviewed-snapshot': options.reviewedSnapshot = value; break;
      case '--approved-by': options.approvedBy = value; break;
      case '--merge-method': options.mergeMethod = value; break;
      case '--tag-prefix': options.tagPrefix = value; break;
      case '--tag-start': options.tagStart = parseInteger(value, arg); break;
      case '--workflow': options.workflow = value; break;
      case '--wait-timeout-ms': options.waitTimeoutMs = parseInteger(value, arg); break;
      case '--poll-interval-ms': options.pollIntervalMs = parseInteger(value, arg); break;
      case '--cleanup-worktree': options.worktreePaths.push(value); break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.worktreePaths.length === 0) delete options.worktreePaths;
  return { help: false, command, options };
}

export function repoWorkflowHelp(command = null) {
  const common = `Common options:\n  --cwd <path>          Repository or worktree path (default: current directory)\n  --remote <name>       Git remote (default: origin)`;
  if (command === 'prepare') {
    return `Usage: yeaft-repo prepare --name <name> [options]\n\nFetch the default branch and create or reuse an exact-base development worktree.\n\nOptions:\n  --name <name>         Worktree and yeaft-wt/<name> branch name\n  --base <branch>       Base branch (default: repository default)\n  --worktree <path>     Worktree path\n${common}`;
  }
  if (command === 'review-prep') {
    return `Usage: yeaft-repo review-prep --pr <number> [options]\n\nFreeze GitHub PR head/base/merge refs and create a clean detached review worktree.\n\nOptions:\n  --pr <number>         Pull request number\n  --name <name>         Review worktree name\n  --worktree <path>     Review worktree path\n${common}`;
  }
  if (command === 'land') {
    return `Usage: yeaft-repo land --pr <number> --reviewed-head <sha> --reviewed-snapshot <sha> --approved-by <name> [options]\n\nRe-freeze the reviewed PR, merge with head matching, optionally tag and wait for a workflow.\n\nOptions:\n  --pr <number>                 Pull request number\n  --reviewed-head <sha>         Exact approved PR head SHA\n  --reviewed-snapshot <sha>     Exact approved GitHub merge snapshot SHA\n  --approved-by <name>          Reviewer identity; approval is never inferred\n  --merge-method <method>       merge, squash, or rebase (default: merge)\n  --tag-prefix <prefix>         Create the next numeric remote tag, e.g. v1.0.\n  --tag-start <number>          First numeric suffix when no tag exists (default: 0)\n  --workflow <name>             Wait for this GitHub Actions workflow\n  --wait-timeout-ms <ms>        Workflow wait timeout (default: 1800000)\n  --poll-interval-ms <ms>       Workflow polling interval (default: 15000)\n  --cleanup-worktree <path>     Remove a clean worktree; repeat as needed\n${common}`;
  }
  return `yeaft-repo — deterministic GitHub repository workflow\n\nUsage:\n  yeaft-repo prepare --name <name> [options]\n  yeaft-repo review-prep --pr <number> [options]\n  yeaft-repo land --pr <number> --reviewed-head <sha> --reviewed-snapshot <sha> --approved-by <name> [options]\n\nEach command emits one JSON result. GitHub repositories require authenticated git and gh CLIs.\nRun yeaft-repo <command> --help for command options.`;
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
    let result;
    if (parsed.command === 'prepare') {
      result = await prepareRepoWorkflow(parsed.options, dependencies);
    } else if (parsed.command === 'review-prep') {
      result = await prepareRepoReview(parsed.options, dependencies);
    } else {
      result = await landRepoWorkflow(parsed.options, dependencies);
    }
    writeOut(JSON.stringify(result));
    return 0;
  } catch (error) {
    const result = formatRepoWorkflowError(error);
    writeErr(JSON.stringify(result));
    return 1;
  }
}
