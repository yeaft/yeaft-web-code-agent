import { defineTool } from './types.js';
import {
  formatRepoWorkflowError,
  landRepoWorkflow,
  prepareRepoReview,
  prepareRepoWorkflow,
} from '../../repo-workflow.js';

const repoWorkflow = defineTool({
  name: 'RepoWorkflow',
  description: {
    en: `Run one deterministic GitHub repository workflow phase and return compact structured evidence.

Use this instead of repeatedly issuing git/gh shell commands:
- prepare: fetch the remote default branch and create/reuse an exact-base development worktree.
- review-prep: freeze a PR's exact base/head/GitHub merge snapshot and create/reuse a clean detached review worktree.
- land: re-freeze an independently approved exact head/snapshot, merge with head matching, optionally create the next numeric tag, wait for a workflow, and remove only clean requested worktrees.

This tool does not review code and never infers approval. The land phase requires the reviewer identity and exact SHAs returned by review-prep. Supports any local GitHub repository available to the Agent; git and authenticated gh CLIs are required.`,
    zh: `执行一个确定性的 GitHub 仓库工作流阶段，并返回紧凑的结构化证据。

应使用此工具代替反复执行 git/gh shell 命令：
- prepare：拉取远端默认分支，并创建或复用精确基线的开发 worktree。
- review-prep：冻结 PR 的精确 base/head/GitHub merge snapshot，并创建或复用干净的 detached review worktree。
- land：重新冻结已经独立批准的 exact head/snapshot，使用 head-match 合并，可选创建下一个数字 tag、等待 workflow，并且只删除指定的干净 worktree。

此工具不做代码审查，也不会推断 review 已通过。land 必须提供 reviewer 身份以及 review-prep 返回的精确 SHA。适用于 Agent 可访问的任意本地 GitHub 仓库；需要 git 和已认证的 gh CLI。`,
  },
  parameters: {
    type: 'object',
    properties: {
      phase: { type: 'string', enum: ['prepare', 'review-prep', 'land'] },
      cwd: { type: 'string', description: 'Repository or worktree path; defaults to the current engine cwd' },
      remote: { type: 'string', description: 'Git remote name (default: origin)' },
      baseBranch: { type: 'string', description: 'Explicit base branch for prepare' },
      name: { type: 'string', description: 'Development or review worktree name' },
      worktreePath: { type: 'string', description: 'Explicit worktree path' },
      pr: { type: 'integer', description: 'GitHub pull request number' },
      reviewedHead: { type: 'string', description: 'Exact independently approved PR head SHA' },
      reviewedSnapshot: { type: 'string', description: 'Exact independently approved GitHub merge snapshot SHA' },
      approvedBy: { type: 'string', description: 'Reviewer identity; required for land and never inferred' },
      mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      tagPrefix: { type: 'string', description: 'Optional numeric tag prefix, for example v1.0.' },
      tagStart: { type: 'integer', minimum: 0 },
      workflow: { type: 'string', description: 'Optional GitHub Actions workflow name to wait for' },
      waitTimeoutMs: { type: 'integer', minimum: 1 },
      pollIntervalMs: { type: 'integer', minimum: 1 },
      worktreePaths: { type: 'array', items: { type: 'string' }, description: 'Clean worktrees to remove after successful land' },
    },
    required: ['phase'],
  },
  timeoutMs: 0,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: input => input?.phase === 'land',
  async execute(input, ctx) {
    const options = { ...input, cwd: input.cwd || ctx?.cwd || process.cwd() };
    try {
      const dependencies = { signal: ctx?.signal };
      const result = input.phase === 'prepare'
        ? await prepareRepoWorkflow(options, dependencies)
        : input.phase === 'review-prep'
          ? await prepareRepoReview(options, dependencies)
          : await landRepoWorkflow(options, dependencies);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify(formatRepoWorkflowError(error));
    }
  },
});

export default repoWorkflow;
